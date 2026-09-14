import XCTest
@testable import CordieriteCore

/// Ports the behavioral spec of `client.test.ts`, `tool-invocation.test.ts`,
/// `deep-link-bootstrap.test.ts`, and `resume-lease-native-adapter.test.ts` onto `CordieriteClient`,
/// using `FakeTransportSession`/`FakeClientTimers` in place of a real TLS/WebSocket stack.
final class CordieriteClientTests: XCTestCase {
  override func setUp() {
    super.setUp()
    CordieriteProcessResumeLeaseStore.shared.resetForTests()
  }

  private func makeClient(
    timers: FakeClientTimers = FakeClientTimers(),
    defaultToolTimeoutMs: Int = 10_000
  ) -> (CordieriteClient, FakeTransportSession) {
    let transport = FakeTransportSession()
    let client = CordieriteClient(
      transport: transport,
      timers: timers,
      defaultToolTimeoutMs: defaultToolTimeoutMs,
      requirePrivateIp: true,
      foregroundObserver: NeverBackgroundedObserver()
    )
    return (client, transport)
  }

  private func connectInput(sessionId: String = "session-1", expiresAt: Int = 9_999_999_999) -> CordieriteConnectInput {
    CordieriteConnectInput(
      ip: "192.168.1.10",
      port: 8_443,
      sessionId: sessionId,
      token: "claim-token",
      expiresAt: expiresAt
    )
  }

  // MARK: connect / claim handshake

  func testConnectResolvesOnceAckArrivesAndReportsActive() async throws {
    let (client, transport) = makeClient()

    let sessionChanges = EventCollector<CordieriteSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    await drainPendingTasks()
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
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value
    await drainPendingTasks()

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
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    do {
      try await client.connect(connectInput(sessionId: "session-2"))
      XCTFail("expected an error")
    } catch is CordieriteClient.CordieriteAlreadyConnectingError {
      // expected
    }
  }

  func testConnectWithSupersedeReplacesAnActiveSession() async throws {
    let (client, transport) = makeClient()
    let firstConnectInput = connectInput(sessionId: "session-1")
    let firstConnect = Task { try await client.connect(firstConnectInput) }
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1")
    try await firstConnect.value

    let secondConnectInput = connectInput(sessionId: "session-2")
    let secondConnect = Task { try await client.connect(secondConnectInput, supersede: true) }
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-2")
    try await secondConnect.value

    let sessionId = await client.sessionId
    XCTAssertEqual(sessionId, "session-2")
    XCTAssertGreaterThanOrEqual(transport.closeCallCount, 1)
  }

  // MARK: disconnect

  func testDisconnectClosesAndClearsSession() async throws {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    let sessionChanges = EventCollector<CordieriteSessionChangeEvent>()
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
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    transport.simulateClose(code: 1_006, reason: nil)
    await drainPendingTasks()

    let state = await client.state
    XCTAssertEqual(state, .reconnecting)
    XCTAssertGreaterThan(timers.pendingCount, 0)
  }

  func testReconnectSucceedsAfterBackoffFires() async throws {
    let timers = FakeClientTimers(random: 0)
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1", resumeToken: "resume-1", graceS: 120)
    try await connectTask.value

    let sessionChanges = EventCollector<CordieriteSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    transport.simulateClose(code: 1_006, reason: nil)
    await drainPendingTasks()
    let stateAfterClose = await client.state
    XCTAssertEqual(stateAfterClose, .reconnecting)

    // Fire the scheduled reconnect timer; the resume attempt re-simulates an ack.
    timers.advance(byMs: CordieriteBackoff.capMs)
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1", resumeToken: "resume-2", graceS: 120)
    await drainPendingTasks()

    let stateAfterResume = await client.state
    XCTAssertEqual(stateAfterResume, .active)
    XCTAssertEqual(sessionChanges.last?.type, .resumed)
    XCTAssertEqual(sessionChanges.last?.sessionId, "session-1")
    XCTAssertNil(sessionChanges.last?.reason)
  }

