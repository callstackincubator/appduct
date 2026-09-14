// Vendored into @cordierite/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if CORDIERITE_ENABLED

import Foundation

/// Session lifecycle: claim/resume handshake, reconnect backoff, grace-window recovery, and v2
/// bootstrap deep-link handling. Ports `client/index.ts` (the handshake/reconnect halves),
/// `deep-link-core.ts`, and `client/resume-lease.ts`'s expiry check.
extension CordieriteClient {
  // MARK: Errors

  public struct CordieriteInvalidConnectInputError: Error, Sendable {
    public let message: String
  }

  public struct CordieriteAlreadyConnectingError: Error, Sendable {}

  struct CordieriteSupersededError: Error, Sendable {}
  struct CordieriteSessionLostWhileConnectingError: Error, Sendable {}

  // MARK: Public API

  /// Feeds a deep link to the core. Returns `true` iff `url` carried a `cordierite` query param --
  /// the actual parse/connect work (and any resulting `onError`) happens asynchronously, exactly as
  /// the pre-port JS `handleCordieriteDeepLinkUrl` was itself fire-and-forget from a `Linking`
  /// listener's perspective. Kept `nonisolated` and synchronous to match the frozen TurboModule
  /// spec's `handleUrl(url): boolean` (no `Promise`).
  public nonisolated func handleUrl(_ url: String) -> Bool {
    let matches = hasCordieriteBootstrapQuery(url)
    if matches {
      Task { await self.processDeepLink(url: url) }
    }
    return matches
  }

  /// Runs the v2 claim (or, with `supersede`, a link-superseding) handshake and resolves once
  /// `session_ack` is received.
  public func connect(_ input: CordieriteConnectInput, supersede: Bool = false) async throws {
    let nowSeconds = Int(timers.now() / 1_000)

    guard isCordieriteConnectInputValid(input, now: nowSeconds) else {
      throw CordieriteInvalidConnectInputError(message: "Invalid or expired Cordierite bootstrap payload.")
    }

    let nativeState = transport.currentStateSnapshot()
    let supersedingReconnect = clientState == .reconnecting || supersede
    if (nativeState == "connecting" || nativeState == "active") && !supersedingReconnect {
      throw CordieriteAlreadyConnectingError()
    }

    epoch += 1
    let myEpoch = epoch
    clearReconnectTimer()
    clearGraceTimer()
    reconnectAttempt = 0
    heldSession = nil
    connectingSessionId = input.sessionId
    updateSessionIdSnapshot()
    resumeInFlight = false
    transport.clearResumeLease()
    if supersedingReconnect {
      settlePendingAttempt(.failure(CordieriteSupersededError()))
    }

    do {
      if supersedingReconnect && (nativeState == "connecting" || nativeState == "active") {
        await transport.close()
      }
      setClientState(.connecting)
      let options = try buildTransportOptions(from: input)
      let ack = try await performHandshake(options)

      if myEpoch != epoch {
        // Superseded by a newer `connect()` while awaiting the ack; abandon silently.
        return
      }

      connectingSessionId = nil
      onAckReceived(ack, endpoint: (input.ip, input.port))
    } catch {
      if myEpoch == epoch {
        connectingSessionId = nil
        updateSessionIdSnapshot()
        setClientState(.closed, reason: "connect_error")
        emitError(
          CordieriteUnifiedErrorEvent(phase: "connect", message: describeConnectError(error))
        )
      }
      throw error
    }
  }

  /// Starts recovery from the native process-memory lease. Resolves `true` once a resume attempt
  /// has been accepted and started, not once `session_ack` lands. `false` when there is no valid,
  /// unexpired lease, or this client is not idle/closed.
  public func restoreSession() async -> Bool {
    guard !destroyed, heldSession == nil, clientState == .idle || clientState == .closed else {
      return false
    }

    guard let lease = CordieriteProcessResumeLeaseStore.shared.get() else {
      return false
    }

    let now = timers.now()
    if isCordieriteResumeLeaseExpired(lease, nowMs: now) {
      transport.clearResumeLease()
      return false
    }

    let nativeState = transport.currentStateSnapshot()
    if nativeState == "connecting" || nativeState == "active" {
      return false
    }

    epoch += 1
    let myEpoch = epoch
    clearReconnectTimer()
    clearGraceTimer()
    reconnectAttempt = 0
    heldSession = HeldSession(
      sessionId: lease.sessionId,
      resumeToken: lease.resumeToken,
      alias: lease.alias,
      keepaliveIntervalS: lease.keepaliveIntervalS,
      graceS: lease.graceS,
      disconnectedAtMs: lease.disconnectedAtMs.map(Double.init) ?? now,
      endpoint: (lease.endpoint.ip, lease.endpoint.port)
    )
    updateSessionIdSnapshot()
    setClientState(.reconnecting)
    scheduleGraceExpiry(myEpoch)
    Task { await self.attemptResume(myEpoch) }
    return true
  }

