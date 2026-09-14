// Vendored into @cordierite/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if CORDIERITE_ENABLED

import Foundation

/// Everything the TypeScript client (`packages/react-native/src/client/*`, `bootstrap.ts`,
/// `deep-link-core.ts`) used to own, ported into Swift on top of `CordieriteConnectionManager`
/// (issue #48 phase 2, `docs/tasks/15-native-session-logic.md`): reconnect with full-jitter backoff,
/// grace-window lease recovery, the tool registry and its wire deltas, per-call timeout/cancel/
/// progress, and v2 bootstrap deep-link handling. One instance is meant to live for the app process
/// lifetime (or the RN TurboModule bridge's lifetime); construct one, `registerTool` your handlers,
/// then `connect`/`restoreSession`/`handleUrl` as your app's bootstrap flow requires.
public actor CordieriteClient {
  // MARK: Dependencies

  let transport: any CordieriteTransportSession
  let timers: any CordieriteClientTimers
  let defaultToolTimeoutMs: Int
  let requirePrivateIp: Bool
  let foregroundObserver: any CordieriteForegroundObserving

  // MARK: Unified session state

  var clientState: CordieriteClientState = .idle
  nonisolated(unsafe) private(set) var stateSnapshot: CordieriteClientState = .idle
  nonisolated(unsafe) private(set) var sessionIdSnapshot: String?

  struct HeldSession {
    var sessionId: String
    var resumeToken: String
    var alias: String
    var keepaliveIntervalS: Double
    var graceS: Double
    var disconnectedAtMs: Double?
    var endpoint: (ip: String, port: Int)
  }

  var heldSession: HeldSession?
  /// The session an in-flight `connect()`/resume is claiming, before any ack sets `heldSession`.
  var connectingSessionId: String?

  struct PendingAttempt {
    let resume: (Result<SessionAck, Error>) -> Void
  }

  struct SessionAck: Sendable {
    let sessionId: String
    let resumeToken: String
    let alias: String
    let keepaliveIntervalS: Double
    let graceS: Double
  }

  var epoch: Int = 0
  var pendingAttempt: PendingAttempt?
  var reconnectAttempt: Int = 0
  var reconnectTimerHandle: (any CordieriteTimerHandle)?
  var graceTimerHandle: (any CordieriteTimerHandle)?
  var resumeInFlight = false
  var backgrounded: Bool
  var destroyed = false
  var lastErrorDetails: CordieriteErrorDetails?
  var foregroundSubscription: (any CordieriteDisposable)?

  // MARK: Tool registry (registration order preserved)

  /// Not actor-isolated -- see `CordieriteToolRegistryStore`'s doc comment.
  let registryStore = CordieriteToolRegistryStore()

  // MARK: In-flight tool calls

  final class InFlightToolCall {
    let task: Task<Void, Never>
    var cancelled = false
    var timedOut = false
    /// "client_cancelled" (default for an explicit `tool_cancel` with no reason)/the wire
    /// `tool_cancel.reason`, "timeout", or "session_suspended" -- surfaced to a native `ToolHandler`
    /// via `ToolCallContext.cancelReason()` and to the RN bridge's `onToolCancel` event.
    var cancelReason: String?
    init(task: Task<Void, Never>) { self.task = task }
  }

  var inFlightCalls: [String: InFlightToolCall] = [:]

  // MARK: Listeners

  var stateChangeListeners: [UUID: @Sendable (CordieriteStateChangeEvent) -> Void] = [:]
  var sessionChangeListeners: [UUID: @Sendable (CordieriteSessionChangeEvent) -> Void] = [:]
  var errorListeners: [UUID: @Sendable (CordieriteUnifiedErrorEvent) -> Void] = [:]

  // MARK: Init

  public init(
    transport: any CordieriteTransportSession = CordieriteConnectionManager(),
    timers: any CordieriteClientTimers = SystemCordieriteClientTimers(),
    defaultToolTimeoutMs: Int = CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS,
    requirePrivateIp: Bool? = nil,
    foregroundObserver: (any CordieriteForegroundObserving)? = nil
  ) {
    self.transport = transport
    self.timers = timers
    self.defaultToolTimeoutMs = defaultToolTimeoutMs
    self.requirePrivateIp = requirePrivateIp ?? currentCordieriteBuildConfig().allowPrivateLanOnly
    #if canImport(UIKit)
      self.foregroundObserver = foregroundObserver ?? UIKitCordieriteForegroundObserver()
    #else
      self.foregroundObserver = foregroundObserver ?? NeverBackgroundedObserver()
    #endif
    self.backgrounded = self.foregroundObserver.isBackgrounded()

    // Deferred to a `Task` rather than wired inline: under strict concurrency, capturing `self` in
    // an escaping closure during a synchronous actor `init` makes every stored property write after
    // that point (`foregroundSubscription`, in particular) illegal ("only nonisolated properties of
    // self can be accessed"). Running the wiring as the actor's first queued unit of work instead
    // sidesteps that restriction; it runs before any externally-observable call (`connect`,
    // `registerTool`, ...) can reach this instance, since those are only ever invoked after the
    // caller already holds a reference returned by this initializer.
    let instance = self
    Task { await instance.wireTransportAndForeground() }
  }

  private func wireTransportAndForeground() {
    transport.emitMessageRaw = { [weak self] text in
      Task { await self?.handleIncomingWireText(text) }
    }
    transport.emitError = { [weak self] details in
      Task { await self?.handleTransportError(details) }
    }
    transport.emitClose = { [weak self] payload in
      // Extracted to `Sendable` values before crossing into the `Task`: `NSDictionary` itself is
      // not provably `Sendable` under strict concurrency, even though this particular payload
      // (built fresh by `CordieriteConnectionManager` for exactly this callback) is never mutated
      // again after this closure receives it.
      let code = (payload["code"] as? NSNumber)?.intValue
      let reason = payload["reason"] as? String
      Task { await self?.handleTransportClose(code: code, reason: reason) }
    }
    foregroundSubscription = foregroundObserver.onChange { [weak self] background in
      Task { await self?.handleForegroundChange(background: background) }
    }
  }

  // MARK: Listener registration

  @discardableResult
  public func onStateChange(_ callback: @escaping @Sendable (CordieriteStateChangeEvent) -> Void) -> any CordieriteDisposable {
    let id = UUID()
    stateChangeListeners[id] = callback
    return ClosureDisposable { [weak self] in
      Task { await self?.removeStateChangeListener(id) }
    }
  }

  @discardableResult
  public func onSessionChange(_ callback: @escaping @Sendable (CordieriteSessionChangeEvent) -> Void) -> any CordieriteDisposable {
    let id = UUID()
    sessionChangeListeners[id] = callback
    return ClosureDisposable { [weak self] in
      Task { await self?.removeSessionChangeListener(id) }
    }
  }

  @discardableResult
  public func onError(_ callback: @escaping @Sendable (CordieriteUnifiedErrorEvent) -> Void) -> any CordieriteDisposable {
    let id = UUID()
    errorListeners[id] = callback
    return ClosureDisposable { [weak self] in
      Task { await self?.removeErrorListener(id) }
    }
  }

  func removeStateChangeListener(_ id: UUID) { stateChangeListeners.removeValue(forKey: id) }
  func removeSessionChangeListener(_ id: UUID) { sessionChangeListeners.removeValue(forKey: id) }
  func removeErrorListener(_ id: UUID) { errorListeners.removeValue(forKey: id) }

  func emitError(_ event: CordieriteUnifiedErrorEvent) {
    for callback in errorListeners.values { callback(event) }
  }

  func setClientState(_ next: CordieriteClientState, reason: String? = nil) {
    if clientState == next && reason == nil { return }
    clientState = next
    stateSnapshot = next
    let event = CordieriteStateChangeEvent(state: next, reason: reason)
    for callback in stateChangeListeners.values { callback(event) }
  }

  func emitSessionChange(type: CordieriteSessionChangeKind, sessionId: String?, alias: String?, reason: String? = nil) {
    let event = CordieriteSessionChangeEvent(type: type, sessionId: sessionId, alias: alias, reason: reason)
    for callback in sessionChangeListeners.values { callback(event) }
  }

  // MARK: Public state accessors

  /// Synchronous snapshot for the TurboModule bridge's `getState()`.
  public nonisolated func currentStateSnapshot() -> String { stateSnapshot.rawValue }
  /// Synchronous snapshot for the TurboModule bridge's `getSessionId()`.
  public nonisolated func currentSessionIdSnapshot() -> String? { sessionIdSnapshot }
  /// Synchronous snapshot for the TurboModule bridge's `getRegisteredToolsJson()`.
  public nonisolated func currentRegisteredToolsSnapshot() -> [ToolDescriptor] { registryStore.snapshot() }

  public var state: CordieriteClientState { clientState }
  public var sessionId: String? { heldSession?.sessionId ?? connectingSessionId }
  public nonisolated var registeredTools: [ToolDescriptor] { registryStore.snapshot() }

  func updateSessionIdSnapshot() {
    sessionIdSnapshot = heldSession?.sessionId ?? connectingSessionId
  }

  // MARK: Tool registry
  //
  // Deliberately `nonisolated` (see `CordieriteToolRegistryStore`): the TurboModule bridge's
  // `registerTool`/`unregisterTool` are synchronous, throwing methods with no `Promise`, matching
  // the frozen spec. Sending the wire `tool_registry_delta` is fired off separately, async.

  /// Registers (or replaces, by name) a tool. Validates `descriptor` exactly like
  /// `@cordierite/shared`'s `isToolDescriptor` (PROTOCOL.md §5); throws on an invalid one. Upserts
  /// by name (registration order preserved for a new name); sends `tool_registry_delta` while a
  /// session is active.
  public nonisolated func registerTool(_ descriptor: ToolDescriptor, handler: @escaping ToolHandler) throws {
    let effectiveDescriptor = try registryStore.upsert(descriptor, handler: handler, defaultTimeoutMs: defaultToolTimeoutMs)
    Task { await self.sendToolRegistryDelta(.upsert(effectiveDescriptor)) }
  }

  public nonisolated func unregisterTool(_ name: String) {
    guard registryStore.remove(name) else { return }
    Task { await self.sendToolRegistryDelta(.remove(name)) }
  }

  // MARK: postEvent

  public struct CordieriteNotActiveError: Error, Sendable {}

  /// Emits an `event` frame while active (PROTOCOL.md §7); rejects otherwise.
  public func postEvent(_ name: String, payload: JSONValue? = nil) async throws {
    guard clientState == .active, let sessionId = heldSession?.sessionId else {
      throw CordieriteNotActiveError()
    }

    var message: JSONObject = [
      "type": .string("event"),
      "session_id": .string(sessionId),
      "name": .string(name),
      "ts": .number(timers.now() / 1_000),
    ]
    if let payload { message["payload"] = payload }

    do {
      try await sendWire(.object(message))
    } catch {
      emitError(
        CordieriteUnifiedErrorEvent(phase: "socket", message: "Failed to send event \"\(name)\".")
      )
      throw error
    }
  }

  // MARK: disconnect

  /// Closes the socket, clears the lease, state → `closed`. Idempotent.
  public func disconnect() async {
    epoch += 1
    clearReconnectTimer()
    clearGraceTimer()

    let hadSession = heldSession != nil
    heldSession = nil
    connectingSessionId = nil
    resumeInFlight = false
    updateSessionIdSnapshot()
    transport.clearResumeLease()

    settlePendingAttempt(.failure(CordieriteClientClosedError()))

    setClientState(.closed, reason: "closed_by_app")
    if hadSession {
      // Both null once the session is gone -- see `CordieriteSessionChangeEventNative`'s doc
      // comment; a listener that needs the departing session's id/alias should cache the most
      // recent non-null `sessionChange` event alongside this one.
      emitSessionChange(type: .lost, sessionId: nil, alias: nil, reason: "closed_by_app")
    }

    await transport.close()
  }

  public struct CordieriteClientClosedError: Error, Sendable {}

  /// Removes every listener and transport wiring. Call when discarding a client instance (mirrors
  /// the JS client's `destroy()`).
  public func destroy() async {
    destroyed = true
    clearReconnectTimer()
    clearGraceTimer()
    settlePendingAttempt(.failure(CordieriteClientClosedError()))
    abortAllInFlight()
    foregroundSubscription?.dispose()
    await transport.invalidate()
  }

  func sendWire(_ value: JSONValue) async throws {
    let text = try value.serialized()
    try await transport.send(message: text)
  }
}

/// A disposable backed by a closure; used for listener removal handles above.
struct ClosureDisposable: CordieriteDisposable {
  let body: @Sendable () -> Void
  func dispose() { body() }
}

#endif