  func testGraceExpiryFinalizesSessionAsLost() async throws {
    let timers = FakeClientTimers()
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1", graceS: 10)
    try await connectTask.value

    let sessionChanges = EventCollector<CordieriteSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    transport.simulateClose(code: 1_006, reason: nil)
    await drainPendingTasks()
    let stateAfterClose = await client.state
    XCTAssertEqual(stateAfterClose, .reconnecting)

    timers.advance(byMs: 10_000)
    await drainPendingTasks()

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
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    let sessionChanges = EventCollector<CordieriteSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    transport.simulateClose(code: 1_008, reason: "unknown_session")
    await drainPendingTasks()

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
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1", graceS: 120)
    try await connectTask.value

    let sessionChanges = EventCollector<CordieriteSessionChangeEvent>()
    _ = await client.onSessionChange { event in sessionChanges.append(event) }

    transport.simulateClose(code: 1_000, reason: nil)
    await drainPendingTasks()

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
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    try client.registerTool(ToolDescriptor(name: "new_tool", description: "x"), handler: { _, _ in .null })
    await drainPendingTasks()

    let delta = transport.sentMessages.first { $0.contains("tool_registry_delta") && $0.contains("upsert") }
    XCTAssertNotNil(delta)
  }

  func testUnregisterToolWhileActiveSendsRemoveDelta() async throws {
    let (client, transport) = makeClient()
    try client.registerTool(ToolDescriptor(name: "tool_a", description: "x"), handler: { _, _ in .null })
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    client.unregisterTool("tool_a")
    await drainPendingTasks()

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

  private func activeClient() async throws -> (CordieriteClient, FakeTransportSession) {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value
    return (client, transport)
  }

  func testUnknownToolNameRespondsWithToolNotFound() async throws {
    let (client, transport) = try await activeClient()
    _ = client

    transport.simulateIncoming(toolCallText(id: "call-1", name: "missing_tool"))
    await drainPendingTasks()

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
    await drainPendingTasks()

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_result") })
    XCTAssertTrue(response.contains("\"value\":\"hi\""))
  }

  func testThrowingHandlerSendsToolExecutionError() async throws {
    struct Boom: Error {}
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "boom", description: "x")) { _, _ in throw Boom() }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "boom"))
    await drainPendingTasks()

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_error") })
    XCTAssertTrue(response.contains("tool_execution_error"))
  }

  func testTypedHandlerErrorIsForwardedVerbatim() async throws {
    let (client, transport) = try await activeClient()
    try client.registerTool(ToolDescriptor(name: "bad_input", description: "x")) { _, _ in
      throw CordieriteToolHandlerError(type: "tool_input_validation_error", message: "nope")
    }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "bad_input"))
    await drainPendingTasks()

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
    await drainPendingTasks(iterations: 40)

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_error") })
    XCTAssertTrue(response.contains("tool_cancelled"))
  }

  func testTimeoutSendsToolTimeoutAndIgnoresLateResult() async throws {
    let timers = FakeClientTimers()
    let (client, transport) = makeClient(timers: timers)
    let connectTaskInput = connectInput()
    let connectTask = Task { try await client.connect(connectTaskInput) }
    await drainPendingTasks()
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
    await drainPendingTasks()

    gate.open()
    await fulfillment(of: [handlerFinished], timeout: 2)
    await drainPendingTasks()

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
    await drainPendingTasks()

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
    await drainPendingTasks()

    let progressMessage = transport.sentMessages.first { $0.contains("tool_call_progress") }
    XCTAssertNotNil(progressMessage)
  }

  // MARK: postEvent

  func testPostEventSendsEventFrameWhileActive() async throws {
    let (client, transport) = try await activeClient()
    try await client.postEvent("greeting", payload: .string("hi"))
    await drainPendingTasks()

    let event = try XCTUnwrap(transport.sentMessages.first { $0.contains("\"type\":\"event\"") })
    XCTAssertTrue(event.contains("greeting"))
  }

  func testPostEventThrowsWhenNotActive() async {
    let (client, _) = makeClient()
    do {
      try await client.postEvent("greeting")
      XCTFail("expected an error")
    } catch is CordieriteClient.CordieriteNotActiveError {
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
    return "myapp://open?cordierite=\(payload)"
  }

  func testHandleUrlReturnsFalseForUnrelatedUrl() {
    let (client, _) = makeClient()
    XCTAssertFalse(client.handleUrl("myapp://open?other=1"))
  }

  func testHandleUrlReturnsTrueAndConnectsForValidLink() async throws {
    let (client, transport) = makeClient()
    XCTAssertTrue(client.handleUrl(bootstrapUrl(sessionId: "session-9")))
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-9")
    await drainPendingTasks()

    let state = await client.state
    XCTAssertEqual(state, .active)
  }

  func testHandleUrlEmitsBootstrapErrorForMalformedPayload() async {
    let (client, _) = makeClient()
    let errors = EventCollector<CordieriteUnifiedErrorEvent>()
    _ = await client.onError { errors.append($0) }

    XCTAssertTrue(client.handleUrl("myapp://open?cordierite=not-valid-base64url!!"))
    await drainPendingTasks()

    XCTAssertEqual(errors.first?.phase, "bootstrap")
  }

  func testHandleUrlSupersedesAHeldSession() async throws {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput(sessionId: "session-1")
    let connectTask = Task { try await client.connect(connectTaskInput) }
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    XCTAssertTrue(client.handleUrl(bootstrapUrl(sessionId: "session-2")))
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-2")
    await drainPendingTasks()

    let sessionId = await client.sessionId
    XCTAssertEqual(sessionId, "session-2")
  }

  func testHandleUrlIgnoresRedeliveryOfTheAlreadyHeldSession() async throws {
    let (client, transport) = makeClient()
    let connectTaskInput = connectInput(sessionId: "session-1")
    let connectTask = Task { try await client.connect(connectTaskInput) }
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value

    let countBefore = transport.connectCallCount
    XCTAssertTrue(client.handleUrl(bootstrapUrl(sessionId: "session-1")))
    await drainPendingTasks()

    XCTAssertEqual(transport.connectCallCount, countBefore)
  }

  // MARK: restoreSession

  func testRestoreSessionReturnsFalseWithNoLease() async {
    let (client, _) = makeClient()
    let restored = await client.restoreSession()
    XCTAssertFalse(restored)
  }

  func testRestoreSessionStartsResumeFromAValidLease() async {
    let ownerGeneration = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    CordieriteProcessResumeLeaseStore.shared.replace(
      ownerGeneration: ownerGeneration,
      lease: CordieriteResumeLeaseV1(
        sessionId: "session-restored",
        resumeToken: "resume-token",
        alias: "iphone-1",
        endpoint: CordieriteResumeEndpoint(ip: "192.168.1.10", port: 8_443),
        keepaliveIntervalS: 30,
        graceS: 120,
        disconnectedAtMs: nil
      )
    )

    let timers = FakeClientTimers()
    let (client, transport) = makeClient(timers: timers)
    let restored = await client.restoreSession()
    XCTAssertTrue(restored)
    await drainPendingTasks()
    transport.simulateAck(sessionId: "session-restored", resumeToken: "resume-token-2")
    await drainPendingTasks()

    let state = await client.state
    XCTAssertEqual(state, .active)
  }

  func testRestoreSessionReturnsFalseForAnExpiredLease() async {
    let ownerGeneration = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    CordieriteProcessResumeLeaseStore.shared.replace(
      ownerGeneration: ownerGeneration,
      lease: CordieriteResumeLeaseV1(
        sessionId: "session-restored",
        resumeToken: "resume-token",
        alias: "iphone-1",
        endpoint: CordieriteResumeEndpoint(ip: "192.168.1.10", port: 8_443),
        keepaliveIntervalS: 30,
        graceS: 1,
        disconnectedAtMs: 0
      )
    )

    // Clock starts well past `disconnectedAtMs + graceS * 1000` so the lease is already expired.
    let timers = FakeClientTimers(startMs: 60_000)
    let (client, _) = makeClient(timers: timers)
    let restored = await client.restoreSession()
    XCTAssertFalse(restored)
  }
}