  // MARK: Deep link processing (async tail of `handleUrl`)

  func processDeepLink(url: String) async {
    let now = Int(timers.now() / 1_000)

    let bootstrap: CordieriteBootstrapPayload
    do {
      bootstrap = try parseCordieriteBootstrapUrl(url, now: now, requirePrivateIp: requirePrivateIp)
    } catch let parseError as CordieriteBootstrapParseError {
      emitError(CordieriteUnifiedErrorEvent(phase: "bootstrap", message: parseError.message))
      return
    } catch {
      emitError(CordieriteUnifiedErrorEvent(phase: "bootstrap", message: "Cordierite bootstrap error."))
      return
    }

    let heldSessionId = heldSession?.sessionId ?? connectingSessionId
    let holdsSession = clientState == .connecting || clientState == .active

    if holdsSession && heldSessionId == bootstrap.sessionId {
      // Already on this session -- a re-delivered link is ignored, not re-claimed (its token is
      // single-use).
      return
    }

    let input = CordieriteConnectInput(
      ip: bootstrap.address,
      port: bootstrap.port,
      sessionId: bootstrap.sessionId,
      token: bootstrap.token,
      expiresAt: bootstrap.expiresAt,
      linkPin: bootstrap.linkPin
    )

    do {
      try await connect(input, supersede: holdsSession)
    } catch {
      emitError(
        CordieriteUnifiedErrorEvent(phase: "bootstrap", message: "Cordierite bootstrap connect failed.")
      )
    }
  }

  // MARK: Handshake plumbing

  func buildTransportOptions(from input: CordieriteConnectInput) throws -> CordieriteConnectOptions {
    var dict: [String: Any] = [
      "ip": input.ip,
      "port": input.port,
      "sessionId": input.sessionId,
      "expiresAt": input.expiresAt,
    ]
    if let token = input.token { dict["token"] = token }
    if let resumeToken = input.resumeToken { dict["resumeToken"] = resumeToken }
    if let linkPin = input.linkPin { dict["linkPin"] = linkPin }
    return try CordieriteConnectOptions(dict)
  }

  @discardableResult
  func settlePendingAttempt(_ result: Result<SessionAck, Error>) -> Bool {
    guard let attempt = pendingAttempt else { return false }
    pendingAttempt = nil
    attempt.resume(result)
    return true
  }

