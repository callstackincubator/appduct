// NOTE: deliberately no `#if APPDUCT_ENABLED` guard here -- that define is a build setting on
// the `AppductCore` target only (see Package.swift), never on this test target, so wrapping this
// file's contents in it would silently compile the whole file out. `swift test` always builds
// `AppductCore` itself in `.debug` (the real implementation), which is what these fakes stand in
// front of.

import Foundation
import XCTest
@testable import AppductCore

/// Scripted fake standing in for `AppductConnectionManager` in `AppductClient` tests, so the
/// reconnect/registry/tool-invocation state machine is testable without a real TLS/WebSocket stack.
final class FakeTransportSession: AppductTransportSession, @unchecked Sendable {
  // The client assigns these from its own actor (in a `Task` its initializer queues) while tests
  // read them from the test's thread, so they sit behind the same lock as the counters below.
  private var _emitStateChange: (@Sendable (String) -> Void)?
  private var _emitMessageRaw: (@Sendable (String) -> Void)?
  private var _emitError: (@Sendable (AppductErrorDetails) -> Void)?
  private var _emitClose: (@Sendable (NSDictionary) -> Void)?

  var emitStateChange: (@Sendable (String) -> Void)? {
    get { withLock { _emitStateChange } }
    set { withLock { _emitStateChange = newValue } }
  }

  var emitMessageRaw: (@Sendable (String) -> Void)? {
    get { withLock { _emitMessageRaw } }
    set { withLock { _emitMessageRaw = newValue } }
  }

  var emitError: (@Sendable (AppductErrorDetails) -> Void)? {
    get { withLock { _emitError } }
    set { withLock { _emitError = newValue } }
  }

  var emitClose: (@Sendable (NSDictionary) -> Void)? {
    get { withLock { _emitClose } }
    set { withLock { _emitClose = newValue } }
  }

  /// Whether the client has installed its transport callbacks yet. `AppductClient.init` defers
  /// that wiring to a `Task`, which is not ordered against a `connect` the test starts right
  /// after construction: `transport.connect` can be reached before the callbacks exist, and a
  /// `simulateAck` sent then goes nowhere. Handshake waits therefore check this *and*
  /// `connectCallCount`.
  var isWired: Bool {
    withLock { _emitMessageRaw != nil && _emitClose != nil }
  }

  private let lock = NSLock()
  private var _stateSnapshot = "idle"
  private var _sentMessages: [String] = []
  private var _connectCallCount = 0
  private var _lastConnectOptions: AppductConnectOptions?
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

  var lastConnectOptions: AppductConnectOptions? {
    withLock { _lastConnectOptions }
  }

  var closeCallCount: Int {
    withLock { _closeCallCount }
  }

  func connect(options: AppductConnectOptions) async throws {
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

  func simulateIncoming(_ text: String, file: StaticString = #filePath, line: UInt = #line) {
    guard let emitMessageRaw else {
      XCTFail("simulated a frame before the client wired its transport callbacks; it was dropped", file: file, line: line)
      return
    }
    emitMessageRaw(text)
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
    guard let emitClose else {
      XCTFail("simulated a close before the client wired its transport callbacks; it was dropped")
      return
    }
    emitClose(dict)
  }
}

/// Deterministic virtual-clock timers for reconnect/backoff/grace tests. `advance(byMs:)` fires
/// every timer now due, synchronously, in due-time order -- mirrors the role of vitest's fake
/// timers in the original JS test suite (`client/timers.ts`'s `ClientTimers`).
final class FakeClientTimers: AppductClientTimers, @unchecked Sendable {
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

  func setTimeout(afterMs: Double, _ handler: @escaping @Sendable () -> Void) -> any AppductTimerHandle {
    let id = UUID()
    lock.lock()
    scheduled.append((id, currentTimeMs + max(0, afterMs), handler))
    lock.unlock()
    return FakeTimerHandle(id: id)
  }

  func clearTimeout(_ handle: any AppductTimerHandle) {
    guard let handle = handle as? FakeTimerHandle else { return }
    lock.lock()
    scheduled.removeAll { $0.id == handle.id }
    lock.unlock()
  }

  var pendingCount: Int {
    lock.lock(); defer { lock.unlock() }; return scheduled.count
  }

  /// Advances the virtual clock by `deltaMs` and fires every timer now due. Handlers themselves
  /// typically just kick off a `Task` to hop back onto the actor, so a test must `waitUntil` the
  /// observable effect of that queued work (a new `connectCallCount`, a state change, a frame on
  /// the wire) rather than assert immediately after this returns.
  func advance(byMs deltaMs: Double) {
    lock.lock()
    currentTimeMs += deltaMs
    let due = scheduled.filter { $0.dueAt <= currentTimeMs }.sorted { $0.dueAt < $1.dueAt }
    let dueIds = Set(due.map(\.id))
    scheduled.removeAll { dueIds.contains($0.id) }
    lock.unlock()
    for entry in due { entry.handler() }
  }

  struct FakeTimerHandle: AppductTimerHandle {
    let id: UUID
  }
}

/// Thrown by `waitUntil` (right after it records an `XCTFail`) when its condition never held.
struct WaitTimedOutError: Error, CustomStringConvertible {
  let description: String
}

/// Polls `condition` until it holds, or fails the test and throws once `timeout` elapses.
///
/// This replaces the fixed `Task.yield()` draining these tests used to do (issue #61):
/// `Task.yield()` is a scheduling hint, not a wait, so a fixed number of yields guarantees
/// neither that the `AppductClient` actor has reached the point a simulated event needs (a
/// handshake actually in flight, say -- a `session_ack` that arrives before `transport.connect`
/// has been called is dropped as stray) nor that it has already applied an event a test is about
/// to assert on. Every wait is therefore expressed as an *observable* condition -- a transport
/// counter, a frame on the wire, an actor state snapshot, a collected listener event -- and is
/// bounded, so a genuinely broken expectation fails with a readable message instead of hanging.
///
/// `condition` may be sync or async (a sync closure literal converts implicitly).
func waitUntil(
  _ what: String,
  timeout: TimeInterval = 5,
  pollIntervalMs: UInt64 = 2,
  file: StaticString = #filePath,
  line: UInt = #line,
  _ condition: () async -> Bool
) async throws {
  let deadline = Date().addingTimeInterval(timeout)
  repeat {
    if await condition() { return }
    try? await Task.sleep(nanoseconds: pollIntervalMs * 1_000_000)
  } while Date() < deadline
  if await condition() { return }

  let message = "Timed out after \(timeout)s waiting for: \(what)"
  XCTFail(message, file: file, line: line)
  throw WaitTimedOutError(description: message)
}

/// Bounded wait used *only* for negative assertions ("and then nothing else happens"), where
/// there is by definition no condition to poll for: gives whatever work is queued on the client
/// actor a real chance to run, so the follow-up assertion is meaningful rather than merely early.
func allowQueuedWorkToRun(ms: UInt64 = 150) async {
  try? await Task.sleep(nanoseconds: ms * 1_000_000)
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
