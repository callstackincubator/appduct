// NOTE: deliberately no `#if CORDIERITE_ENABLED` guard here -- that define is a build setting on
// the `CordieriteCore` target only (see Package.swift), never on this test target, so wrapping this
// file's contents in it would silently compile the whole file out. `swift test` always builds
// `CordieriteCore` itself in `.debug` (the real implementation), which is what these fakes stand in
// front of.

import Foundation
@testable import CordieriteCore

/// Scripted fake standing in for `CordieriteConnectionManager` in `CordieriteClient` tests, so the
/// reconnect/registry/tool-invocation state machine is testable without a real TLS/WebSocket stack.
final class FakeTransportSession: CordieriteTransportSession, @unchecked Sendable {
  var emitStateChange: (@Sendable (String) -> Void)?
  var emitMessageRaw: (@Sendable (String) -> Void)?
  var emitError: (@Sendable (CordieriteErrorDetails) -> Void)?
  var emitClose: (@Sendable (NSDictionary) -> Void)?

  private let lock = NSLock()
  private var _stateSnapshot = "idle"
  private var _sentMessages: [String] = []
  private var _connectCallCount = 0
  private var _lastConnectOptions: CordieriteConnectOptions?
  private var _closeCallCount = 0

  /// Set by a test to make the next `connect(options:)` throw instead of succeeding.
  var connectError: (@Sendable () -> Error)?

  /// `NSLock.lock()`/`unlock()` are unavailable from `async` contexts under strict concurrency;
  /// `withLock` is the scoped-locking replacement, usable from both sync and async call sites.
  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  var stateSnapshot: String {
    get { withLock { _stateSnapshot } }
    set { withLock { _stateSnapshot = newValue } }
  }

  var sentMessages: [String] {
    withLock { _sentMessages }
  }

  var connectCallCount: Int {
    withLock { _connectCallCount }
  }

  var lastConnectOptions: CordieriteConnectOptions? {
    withLock { _lastConnectOptions }
  }

  var closeCallCount: Int {
    withLock { _closeCallCount }
  }

  func connect(options: CordieriteConnectOptions) async throws {
    withLock {
      _connectCallCount += 1
      _lastConnectOptions = options
    }

    if let connectError {
      throw connectError()
    }
    stateSnapshot = "connecting"
  }

  func send(message: String) async throws {
    withLock { _sentMessages.append(message) }
  }

  func close() async {
    withLock { _closeCallCount += 1 }
    stateSnapshot = "closed"
  }

  func invalidate() async {
    stateSnapshot = "closed"
  }

  nonisolated func currentStateSnapshot() -> String { stateSnapshot }
  nonisolated func currentResumeLeaseRecord() -> NSDictionary? { nil }
  nonisolated func clearResumeLease() -> Bool { true }

  // MARK: Test-side simulation helpers

  func simulateIncoming(_ text: String) {
    emitMessageRaw?(text)
  }

  func simulateAck(
    sessionId: String,
    resumeToken: String = "resume-token",
    alias: String = "alias-1",
    keepaliveIntervalS: Double = 30,
    graceS: Double = 120
  ) {
    stateSnapshot = "active"
    let payload: [String: Any] = [
      "type": "session_ack",
      "session_id": sessionId,
      "status": "ok",
      "alias": alias,
      "resume_token": resumeToken,
      "keepalive_interval_s": keepaliveIntervalS,
      "grace_s": graceS,
    ]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    simulateIncoming(String(data: data, encoding: .utf8)!)
  }

  func simulateClose(code: Int?, reason: String?) {
    stateSnapshot = "closed"
    let dict = NSMutableDictionary()
    if let code { dict["code"] = code }
    if let reason { dict["reason"] = reason }
    emitClose?(dict)
  }
}