  func performHandshake(_ options: CordieriteConnectOptions) async throws -> SessionAck {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<SessionAck, Error>) in
      pendingAttempt = PendingAttempt(resume: { result in continuation.resume(with: result) })
      Task {
        do {
          try await self.transport.connect(options: options)
        } catch {
          await self.settlePendingAttempt(.failure(error))
        }
      }
    }
  }

  func onAckReceived(_ ack: SessionAck, endpoint: (ip: String, port: Int)) {
    clearReconnectTimer()
    clearGraceTimer()
    reconnectAttempt = 0
    resumeInFlight = false

    heldSession = HeldSession(
      sessionId: ack.sessionId,
      resumeToken: ack.resumeToken,
      alias: ack.alias,
      keepaliveIntervalS: ack.keepaliveIntervalS,
      graceS: ack.graceS,
      disconnectedAtMs: nil,
      endpoint: endpoint
    )
    updateSessionIdSnapshot()

    setClientState(.active)
    emitSessionChange(sessionId: ack.sessionId, alias: ack.alias)

    Task { await self.sendSnapshot() }
  }

  func finalizeSessionLost(_ reason: String) {
    epoch += 1
    clearReconnectTimer()
    clearGraceTimer()
    let hadSession = heldSession != nil
    heldSession = nil
    connectingSessionId = nil
    updateSessionIdSnapshot()
    resumeInFlight = false
    transport.clearResumeLease()

    settlePendingAttempt(.failure(CordieriteSessionLostWhileConnectingError()))

    setClientState(.closed, reason: reason)
    if hadSession {
      emitSessionChange(sessionId: nil, alias: nil)
    }
  }

  func scheduleReconnectAttempt(_ myEpoch: Int) {
    guard myEpoch == epoch, !destroyed, heldSession != nil else { return }

    setClientState(.reconnecting)

    if backgrounded {
      // No timer while backgrounded: the socket stays as the OS left it; foreground triggers an
      // immediate attempt.
      return
    }

    let delay = CordieriteBackoff.fullJitterMs(attempt: reconnectAttempt, random: timers.random)
    reconnectAttempt += 1

    reconnectTimerHandle = timers.setTimeout(afterMs: delay) { [weak self] in
      Task {
        await self?.clearReconnectTimerHandle()
        await self?.attemptResume(myEpoch)
      }
    }
  }

  func clearReconnectTimerHandle() {
    reconnectTimerHandle = nil
  }

  func scheduleGraceExpiry(_ myEpoch: Int) {
    guard graceTimerHandle == nil, heldSession != nil else { return }

    let now = timers.now()
    let disconnectedAtMs = heldSession?.disconnectedAtMs ?? now
    heldSession?.disconnectedAtMs = disconnectedAtMs
    let remainingGraceMs = (heldSession?.graceS ?? 0) * 1_000 - (now - disconnectedAtMs)

    graceTimerHandle = timers.setTimeout(afterMs: max(remainingGraceMs, 0)) { [weak self] in
      Task {
        guard let self else { return }
        await self.handleGraceExpiry(myEpoch)
      }
    }
  }

  func handleGraceExpiry(_ myEpoch: Int) {
    graceTimerHandle = nil
    if myEpoch == epoch && heldSession != nil {
      finalizeSessionLost("grace_expired")
    }
  }

  func attemptResume(_ myEpoch: Int) async {
    guard !resumeInFlight, !destroyed, myEpoch == epoch, let session = heldSession else { return }

    let now = timers.now()
    let disconnectedAtMs = session.disconnectedAtMs ?? now
    heldSession?.disconnectedAtMs = disconnectedAtMs
    if now - disconnectedAtMs >= session.graceS * 1_000 {
      finalizeSessionLost("grace_expired")
      return
    }

    resumeInFlight = true
    let resumeNowSeconds = Int(now / 1_000)
    let input = CordieriteConnectInput(
      ip: session.endpoint.ip,
      port: session.endpoint.port,
      sessionId: session.sessionId,
      resumeToken: session.resumeToken,
      // Comfortably past native's own expiry guard, independent of the original claim's expiry.
      expiresAt: resumeNowSeconds + max(Int(session.graceS), 60) + 60
    )

    let ack: SessionAck
    do {
      let options = try buildTransportOptions(from: input)
      ack = try await performHandshake(options)
    } catch {
      resumeInFlight = false
      if myEpoch != epoch || destroyed { return }

      emitError(
        CordieriteUnifiedErrorEvent(phase: "socket", message: "Cordierite resume attempt failed.")
      )

      if let handshakeError = error as? CordieriteHandshakeClosedError, isTerminalHandshakeRejection(handshakeError) {
        finalizeSessionLost(terminalCloseReason(handshakeError.closeEvent))
        return
      }

      scheduleReconnectAttempt(myEpoch)
      return
    }

    resumeInFlight = false
    if myEpoch != epoch || destroyed { return }
    onAckReceived(ack, endpoint: session.endpoint)
  }

  // MARK: Transport event handlers

  func handleIncomingWireText(_ text: String) async {
    guard let value = try? JSONValue.parse(text), case .object(let object) = value else { return }

    if object["type"]?.stringValue == "session_ack", let ack = decodeSessionAck(object) {
      if !settlePendingAttempt(.success(ack)) {
        // stray session_ack, no handshake in flight -- ignored, matching the JS client.
      }
      return
    }

    await dispatchIncomingToolMessage(object)
  }

  func decodeSessionAck(_ object: JSONObject) -> SessionAck? {
    guard
      object["status"]?.stringValue == "ok",
      let sessionId = object["session_id"]?.stringValue,
      let resumeToken = object["resume_token"]?.stringValue,
      let alias = object["alias"]?.stringValue,
      let keepaliveIntervalS = object["keepalive_interval_s"]?.doubleValue,
      let graceS = object["grace_s"]?.doubleValue
    else {
      return nil
    }
    return SessionAck(
      sessionId: sessionId,
      resumeToken: resumeToken,
      alias: alias,
      keepaliveIntervalS: keepaliveIntervalS,
      graceS: graceS
    )
  }

  func handleTransportError(_ details: CordieriteErrorDetails) {
    lastErrorDetails = details
  }

  func handleTransportClose(code: Int?, reason: String?) async {
    let closeEvent = CordieriteCloseEvent(code: code, reason: reason)

    let errorDetails = lastErrorDetails
    lastErrorDetails = nil

    let handshakeError = CordieriteHandshakeClosedError(
      message: reason ?? errorDetails?.message ?? "Cordierite connection closed.",
      closeEvent: closeEvent
    )

    if settlePendingAttempt(.failure(handshakeError)) {
      return
    }

    onSocketLost(closeEvent, errorDetails: errorDetails)
  }

  func onSocketLost(_ event: CordieriteCloseEvent, errorDetails: CordieriteErrorDetails?) {
    guard !destroyed else { return }

    // The socket is gone, so no `tool_cancel` frame could ever be delivered for whatever was still
    // in flight -- abort it directly.
    abortAllInFlight()

    let myEpoch = epoch

    guard heldSession != nil else {
      setClientState(.closed, reason: "socket_closed")
      return
    }

    if event.code == 1_000 {
      finalizeSessionLost("revoked")
      return
    }

    emitError(
      CordieriteUnifiedErrorEvent(
        phase: "socket",
        message: event.reason ?? errorDetails?.message ?? "Cordierite connection lost.",
        code: errorDetails?.code,
        nativeCode: errorDetails?.nativeCode,
        closeReason: event.reason,
        isRetryable: errorDetails?.isRetryable,
        hint: errorDetails?.hint
      )
    )

    if isTerminalCloseEvent(event) {
      finalizeSessionLost(terminalCloseReason(event))
      return
    }

    let now = timers.now()
    let disconnectedAtMs = heldSession?.disconnectedAtMs ?? now
    heldSession?.disconnectedAtMs = disconnectedAtMs
    if now - disconnectedAtMs >= (heldSession?.graceS ?? 0) * 1_000 {
      finalizeSessionLost("grace_expired")
      return
    }

    scheduleGraceExpiry(myEpoch)
    scheduleReconnectAttempt(myEpoch)
  }

  func handleForegroundChange(background: Bool) async {
    guard background != backgrounded else { return }
    backgrounded = background

    if backgrounded {
      clearReconnectTimer()
      return
    }

    if heldSession != nil, clientState == .reconnecting, !resumeInFlight {
      clearReconnectTimer()
      await attemptResume(epoch)
    }
  }

  // MARK: Timers / wire sends

  func clearReconnectTimer() {
    if let handle = reconnectTimerHandle {
      timers.clearTimeout(handle)
      reconnectTimerHandle = nil
    }
  }

  func clearGraceTimer() {
    if let handle = graceTimerHandle {
      timers.clearTimeout(handle)
      graceTimerHandle = nil
    }
  }

  func sendSnapshot() async {
    guard clientState == .active, let sessionId = heldSession?.sessionId else { return }
    let tools = registryStore.snapshot()
    let message = JSONValue.object([
      "type": .string("tool_registry_snapshot"),
      "session_id": .string(sessionId),
      "tools": .array(tools.map { $0.wireValue }),
    ])
    try? await sendWire(message)
  }

  func sendToolRegistryDelta(_ delta: CordieriteRegistryDelta) async {
    guard clientState == .active, let sessionId = heldSession?.sessionId else { return }

    var object: JSONObject = ["type": .string("tool_registry_delta"), "session_id": .string(sessionId)]
    switch delta {
    case .upsert(let descriptor):
      object["operation"] = .string("upsert")
      object["tool"] = descriptor.wireValue
    case .remove(let name):
      object["operation"] = .string("remove")
      object["name"] = .string(name)
    }

    do {
      try await sendWire(.object(object))
    } catch {
      emitError(
        CordieriteUnifiedErrorEvent(phase: "socket", message: "Failed to sync the tool registry.")
      )
    }
  }

  private func describeConnectError(_ error: Error) -> String {
    if let invalid = error as? CordieriteInvalidConnectInputError { return invalid.message }
    if error is CordieriteAlreadyConnectingError {
      return "A Cordierite session is already connecting or active."
    }
    if let jsonError = error as? CordieriteJSONError { return jsonError.message }
    return "Cordierite connect failed."
  }
}

/// Ports `client/resume-lease.ts`'s `isResumeLeaseExpired`, operating on the already-typed native
/// lease record instead of an untyped stored value.
func isCordieriteResumeLeaseExpired(_ lease: CordieriteResumeLeaseV1, nowMs: Double) -> Bool {
  guard let disconnectedAtMs = lease.disconnectedAtMs else { return false }
  return nowMs - Double(disconnectedAtMs) >= lease.graceS * 1_000
}

#endif
