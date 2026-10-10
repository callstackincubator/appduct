import XCTest
@testable import AppductCore

/// Ports the behavioral spec of `client.test.ts`, `tool-invocation.test.ts`,
/// `deep-link-bootstrap.test.ts`, and `resume-lease-native-adapter.test.ts` onto `AppductClient`,
/// using `FakeTransportSession`/`FakeClientTimers` in place of a real TLS/WebSocket stack.
final class AppductClientTests: XCTestCase {
  override func setUp() {
    super.setUp()
    AppductProcessResumeLeaseStore.shared.resetForTests()
  }

  private func makeClient(
    timers: FakeClientTimers = FakeClientTimers(),
    defaultToolTimeoutMs: Int = 10_000,
    foregroundObserver: any AppductForegroundObserving = NeverBackgroundedObserver(),
    backgroundTime: FakeAppductBackgroundTime = FakeAppductBackgroundTime()
  ) -> (AppductClient, FakeTransportSession) {
    let transport = FakeTransportSession()
    let client = AppductClient(
      transport: transport,
      timers: timers,
      defaultToolTimeoutMs: defaultToolTimeoutMs,
      requirePrivateIp: true,
      foregroundObserver: foregroundObserver,
      backgroundTime: backgroundTime
    )
    return (client, transport)
  }

  private func connectInput(
    sessionId: String = "session-1",
    expiresAt: Int = 9_999_999_999,
    linkPin: String? = nil
  ) -> AppductConnectInput {
    AppductConnectInput(
      ip: "192.168.1.10",
      port: 8_443,
      sessionId: sessionId,
      token: "claim-token",
      expiresAt: expiresAt,
      linkPin: linkPin
    )
  }

  // MARK: connect / claim handshake

  func testConnectResolvesOnceAckArrivesAndReportsActive() async throws {
    let (client, transport) = makeClient()

    let sessionChanges = EventCollector<AppductSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", alias: "iphone-1")

    try await connectTask.value

    let state = await client.state
    XCTAssertEqual(state, .active)
    let sessionId = await client.sessionId
    XCTAssertEqual(sessionId, "session-1")
    XCTAssertEqual(sessionChanges.last?.sessionId, "session-1")
    XCTAssertEqual(sessionChanges.last?.alias, "iphone-1")
    XCTAssertEqual(sessionChanges.last?.type, .claimed)
    XCTAssertNil(sessionChanges.last?.reason)
  }