/// Deterministic virtual-clock timers for reconnect/backoff/grace tests. `advance(byMs:)` fires
/// every timer now due, synchronously, in due-time order -- mirrors the role of vitest's fake
/// timers in the original JS test suite (`client/timers.ts`'s `ClientTimers`).
final class FakeClientTimers: CordieriteClientTimers, @unchecked Sendable {
  private let lock = NSLock()
  private var currentTimeMs: Double
  private var randomValue: Double
  private var scheduled: [(id: UUID, dueAt: Double, handler: @Sendable () -> Void)] = []

  init(startMs: Double = 0, random: Double = 0) {
    currentTimeMs = startMs
    randomValue = random
  }

  func now() -> Double { lock.lock(); defer { lock.unlock() }; return currentTimeMs }
  func random() -> Double { lock.lock(); defer { lock.unlock() }; return randomValue }

  func setRandom(_ value: Double) {
    lock.lock(); randomValue = value; lock.unlock()
  }

  func setTimeout(afterMs: Double, _ handler: @escaping @Sendable () -> Void) -> any CordieriteTimerHandle {
    let id = UUID()
    lock.lock()
    scheduled.append((id, currentTimeMs + max(0, afterMs), handler))
    lock.unlock()
    return FakeTimerHandle(id: id)
  }

  func clearTimeout(_ handle: any CordieriteTimerHandle) {
    guard let handle = handle as? FakeTimerHandle else { return }
    lock.lock()
    scheduled.removeAll { $0.id == handle.id }
    lock.unlock()
  }

  var pendingCount: Int {
    lock.lock(); defer { lock.unlock() }; return scheduled.count
  }

  /// Advances the virtual clock by `deltaMs` and fires every timer now due. Handlers themselves
  /// typically just kick off a `Task` to hop back onto the actor -- call `Probe.drain()`
  /// afterwards to let that queued work actually run.
  func advance(byMs deltaMs: Double) {
    lock.lock()
    currentTimeMs += deltaMs
    let due = scheduled.filter { $0.dueAt <= currentTimeMs }.sorted { $0.dueAt < $1.dueAt }
    let dueIds = Set(due.map(\.id))
    scheduled.removeAll { dueIds.contains($0.id) }
    lock.unlock()
    for entry in due { entry.handler() }
  }

  struct FakeTimerHandle: CordieriteTimerHandle {
    let id: UUID
  }
}

/// Test-only helper: yields repeatedly so `Task { await ... }` work queued by a fake timer firing
/// (or by any other fire-and-forget hop onto the `CordieriteClient` actor) has a chance to run
/// before the test asserts on the result.
func drainPendingTasks(iterations: Int = 20) async {
  for _ in 0..<iterations {
    await Task.yield()
  }
  try? await Task.sleep(nanoseconds: 5_000_000)
  for _ in 0..<iterations {
    await Task.yield()
  }
}

/// A one-shot async gate a test can hold open until it is ready for a handler to proceed --
/// `withCheckedContinuation` (the non-throwing variant) deliberately ignores `Task` cancellation, so
/// a handler `await`ing one keeps waiting even after its enclosing call has been cancelled/timed
/// out, letting a test simulate "the handler resolves late, after the timeout already answered".
final class Gate: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Never>?

  func wait() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      self.continuation = continuation
      lock.unlock()
    }
  }

  func open() {
    lock.lock()
    let continuation = self.continuation
    self.continuation = nil
    lock.unlock()
    continuation?.resume()
  }
}

/// Thread-safe append-only collector for listener callbacks registered from a test: a local `var`
/// captured and mutated by a `@Sendable` listener closure is rejected outright under strict
/// concurrency, so tests collect into one of these instead.
final class EventCollector<Event>: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [Event] = []

  func append(_ event: Event) {
    lock.lock()
    events.append(event)
    lock.unlock()
  }

  var all: [Event] {
    lock.lock()
    defer { lock.unlock() }
    return events
  }

  var last: Event? { all.last }
  var first: Event? { all.first }
}