  func testConnectSendsFullRegistrySnapshotAfterAck() async throws {
    let (client, transport) = makeClient()
    try client.registerTool(ToolDescriptor(name: "tool_a", description: "A"), handler: { _, _ in .null })

    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value
    try await waitUntil("the registry snapshot reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_registry_snapshot") }
    }

    let snapshotMessage = transport.sentMessages.first { $0.contains("tool_registry_snapshot") }
    let snapshot = try XCTUnwrap(snapshotMessage)
    XCTAssertTrue(snapshot.contains("tool_a"))
  }

  func testConnectRejectsExpiredInput() async {
    let (client, _) = makeClient()
    let input = connectInput(expiresAt: -1)

    do {
      try await client.connect(input)
      XCTFail("expected an error")
    } catch {
      // expected
    }
    let state = await client.state
    XCTAssertEqual(state, .idle)
  }

  func testConnectRejectsWhenAlreadyActiveWithoutSupersede() async throws {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    do {
      try await client.connect(connectInput(sessionId: "session-2"))
      XCTFail("expected an error")
    } catch is AppductClient.AppductAlreadyConnectingError {
      // expected
    }
  }

  func testConnectWithSupersedeReplacesAnActiveSession() async throws {
    let (client, transport) = makeClient()
    let firstConnectInput = connectInput(sessionId: "session-1")
    let firstConnect = Task { try await client.connect(firstConnectInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await firstConnect.value

    let secondConnectInput = connectInput(sessionId: "session-2")
    let secondConnect = Task { try await client.connect(secondConnectInput, supersede: true) }
    try await waitUntil("the superseding connect started its own transport handshake") {
      transport.isWired && transport.connectCallCount >= 2
    }
    transport.simulateAck(sessionId: "session-2")
    try await secondConnect.value

    let sessionId = await client.sessionId
    XCTAssertEqual(sessionId, "session-2")
    XCTAssertGreaterThanOrEqual(transport.closeCallCount, 1)
  }

  func testAConnectThatFailsAfterASupersedingConnectDoesNotFailTheNewOne() async throws {
    let (client, transport) = makeClient()
    transport.holdNextConnect = true
    let firstConnectInput = connectInput(sessionId: "session-1")
    let firstConnect = Task { try await client.connect(firstConnectInput) }
    try await waitUntil("the first connect is still sending its claim") { transport.isWired && transport.hasHeldConnect }

    let secondConnectInput = connectInput(sessionId: "session-2")
    let secondConnect = Task { try await client.connect(secondConnectInput, supersede: true) }
    try await waitUntil("the superseding connect started its own transport handshake") { transport.connectCallCount >= 2 }
    transport.failHeldConnect(NSError(domain: "socket", code: 57))
    await allowQueuedWorkToRun()
    transport.simulateAck(sessionId: "session-2")

    try await secondConnect.value
    let sessionId = await client.sessionId
    XCTAssertEqual(sessionId, "session-2")
    _ = await firstConnect.result
  }

  func testSupersedingConnectAbortsTheOldSessionsInFlightToolHandler() async throws {
    let handlerStarted = XCTestExpectation(description: "handler started")
    let handlerCancelled = XCTestExpectation(description: "handler cancelled")
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "slow", description: "x")) { _, _ in
      handlerStarted.fulfill()
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_000_000)
      }
      handlerCancelled.fulfill()
      return .null
    }
    transport.simulateIncoming(toolCallText(id: "call-1", name: "slow"))
    await fulfillment(of: [handlerStarted], timeout: 2)

    let secondConnectInput = connectInput(sessionId: "session-2")
    let secondConnect = Task { try await client.connect(secondConnectInput, supersede: true) }

    await fulfillment(of: [handlerCancelled], timeout: 2)
    try await waitUntil("the superseding connect started its own transport handshake") { transport.connectCallCount >= 2 }
    transport.simulateAck(sessionId: "session-2")
    try await secondConnect.value
  }

  // MARK: a claim whose socket fails

  private func claimingClient(
    firstConnectFails error: (@Sendable () -> Error)? = nil
  ) async throws -> (client: AppductClient, transport: FakeTransportSession, timers: FakeClientTimers, connect: Task<Void, Error>) {
    let timers = FakeClientTimers(startMs: 1_700_000_000_000, random: 0.5)
    let (client, transport) = makeClient(timers: timers)
    transport.failNextConnectOnce = error
    let input = connectInput(expiresAt: 1_700_000_300)
    let connect = Task { try await client.connect(input) }
    try await waitUntil("the first claim attempt reached the transport") { transport.isWired && transport.connectCallCount >= 1 }
    await allowQueuedWorkToRun()
    return (client, transport, timers, connect)
  }

  private static let refusedSocket: @Sendable () -> Error = {
    AppductSocketConnectError(underlying: NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost))
  }

  private func pinMismatchDetails() -> AppductErrorDetails {
    AppductErrorDetails(
      code: "pin_mismatch",
      message: "Appduct host certificate pin mismatch.",
      phase: "tls",
      nativeCode: "pin_mismatch",
      closeReason: nil,
      isRetryable: false,
      hint: nil
    )
  }

  func testAClaimWhoseSocketFailedKeepsWaitingOutItsBackoffWhenTheCloseEventArrivesLate() async throws {
    let (client, transport, timers, connect) = try await claimingClient(firstConnectFails: Self.refusedSocket)

    transport.simulateClose(code: nil, reason: nil)
    await allowQueuedWorkToRun()
    let state = await client.state
    XCTAssertEqual(state, .connecting)

    timers.advance(byMs: 250)
    try await waitUntil("the claim was tried again") { transport.connectCallCount >= 2 }
    transport.simulateAck(sessionId: "session-1")
    try await connect.value
  }

  func testAClaimWhoseSocketFailedIsNotRetriedBeforeTheCloseEventArrives() async throws {
    let (client, transport, timers, connect) = try await claimingClient(firstConnectFails: Self.refusedSocket)

    timers.advance(byMs: 60_000)
    await allowQueuedWorkToRun()
    guard transport.connectCallCount == 1 else {
      XCTFail("the claim was tried again before the failed socket's close event: \(transport.connectCallCount) attempts")
      await client.disconnect()
      _ = await connect.result
      return
    }

    transport.simulateClose(code: nil, reason: nil)
    await allowQueuedWorkToRun()
    timers.advance(byMs: 250)
    try await waitUntil("the claim was tried again") { transport.connectCallCount >= 2 }
    transport.simulateAck(sessionId: "session-1")
    try await connect.value
    let state = await client.state
    XCTAssertEqual(state, .active)
    XCTAssertEqual(transport.connectCallCount, 2)
  }

  func testAClaimWhoseConnectFailedOnAPinMismatchIsNotRetried() async throws {
    let (client, transport, timers, connect) = try await claimingClient(firstConnectFails: Self.refusedSocket)
    transport.emitError?(pinMismatchDetails())
    transport.simulateClose(code: nil, reason: nil)
    await allowQueuedWorkToRun()
    timers.advance(byMs: 60_000)
    await allowQueuedWorkToRun()

    let state = await client.state
    let attempts = transport.connectCallCount
    await client.disconnect()
    _ = await connect.result
    XCTAssertEqual(state, .closed)
    XCTAssertEqual(attempts, 1)
  }

  func testAClaimThatFailsOnAPinMismatchIsNotRetried() async throws {
    let (client, transport, timers, connect) = try await claimingClient()
    // A pin failure cancels the TLS challenge; the daemon never sees a claim.
    transport.emitError?(pinMismatchDetails())
    transport.simulateClose(code: nil, reason: nil)
    await allowQueuedWorkToRun()
    timers.advance(byMs: 60_000)
    await allowQueuedWorkToRun()

    let state = await client.state
    let attempts = transport.connectCallCount
    // A claim that is still being retried would wait for an ack for ever.
    await client.disconnect()
    _ = await connect.result
    XCTAssertEqual(state, .closed)
    XCTAssertEqual(attempts, 1)
  }

  func testAClaimThatTheTransportRefusedAsMisconfiguredIsNotRetried() async throws {
    let (client, transport, timers, connect) = try await claimingClient(firstConnectFails: {
      NSError(domain: "config", code: 1, userInfo: [NSLocalizedDescriptionKey: "Appduct only allows local IPv4 addresses."])
    })
    timers.advance(byMs: 60_000)
    await allowQueuedWorkToRun()

    let state = await client.state
    let attempts = transport.connectCallCount
    // A claim that is still being retried would wait for an ack for ever.
    await client.disconnect()
    _ = await connect.result
    XCTAssertEqual(state, .closed)
    XCTAssertEqual(attempts, 1)
  }

  // MARK: disconnect

  func testDisconnectAbortsAnInFlightToolHandler() async throws {
    let handlerStarted = XCTestExpectation(description: "handler started")
    let handlerCancelled = XCTestExpectation(description: "handler cancelled")
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "slow", description: "x")) { _, _ in
      handlerStarted.fulfill()
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_000_000)
      }
      handlerCancelled.fulfill()
      return .null
    }
    transport.simulateIncoming(toolCallText(id: "call-1", name: "slow"))
    await fulfillment(of: [handlerStarted], timeout: 2)

    await client.disconnect()

    await fulfillment(of: [handlerCancelled], timeout: 2)
  }

  func testDisconnectClosesAndClearsSession() async throws {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    let sessionChanges = EventCollector<AppductSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    await client.disconnect()

    let state = await client.state
    XCTAssertEqual(state, .closed)
    let sessionId = await client.sessionId
    XCTAssertNil(sessionId)
    XCTAssertEqual(sessionChanges.last?.sessionId, nil)
    XCTAssertEqual(sessionChanges.last?.alias, nil)
    XCTAssertEqual(sessionChanges.last?.type, .lost)
    XCTAssertEqual(sessionChanges.last?.reason, "closed_by_app")
  }

  // MARK: reconnect / grace

  func testTransportCloseSchedulesReconnectWithinGrace() async throws {
    let timers = FakeClientTimers()
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client moved to reconnecting after the socket closed") {
      await client.state == .reconnecting
    }

    let state = await client.state
    XCTAssertEqual(state, .reconnecting)
    XCTAssertGreaterThan(timers.pendingCount, 0)
  }

  func testReconnectSucceedsAfterBackoffFires() async throws {
    let timers = FakeClientTimers(random: 0)
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", resumeToken: "resume-1", graceS: 120)
    try await connectTask.value

    let sessionChanges = EventCollector<AppductSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client moved to reconnecting after the socket closed") {
      await client.state == .reconnecting
    }
    let stateAfterClose = await client.state
    XCTAssertEqual(stateAfterClose, .reconnecting)

    // Fire the scheduled reconnect timer; the resume attempt re-simulates an ack.
    timers.advance(byMs: AppductBackoff.capMs)
    try await waitUntil("the resume attempt started a second transport handshake") {
      transport.isWired && transport.connectCallCount >= 2
    }
    transport.simulateAck(sessionId: "session-1", resumeToken: "resume-2", graceS: 120)
    try await waitUntil("the client went active again after the resume ack") {
      await client.state == .active
    }

    let stateAfterResume = await client.state
    XCTAssertEqual(stateAfterResume, .active)
    XCTAssertEqual(sessionChanges.last?.type, .resumed)
    XCTAssertEqual(sessionChanges.last?.sessionId, "session-1")
    XCTAssertNil(sessionChanges.last?.reason)
  }

  // MARK: link pin carried across a resume (issue #136)

  /// A build that trusts the link's pin (`trust: link`, no embedded pins) has nowhere else to
  /// get one for a resume -- `configureFromBundle` throws `.linkTrustRequiresLinkPin` before a
  /// socket even opens unless the pin the original claim trusted rides along.
  func testResumeAfterSocketLossCarriesTheOriginalLinkPin() async throws {
    let timers = FakeClientTimers(random: 0)
    let (client, transport) = makeClient(timers: timers)
    let pin = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    let connectTaskInput = connectInput(linkPin: pin)
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client moved to reconnecting after the socket closed") {
      await client.state == .reconnecting
    }

    timers.advance(byMs: AppductBackoff.capMs)
    try await waitUntil("the resume attempt started a second transport handshake") {
      transport.isWired && transport.connectCallCount >= 2
    }

    XCTAssertEqual(transport.lastConnectOptions?.linkPin, pin)
  }

  /// A resume ack rotates the resume token; the pin has to survive that, or only the first
  /// resume of a session ever works.
  func testSecondResumeStillCarriesTheOriginalLinkPin() async throws {
    let timers = FakeClientTimers(random: 0)
    let (client, transport) = makeClient(timers: timers)
    let pin = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    let connectTaskInput = connectInput(linkPin: pin)
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", resumeToken: "resume-1", graceS: 120)
    try await connectTask.value

    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client moved to reconnecting after the socket closed") {
      await client.state == .reconnecting
    }
    timers.advance(byMs: AppductBackoff.capMs)
    try await waitUntil("the first resume attempt started a transport handshake") {
      transport.isWired && transport.connectCallCount >= 2
    }
    transport.simulateAck(sessionId: "session-1", resumeToken: "resume-2", graceS: 120)
    try await waitUntil("the client went active again after the resume ack") {
      await client.state == .active
    }

    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client moved to reconnecting after the second close") {
      await client.state == .reconnecting
    }
    timers.advance(byMs: AppductBackoff.capMs)
    try await waitUntil("the second resume attempt started a transport handshake") {
      transport.isWired && transport.connectCallCount >= 3
    }

    XCTAssertEqual(transport.lastConnectOptions?.linkPin, pin)
  }

  /// Control for the fix above: a build with embedded pins never carried a link pin in the first
  /// place, so a resume must keep connecting with `linkPin` absent, exactly as before.
  func testResumeWithNoLinkPinStaysPinless() async throws {
    let timers = FakeClientTimers(random: 0)
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client moved to reconnecting after the socket closed") {
      await client.state == .reconnecting
    }

    timers.advance(byMs: AppductBackoff.capMs)
    try await waitUntil("the resume attempt started a second transport handshake") {
      transport.isWired && transport.connectCallCount >= 2
    }

    XCTAssertNil(transport.lastConnectOptions?.linkPin)
  }

  /// A failed resume attempt no longer reports a bare "Appduct resume attempt failed." -- the
  /// underlying cause (here, the transport's own rejection) rides along in the message.
  func testFailedResumeAttemptReportsItsUnderlyingCause() async throws {
    struct BoomError: Error, LocalizedError {
      var errorDescription: String? { "boom: no pin to trust" }
    }

    let timers = FakeClientTimers(random: 0)
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    let errors = EventCollector<AppductUnifiedErrorEvent>()
    _ = await client.onError { event in errors.append(event) }

    transport.connectError = { BoomError() }
    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client moved to reconnecting after the socket closed") {
      await client.state == .reconnecting
    }

    timers.advance(byMs: AppductBackoff.capMs)
    try await waitUntil("the failed resume attempt reported its cause") {
      errors.all.contains { $0.message.contains("boom: no pin to trust") }
    }
  }

  func testGraceExpiryFinalizesSessionAsLost() async throws {
    let timers = FakeClientTimers()
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", graceS: 10)
    try await connectTask.value

    let sessionChanges = EventCollector<AppductSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client moved to reconnecting after the socket closed") {
      await client.state == .reconnecting
    }
    let stateAfterClose = await client.state
    XCTAssertEqual(stateAfterClose, .reconnecting)

    timers.advance(byMs: 10_000)
    try await waitUntil("the grace window expired and closed the session") {
      await client.state == .closed
    }

    let stateAfterGraceExpiry = await client.state
    XCTAssertEqual(stateAfterGraceExpiry, .closed)
    let sessionIdAfterGraceExpiry = await client.sessionId
    XCTAssertNil(sessionIdAfterGraceExpiry)
    XCTAssertEqual(sessionChanges.last?.type, .lost)
    XCTAssertEqual(sessionChanges.last?.reason, "grace_expired")
  }

  func testTerminalCloseDuringActiveSessionIsNotRetried() async throws {
    let timers = FakeClientTimers()
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    let sessionChanges = EventCollector<AppductSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    transport.simulateClose(code: 1_008, reason: "unknown_session")
    try await waitUntil("the terminal close finalized the session") {
      await client.state == .closed
    }

    let state = await client.state
    XCTAssertEqual(state, .closed)
    XCTAssertEqual(timers.pendingCount, 0)
    XCTAssertEqual(sessionChanges.last?.sessionId, nil)
    XCTAssertEqual(sessionChanges.last?.type, .lost)
    XCTAssertEqual(sessionChanges.last?.reason, "unknown_session")
  }

  func testRevokedCloseFinalizesImmediately() async throws {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    let sessionChanges = EventCollector<AppductSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    transport.simulateClose(code: 1_000, reason: nil)
    try await waitUntil("the revoked close finalized the session") {
      await client.state == .closed
    }

    let state = await client.state
    XCTAssertEqual(state, .closed)
    XCTAssertEqual(sessionChanges.last?.type, .lost)
    XCTAssertEqual(sessionChanges.last?.reason, "revoked")
  }

  // MARK: tool registry wire deltas

  func testRegisterToolWhileActiveSendsUpsertDelta() async throws {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    try client.registerTool(ToolDescriptor(name: "new_tool", description: "x"), handler: { _, _ in .null })
    try await waitUntil("the upsert delta reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_registry_delta") && $0.contains("upsert") }
    }

    let delta = transport.sentMessages.first { $0.contains("tool_registry_delta") && $0.contains("upsert") }
    XCTAssertNotNil(delta)
  }

  func testUnregisterToolWhileActiveSendsRemoveDelta() async throws {
    let (client, transport) = makeClient()
    try client.registerTool(ToolDescriptor(name: "tool_a", description: "x"), handler: { _, _ in .null })
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    client.unregisterTool("tool_a")
    try await waitUntil("the remove delta reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_registry_delta") && $0.contains("remove") }
    }

    let delta = transport.sentMessages.first { $0.contains("tool_registry_delta") && $0.contains("remove") }
    XCTAssertNotNil(delta)
  }

  func testRegisterToolThrowsForInvalidDescriptorAndDoesNotRegister() {
    let (client, _) = makeClient()
    XCTAssertThrowsError(
      try client.registerTool(ToolDescriptor(name: "bad name!", description: "x"), handler: { _, _ in .null })
    )
    XCTAssertEqual(client.registeredTools, [])
  }

  // MARK: tool invocation

  private func toolCallText(id: String, name: String, args: [String: Any] = [:]) -> String {
    let payload: [String: Any] = ["type": "tool_call", "session_id": "session-1", "id": id, "name": name, "args": args]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    return String(data: data, encoding: .utf8)!
  }

  private func toolCancelText(id: String, reason: String = "client_cancelled") -> String {
    let payload: [String: Any] = ["type": "tool_cancel", "session_id": "session-1", "id": id, "reason": reason]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    return String(data: data, encoding: .utf8)!
  }

  private func activeClient(
    timers: FakeClientTimers = FakeClientTimers()
  ) async throws -> (AppductClient, FakeTransportSession) {
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value
    return (client, transport)
  }

  func testUnknownToolNameRespondsWithToolNotFound() async throws {
    let (client, transport) = try await activeClient()
    _ = client

    transport.simulateIncoming(toolCallText(id: "call-1", name: "missing_tool"))
    try await waitUntil("a tool error reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_error") }
    }

    let response = transport.sentMessages.first { $0.contains("tool_error") }
    let response2 = try XCTUnwrap(response)
    XCTAssertTrue(response2.contains("tool_not_found"))
  }

  func testSuccessfulToolCallSendsToolResult() async throws {
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "echo", description: "x")) { args, _ in
      .object(["value": args["value"] ?? .null])
    }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "echo", args: ["value": "hi"]))
    try await waitUntil("the tool result reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_result") }
    }

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_result") })
    XCTAssertTrue(response.contains("\"value\":\"hi\""))
  }

  func testThrowingHandlerSendsToolExecutionError() async throws {
    struct Boom: Error {}
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "boom", description: "x")) { _, _ in throw Boom() }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "boom"))
    try await waitUntil("a tool error reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_error") }
    }

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_error") })
    XCTAssertTrue(response.contains("tool_execution_error"))
  }

  func testTypedHandlerErrorIsForwardedVerbatim() async throws {
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "bad_input", description: "x")) { _, _ in
      throw AppductToolHandlerError(type: "tool_input_validation_error", message: "nope")
    }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "bad_input"))
    try await waitUntil("a tool error reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_error") }
    }

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_error") })
    XCTAssertTrue(response.contains("tool_input_validation_error"))
  }

  func testCancelledHandlerSendsToolCancelled() async throws {
    let handlerStarted = XCTestExpectation(description: "handler started")
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "slow", description: "x")) { _, _ in
      handlerStarted.fulfill()
      while !Task.isCancelled {
        try await Task.sleep(nanoseconds: 1_000_000)
      }
      try Task.checkCancellation()
      return .null
    }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "slow"))
    await fulfillment(of: [handlerStarted], timeout: 2)

    transport.simulateIncoming(toolCancelText(id: "call-1"))
    try await waitUntil("the cancelled tool answered with an error frame") {
      transport.sentMessages.contains { $0.contains("tool_error") }
    }

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_error") })
    XCTAssertTrue(response.contains("tool_cancelled"))
  }

  func testTimeoutSendsToolTimeoutAndIgnoresLateResult() async throws {
    let timers = FakeClientTimers()
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    let handlerStarted = XCTestExpectation(description: "handler started")
    let handlerFinished = XCTestExpectation(description: "handler finished after timeout")
    let gate = Gate()
    try client.registerTool(
      ToolDescriptor(name: "slow", description: "x", timeoutMs: 1_000)
    ) { _, _ in
      // Never observes cancellation -- resolves normally, well after the timeout already
      // answered, once the test opens `gate`.
      handlerStarted.fulfill()
      await gate.wait()
      handlerFinished.fulfill()
      return .string("late")
    }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "slow"))
    await fulfillment(of: [handlerStarted], timeout: 2)

    timers.advance(byMs: 1_000)
    try await waitUntil("the timeout answered the call") {
      transport.sentMessages.contains { $0.contains("tool_timeout") }
    }

    gate.open()
    await fulfillment(of: [handlerFinished], timeout: 2)
    // Negative assertion below ("the late result is dropped"): there is no frame to wait for, so
    // this is a deliberate bounded pause giving the late resolution every chance to (wrongly)
    // reach the wire before the assertions run.
    await allowQueuedWorkToRun()

    let toolErrorMessages = transport.sentMessages.filter { $0.contains("tool_error") }
    XCTAssertEqual(toolErrorMessages.count, 1)
    XCTAssertTrue(toolErrorMessages[0].contains("tool_timeout"))
    // No `tool_result` for the late, ignored resolution.
    XCTAssertFalse(transport.sentMessages.contains { $0.contains("tool_result") })
  }

  func testUnserializableResultSendsToolSerializationError() async throws {
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "nan_tool", description: "x")) { _, _ in
      .number(.nan)
    }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "nan_tool"))
    try await waitUntil("a tool error reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_error") }
    }

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_error") })
    XCTAssertTrue(response.contains("tool_serialization_error"))
  }

  func testProgressReportSendsToolCallProgress() async throws {
    let progressSent = XCTestExpectation(description: "progress sent")
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "progressive", description: "x")) { _, context in
      await context.reportProgress(progress: 0.5, message: "halfway")
      progressSent.fulfill()
      return .null
    }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "progressive"))
    await fulfillment(of: [progressSent], timeout: 2)
    try await waitUntil("the progress frame reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_call_progress") }
    }

    let progressMessage = transport.sentMessages.first { $0.contains("tool_call_progress") }
    XCTAssertNotNil(progressMessage)
  }

  // MARK: postEvent

  func testPostEventSendsEventFrameWhileActive() async throws {
    let (client, transport) = try await activeClient()
    try await client.postEvent("greeting", payload: .string("hi"))
    try await waitUntil("the event frame reached the wire") {
      transport.sentMessages.contains { $0.contains("\"type\":\"event\"") }
    }

    let event = try XCTUnwrap(transport.sentMessages.first { $0.contains("\"type\":\"event\"") })
    XCTAssertTrue(event.contains("greeting"))
  }

  func testPostEventStampsTheEventWithUnixMillisecondsNotSeconds() async throws {
    // PROTOCOL.md §4's `"ts": 1752600000000`: the same unit Kotlin sends
    // (`System.currentTimeMillis()`), because the daemon forwards this value to agents verbatim.
    let nowMs = 1_752_600_000_000
    let (client, transport) = try await activeClient(timers: FakeClientTimers(startMs: Double(nowMs)))
    try await client.postEvent("greeting")
    try await waitUntil("the event frame reached the wire") {
      transport.sentMessages.contains { $0.contains("\"type\":\"event\"") }
    }

    let text = try XCTUnwrap(transport.sentMessages.first { $0.contains("\"type\":\"event\"") })
    let frame = try JSONValue.parse(text)
    XCTAssertEqual(frame.objectValue?["ts"]?.doubleValue, Double(nowMs))
  }

  func testPostEventThrowsWhenNotActive() async {
    let (client, _) = makeClient()
    do {
      try await client.postEvent("greeting")
      XCTFail("expected an error")
    } catch is AppductClient.AppductNotActiveError {
      // expected
    } catch {
      XCTFail("wrong error type: \(error)")
    }
  }

  // MARK: handleUrl

  private func bootstrapUrl(sessionId: String = "session-1", expiresAt: Int = 9_999_999_999) -> String {
    var bytes: [UInt8] = [0x02, 0x04]
    bytes += [192, 168, 1, 10]
    bytes += [0x20, 0xfb] // port 8443
    let sessionIdBytes = Array(sessionId.utf8)
    bytes.append(UInt8(sessionIdBytes.count))
    bytes += sessionIdBytes
    bytes += [UInt8](repeating: 7, count: 32)
    for shift in stride(from: 56, through: 0, by: -8) {
      bytes.append(UInt8((expiresAt >> shift) & 0xff))
    }
    let payload = Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    return "myapp://open?appduct=\(payload)"
  }

  func testHandleUrlReturnsFalseForUnrelatedUrl() {
    let (client, _) = makeClient()
    XCTAssertFalse(client.handleUrl("myapp://open?other=1"))
  }

  func testHandleUrlReturnsTrueAndConnectsForValidLink() async throws {
    let (client, transport) = makeClient()
    XCTAssertTrue(client.handleUrl(bootstrapUrl(sessionId: "session-9")))
    try await waitUntil("the deep link reached the transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-9")
    try await waitUntil("the client went active after the ack") { await client.state == .active }

    let state = await client.state
    XCTAssertEqual(state, .active)
  }

  func testHandleUrlEmitsBootstrapErrorForMalformedPayload() async throws {
    let (client, _) = makeClient()
    let errors = EventCollector<AppductUnifiedErrorEvent>()
    _ = await client.onError { errors.append($0) }

    XCTAssertTrue(client.handleUrl("myapp://open?appduct=not-valid-base64url!!"))
    try await waitUntil("the bootstrap parse failure was reported to the error listener") {
      errors.first != nil
    }

    XCTAssertEqual(errors.first?.phase, "bootstrap")
  }

  func testHandleUrlSupersedesAHeldSession() async throws {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput(sessionId: "session-1")
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    XCTAssertTrue(client.handleUrl(bootstrapUrl(sessionId: "session-2")))
    try await waitUntil("the superseding link started a second transport handshake") {
      transport.isWired && transport.connectCallCount >= 2
    }
    transport.simulateAck(sessionId: "session-2")
    // `sessionId` alone would be satisfied by `connectingSessionId` the moment the superseding
    // connect starts, so this waits for the ack to have actually been applied.
    try await waitUntil("the client holds the superseding session") {
      let state = await client.state
      let sessionId = await client.sessionId
      return state == .active && sessionId == "session-2"
    }

    let sessionId = await client.sessionId
    XCTAssertEqual(sessionId, "session-2")
  }

  func testHandleUrlIgnoresRedeliveryOfTheAlreadyHeldSession() async throws {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput(sessionId: "session-1")
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    let countBefore = transport.connectCallCount
    XCTAssertTrue(client.handleUrl(bootstrapUrl(sessionId: "session-1")))
    // Negative assertion: a re-delivered link for the session already held must *not* reconnect,
    // so there is no condition to wait for -- a deliberate bounded pause gives the deep-link task
    // every chance to (wrongly) reach `transport.connect` before the count is re-read.
    await allowQueuedWorkToRun()

    XCTAssertEqual(transport.connectCallCount, countBefore)
  }

  // MARK: restoreSession

  func testRestoreSessionReturnsFalseWithNoLease() async {
    let (client, _) = makeClient()
    let restored = await client.restoreSession()
    XCTAssertFalse(restored)
  }

  func testRestoreSessionStartsResumeFromAValidLease() async throws {
    let ownerGeneration = AppductProcessResumeLeaseStore.shared.newOwnerGeneration()
    AppductProcessResumeLeaseStore.shared.replace(
      ownerGeneration: ownerGeneration,
      lease: AppductResumeLeaseV1(
        sessionId: "session-restored",
        resumeToken: "resume-token",
        alias: "iphone-1",
        endpoint: AppductResumeEndpoint(ip: "192.168.1.10", port: 8_443),
        keepaliveIntervalS: 30,
        graceS: 120,
        disconnectedAtMs: nil,
        linkPin: nil
      )
    )

    let timers = FakeClientTimers()
    let (client, transport) = makeClient(timers: timers)
    let restored = await client.restoreSession()
    XCTAssertTrue(restored)
    try await waitUntil("the resume attempt started a transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-restored", resumeToken: "resume-token-2")
    try await waitUntil("the client went active after the resume ack") { await client.state == .active }

    let state = await client.state
    XCTAssertEqual(state, .active)
  }

  /// A lease written by a pinned claim (issue #136) must resume with that same pin after a
  /// JS reload -- `restoreSession` has no claim/deep-link to read a pin from, only the
  /// lease, so the lease itself has to carry it.
  func testRestoreSessionFromAPinnedLeaseResumesWithThatPin() async throws {
    let pin = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    let ownerGeneration = AppductProcessResumeLeaseStore.shared.newOwnerGeneration()
    AppductProcessResumeLeaseStore.shared.replace(
      ownerGeneration: ownerGeneration,
      lease: AppductResumeLeaseV1(
        sessionId: "session-restored",
        resumeToken: "resume-token",
        alias: "iphone-1",
        endpoint: AppductResumeEndpoint(ip: "192.168.1.10", port: 8_443),
        keepaliveIntervalS: 30,
        graceS: 120,
        disconnectedAtMs: nil,
        linkPin: pin
      )
    )

    let timers = FakeClientTimers()
    let (client, transport) = makeClient(timers: timers)
    let restored = await client.restoreSession()
    XCTAssertTrue(restored)
    try await waitUntil("the resume attempt started a transport handshake") { transport.isWired && transport.connectCallCount >= 1 }

    XCTAssertEqual(transport.lastConnectOptions?.linkPin, pin)
  }

  func testRestoreSessionReturnsFalseForAnExpiredLease() async {
    let ownerGeneration = AppductProcessResumeLeaseStore.shared.newOwnerGeneration()
    AppductProcessResumeLeaseStore.shared.replace(
      ownerGeneration: ownerGeneration,
      lease: AppductResumeLeaseV1(
        sessionId: "session-restored",
        resumeToken: "resume-token",
        alias: "iphone-1",
        endpoint: AppductResumeEndpoint(ip: "192.168.1.10", port: 8_443),
        keepaliveIntervalS: 30,
        graceS: 1,
        disconnectedAtMs: 0,
        linkPin: nil
      )
    )

    // Clock starts well past `disconnectedAtMs + graceS * 1000` so the lease is already expired.
    let timers = FakeClientTimers(startMs: 60_000)
    let (client, _) = makeClient(timers: timers)
    let restored = await client.restoreSession()
    XCTAssertFalse(restored)
  }

  // MARK: foreground resume (issue #136)

  /// Returning to the foreground while `reconnecting` fires an immediate resume attempt
  /// (`handleForegroundChange`) -- that attempt must carry the original link pin exactly like a
  /// timer-driven one does, using a fake foreground observer the test can flip on demand rather
  /// than a real `UIApplication` notification.
  func testForegroundResumeCarriesTheOriginalLinkPin() async throws {
    let timers = FakeClientTimers(random: 0)
    let foregroundObserver = FakeForegroundObserver()
    let (client, transport) = makeClient(timers: timers, foregroundObserver: foregroundObserver)
    let pin = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    let connectTaskInput = connectInput(linkPin: pin)
    let connectTask = Task { try await client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    // Background the app first: `scheduleReconnectAttempt` skips its timer while backgrounded,
    // so the only thing that can trigger the resume below is the foreground transition itself.
    foregroundObserver.simulateForegroundChange(background: true)
    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client moved to reconnecting after the socket closed") {
      await client.state == .reconnecting
    }
    // No reconnect timer while backgrounded (only the grace timer): the only thing that can
    // still trigger a resume attempt from here is the foreground transition itself.
    XCTAssertEqual(transport.connectCallCount, 1)

    foregroundObserver.simulateForegroundChange(background: false)
    try await waitUntil("returning to the foreground started a resume attempt") {
      transport.isWired && transport.connectCallCount >= 2
    }

    XCTAssertEqual(transport.lastConnectOptions?.linkPin, pin)
  }

  // MARK: background time (issues #138, #139)

  private struct BackgroundRig {
    let client: AppductClient
    let transport: FakeTransportSession
    let observer: FakeForegroundObserver
    let backgroundTime: FakeAppductBackgroundTime
    let timers: FakeClientTimers
  }

  private func activeBackgroundRig() async throws -> BackgroundRig {
    let timers = FakeClientTimers(random: 0)
    let observer = FakeForegroundObserver()
    let backgroundTime = FakeAppductBackgroundTime()
    let (client, transport) = makeClient(timers: timers, foregroundObserver: observer, backgroundTime: backgroundTime)
    let input = connectInput()
    let connectTask = Task { try await client.connect(input) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", resumeToken: "resume-1", graceS: 120)
    try await connectTask.value
    return BackgroundRig(client: client, transport: transport, observer: observer, backgroundTime: backgroundTime, timers: timers)
  }

  func testBackgroundingAnActiveSessionHoldsBackgroundTimeAndKeepsTheSocketOpen() async throws {
    let rig = try await activeBackgroundRig()

    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    XCTAssertEqual(rig.transport.closeForBackgroundCallCount, 0)
    XCTAssertEqual(rig.transport.closeCallCount, 0)
    let state = await rig.client.state
    XCTAssertEqual(state, .active)
  }

  func testAToolCallArrivingWhileBackgroundTimeIsHeldIsAnsweredOnTheSameSocket() async throws {
    let rig = try await activeBackgroundRig()
    try rig.client.registerTool(ToolDescriptor(name: "echo", description: "x")) { args, _ in
      .object(["value": args["value"] ?? .null])
    }
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    rig.transport.simulateIncoming(toolCallText(id: "call-1", name: "echo", args: ["value": "hi"]))

    try await waitUntil("the tool result reached the wire") {
      rig.transport.sentMessages.contains { $0.contains("tool_result") }
    }
    XCTAssertEqual(rig.transport.connectCallCount, 1)
    XCTAssertEqual(rig.backgroundTime.held, 1)
  }

  func testACallInFlightWhenTheAppIsBackgroundedCompletesWhileBackgroundTimeIsHeld() async throws {
    let rig = try await activeBackgroundRig()
    let started = XCTestExpectation(description: "handler started")
    let gate = AsyncGate()
    try rig.client.registerTool(ToolDescriptor(name: "slow", description: "x")) { _, _ in
      started.fulfill()
      await gate.wait()
      return .string("done")
    }
    rig.transport.simulateIncoming(toolCallText(id: "call-1", name: "slow"))
    await fulfillment(of: [started], timeout: 2)

    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }
    await gate.open()

    try await waitUntil("the tool result reached the wire") {
      rig.transport.sentMessages.contains { $0.contains("tool_result") }
    }
    let response = try XCTUnwrap(rig.transport.sentMessages.first { $0.contains("tool_result") })
    XCTAssertTrue(response.contains("done"))
    XCTAssertEqual(rig.backgroundTime.held, 1)
  }

  func testWhenBackgroundTimeExpiresTheClientClosesForBackgroundKeepsTheLeaseAndSchedulesNoReconnect() async throws {
    let rig = try await activeBackgroundRig()
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    rig.backgroundTime.expire()

    try await waitUntil("the client closed the socket for the background") {
      rig.transport.closeForBackgroundCallCount == 1
    }
    try await waitUntil("the client moved to reconnecting") { await rig.client.state == .reconnecting }
    // `close()` would clear the resume lease; the session must stay resumable.
    XCTAssertEqual(rig.transport.closeCallCount, 0)
    rig.timers.advance(byMs: AppductBackoff.capMs)
    XCTAssertEqual(rig.transport.connectCallCount, 1)
  }

  func testWhenBackgroundTimeExpiresACallStillInFlightIsCancelledAsSessionSuspended() async throws {
    let rig = try await activeBackgroundRig()
    let started = XCTestExpectation(description: "handler started")
    let reason = ReasonBox()
    try rig.client.registerTool(ToolDescriptor(name: "slow", description: "x")) { _, context in
      started.fulfill()
      while !Task.isCancelled { try? await Task.sleep(nanoseconds: 1_000_000) }
      reason.set(await context.cancelReason())
      throw CancellationError()
    }
    rig.transport.simulateIncoming(toolCallText(id: "call-1", name: "slow"))
    await fulfillment(of: [started], timeout: 2)
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    rig.backgroundTime.expire()

    try await waitUntil("the handler saw its cancellation") { reason.value != nil }
    XCTAssertEqual(reason.value, "session_suspended")
  }

  func testBackgroundTimeEndsOnlyOnceTheCloseEventHasArrived() async throws {
    let rig = try await activeBackgroundRig()
    rig.transport.holdBackgroundClose = true
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    rig.backgroundTime.expire()
    try await waitUntil("the client closed the socket for the background") {
      rig.transport.closeForBackgroundCallCount == 1
    }
    try await Task.sleep(nanoseconds: 50_000_000)
    XCTAssertEqual(rig.backgroundTime.held, 1)

    rig.transport.simulateClose(code: 1_001, reason: "app_backgrounded")

    try await waitUntil("the background time ended") { rig.backgroundTime.held == 0 }
  }

  func testWindowEndCloseEmitsNoErrorEvent() async throws {
    let rig = try await activeBackgroundRig()
    let errors = EventCollector<AppductUnifiedErrorEvent>()
    _ = await rig.client.onError { errors.append($0) }
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    rig.backgroundTime.expire()
    try await waitUntil("the client moved to reconnecting") { await rig.client.state == .reconnecting }

    XCTAssertEqual(errors.all.count, 0)
  }

  func testForegroundingAfterTheWindowEndsResumesTheSession() async throws {
    let rig = try await activeBackgroundRig()
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }
    rig.backgroundTime.expire()
    try await waitUntil("the client moved to reconnecting") { await rig.client.state == .reconnecting }

    rig.observer.simulateForegroundChange(background: false)

    try await waitUntil("returning to the foreground started a resume attempt") { rig.transport.connectCallCount >= 2 }
    XCTAssertEqual(rig.transport.lastConnectOptions?.resumeToken, "resume-1")
    rig.transport.simulateAck(sessionId: "session-1", resumeToken: "resume-2", graceS: 120)
    try await waitUntil("the session is active again") { await rig.client.state == .active }
  }

  func testForegroundingBeforeTheWindowEndsEndsTheBackgroundTimeAndKeepsTheSameSocket() async throws {
    let rig = try await activeBackgroundRig()
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    rig.observer.simulateForegroundChange(background: false)

    try await waitUntil("the background time ended") { rig.backgroundTime.held == 0 }
    XCTAssertEqual(rig.transport.connectCallCount, 1)
    XCTAssertEqual(rig.transport.closeForBackgroundCallCount, 0)
    let state = await rig.client.state
    XCTAssertEqual(state, .active)
  }

  func testBackgroundingWithoutAnActiveSessionAsksForNoBackgroundTime() async throws {
    let observer = FakeForegroundObserver()
    let backgroundTime = FakeAppductBackgroundTime()
    let (_, transport) = makeClient(foregroundObserver: observer, backgroundTime: backgroundTime)
    try await waitUntil("the client wired its transport") { transport.isWired }

    observer.simulateForegroundChange(background: true)
    try await Task.sleep(nanoseconds: 100_000_000)

    XCTAssertEqual(backgroundTime.beginCallCount, 0)
    XCTAssertEqual(transport.closeForBackgroundCallCount, 0)
  }

  func testDisconnectEndsTheBackgroundTime() async throws {
    let rig = try await activeBackgroundRig()
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    await rig.client.disconnect()

    XCTAssertEqual(rig.backgroundTime.held, 0)
  }

  func testDestroyEndsTheBackgroundTime() async throws {
    let rig = try await activeBackgroundRig()
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    await rig.client.destroy()

    XCTAssertEqual(rig.backgroundTime.held, 0)
  }

  func testDisconnectKeepsTheBackgroundTimeUntilTheSocketIsClosed() async throws {
    let rig = try await activeBackgroundRig()
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }
    let heldWhenClosing = EventCollector<Int>()
    let backgroundTime = rig.backgroundTime
    rig.transport.onClose = { heldWhenClosing.append(backgroundTime.held) }

    await rig.client.disconnect()

    XCTAssertEqual(heldWhenClosing.all, [1])
    XCTAssertEqual(rig.backgroundTime.held, 0)
  }

  func testDestroyKeepsTheBackgroundTimeUntilTheSessionIsInvalidated() async throws {
    let rig = try await activeBackgroundRig()
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }
    let heldWhenInvalidating = EventCollector<Int>()
    let backgroundTime = rig.backgroundTime
    rig.transport.onInvalidate = { heldWhenInvalidating.append(backgroundTime.held) }

    await rig.client.destroy()

    XCTAssertEqual(heldWhenInvalidating.all, [1])
    XCTAssertEqual(rig.backgroundTime.held, 0)
  }

  func testALostSocketEndsTheBackgroundTime() async throws {
    let rig = try await activeBackgroundRig()
    rig.observer.simulateForegroundChange(background: true)
    try await waitUntil("the client asked for background time") { rig.backgroundTime.held == 1 }

    rig.transport.simulateClose(code: 1_006, reason: nil)

    try await waitUntil("the background time ended") { rig.backgroundTime.held == 0 }
  }
}

/// Lets a handler park until the test opens the gate.
private actor AsyncGate {
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  func wait() async {
    if isOpen { return }
    await withCheckedContinuation { waiters.append($0) }
  }
  func open() {
    isOpen = true
    for waiter in waiters { waiter.resume() }
    waiters = []
  }
}

private final class ReasonBox: @unchecked Sendable {
  private let lock = NSLock()
  private var _value: String?
  var value: String? { lock.lock(); defer { lock.unlock() }; return _value }
  func set(_ value: String?) { lock.lock(); _value = value; lock.unlock() }
}
