import XCTest
@testable import AppductCore

/// Covers the plain-app-facing `Appduct` facade (`Real/AppductAPI.swift`, issue #48 phase 3,
/// `docs/tasks/18-ios-entry-points.md`) on top of the same `FakeTransportSession`/`FakeClientTimers`
/// pair `AppductClientTests` uses -- the facade adds a `[String: Any]` boundary and one unified
/// listener stream on top of `AppductClient`, so these tests exercise that boundary rather than
/// re-testing session/reconnect/registry logic already covered there.
final class AppductAPITests: XCTestCase {
  override func setUp() {
    super.setUp()
    AppductProcessResumeLeaseStore.shared.resetForTests()
  }

  private func makeFacade(
    timers: FakeClientTimers = FakeClientTimers()
  ) -> (Appduct, FakeTransportSession) {
    let transport = FakeTransportSession()
    let client = AppductClient(
      transport: transport,
      timers: timers,
      requirePrivateIp: true,
      foregroundObserver: NeverBackgroundedObserver()
    )
    return (Appduct(client: client), transport)
  }

  private func connectInput(sessionId: String = "session-1", expiresAt: Int = 9_999_999_999) -> AppductConnectInput {
    AppductConnectInput(
      ip: "192.168.1.10",
      port: 8_443,
      sessionId: sessionId,
      token: "claim-token",
      expiresAt: expiresAt
    )
  }

  /// Brings a facade to `.active` the same way `AppductClientTests.activeClient()` does, but
  /// through the facade's own underlying client (there is no `connect()` on the facade itself --
  /// a plain app only ever arrives at a session via `handle(_:)`/`restoreSession()`).
  private func activeFacade() async throws -> (Appduct, FakeTransportSession) {
    let (facade, transport) = makeFacade()
    let connectTaskInput = connectInput()
    let connectTask = Task { try await facade.client.connect(connectTaskInput) }
    // A `session_ack` is only picked up once a handshake is actually in flight; the handshake
    // calls `transport.connect` right after arming itself, so this counter is that signal.
    try await waitUntil("the client started its transport handshake") { transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value
    return (facade, transport)
  }

  private func toolCallText(id: String, name: String, args: [String: Any] = [:]) -> String {
    let payload: [String: Any] = ["type": "tool_call", "session_id": "session-1", "id": id, "name": name, "args": args]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    return String(data: data, encoding: .utf8)!
  }

  private func bootstrapUrl(sessionId: String = "session-1", expiresAt: Int = 9_999_999_999) -> URL {
    var bytes: [UInt8] = [0x02, 0x04]
    bytes += [192, 168, 1, 10]
    bytes += [0x20, 0xfb]  // port 8443
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
    return URL(string: "myapp://open?appduct=\(payload)")!
  }

  // MARK: register -- snapshot contains the descriptor

  func testRegisterAddsDescriptorToSnapshot() throws {
    let (facade, _) = makeFacade()

    try facade.register(
      name: "seed_cart",
      description: "Fill the cart with test items.",
      inputSchema: ["type": "object", "properties": ["items": ["type": "number"]], "required": ["items"]]
    ) { _ in ["added": 1] }

    let snapshot = facade.client.registeredTools
    XCTAssertEqual(snapshot.map(\.name), ["seed_cart"])
    XCTAssertEqual(snapshot[0].description, "Fill the cart with test items.")
    XCTAssertEqual(snapshot[0].inputSchema?["type"], .string("object"))
  }

  func testRegisterThrowsForInvalidNameAndDoesNotRegister() {
    let (facade, _) = makeFacade()
    XCTAssertThrowsError(
      try facade.register(name: "bad name!", description: "x") { _ in nil }
    )
    XCTAssertEqual(facade.client.registeredTools, [])
  }

  // MARK: tool call -- handler runs, [String: Any] round-trips, result reaches the wire

  func testToolCallRunsHandlerAndResultReachesTheWire() async throws {
    let (facade, transport) = try await activeFacade()

    try facade.register(name: "echo", description: "x") { args in
      // Round-trips `args["value"]` through the facade's `[String: Any]` boundary and back --
      // proves the conversion is happening in both directions, not just that a call arrived.
      ["value": (args["value"] as? String ?? "") + "!"]
    }

    transport.simulateIncoming(toolCallText(id: "call-1", name: "echo", args: ["value": "hi"]))
    try await waitUntil("the tool result reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_result") }
    }

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_result") })
    XCTAssertTrue(response.contains("\"value\":\"hi!\""))
  }

  func testToolCallContextOverloadReceivesCallMetadata() async throws {
    let (facade, transport) = try await activeFacade()

    try facade.register(name: "with_context", description: "x") { _, context in
      ["toolName": context.toolName]
    }

    transport.simulateIncoming(toolCallText(id: "call-2", name: "with_context"))
    try await waitUntil("the tool result reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_result") }
    }

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_result") })
    XCTAssertTrue(response.contains("with_context"))
  }

  func testUnserializableResultSendsToolSerializationError() async throws {
    let (facade, transport) = try await activeFacade()

    try facade.register(name: "bad_result", description: "x") { _ in Date() }

    transport.simulateIncoming(toolCallText(id: "call-3", name: "bad_result"))
    try await waitUntil("the tool error reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_error") }
    }

    let response = try XCTUnwrap(transport.sentMessages.first { $0.contains("tool_error") })
    XCTAssertTrue(response.contains("tool_serialization_error"))
  }

  // MARK: handle(url) -- routes a valid bootstrap link, ignores an unrelated one

  func testHandleReturnsFalseForUnrelatedUrl() {
    let (facade, _) = makeFacade()
    XCTAssertFalse(facade.handle(URL(string: "myapp://open?other=1")!))
  }

  func testHandleRoutesAValidBootstrapLink() async throws {
    let (facade, transport) = makeFacade()

    XCTAssertTrue(facade.handle(bootstrapUrl(sessionId: "session-9")))
    try await waitUntil("the deep link reached the transport handshake") { transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-9")
    try await waitUntil("the facade snapshot turned active") { facade.state == .active }

    XCTAssertEqual(facade.state, .active)
    XCTAssertEqual(facade.sessionId, "session-9")
  }

  // MARK: remove() -- unregisters and sends the delta

  func testRemoveSendsRegistryDeltaAndDropsTheDescriptor() async throws {
    let (facade, transport) = try await activeFacade()

    let registration = try facade.register(name: "removable", description: "x") { _ in nil }
    try await waitUntil("the upsert delta was sent") {
      transport.sentMessages.contains { $0.contains("tool_registry_delta") && $0.contains("upsert") }
    }

    registration.remove()
    try await waitUntil("the remove delta was sent") {
      transport.sentMessages.contains { $0.contains("tool_registry_delta") && $0.contains("remove") }
    }

    let delta = transport.sentMessages.first { $0.contains("tool_registry_delta") && $0.contains("remove") }
    XCTAssertNotNil(delta)
    XCTAssertEqual(facade.client.registeredTools.map(\.name), [])
  }

  // MARK: addListener -- receives state changes

  func testListenerReceivesStateChangeEvents() async throws {
    let (facade, transport) = makeFacade()

    let events = EventCollector<AppductEvent>()
    let subscription = facade.addListener { events.append($0) }
    // `addListener` registers with the actor asynchronously, and it registers the error channel
    // last -- so once that one is in place, all three are.
    try await waitUntil("the facade's listeners were registered on the client") {
      await facade.client.errorListeners.count >= 1
    }

    let connectTaskInput = connectInput()
    let connectTask = Task { try await facade.client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connectTask.value
    try await waitUntil("the listener saw the active state change") {
      events.all.contains {
        if case .stateChange(let event) = $0 { return event.state == .active }
        return false
      }
    }

    let states: [AppductClientState] = events.all.compactMap {
      if case .stateChange(let event) = $0 { return event.state }
      return nil
    }
    XCTAssertTrue(states.contains(.connecting))
    XCTAssertTrue(states.contains(.active))

    subscription.cancel()
  }

  func testListenerReceivesSessionChangeEvents() async throws {
    let (facade, transport) = makeFacade()

    let events = EventCollector<AppductEvent>()
    _ = facade.addListener { events.append($0) }
    try await waitUntil("the facade's listeners were registered on the client") {
      await facade.client.errorListeners.count >= 1
    }

    let connectTaskInput = connectInput()
    let connectTask = Task { try await facade.client.connect(connectTaskInput) }
    try await waitUntil("the client started its transport handshake") { transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1", alias: "iphone-1")
    try await connectTask.value
    try await waitUntil("the listener saw the session change") {
      events.all.contains {
        if case .sessionChange(let event) = $0 { return event.sessionId == "session-1" }
        return false
      }
    }

    let sessionIds: [String?] = events.all.compactMap {
      if case .sessionChange(let event) = $0 { return event.sessionId }
      return nil
    }
    XCTAssertTrue(sessionIds.contains("session-1"))
  }

  // MARK: buildConfig / state / sessionId snapshots

  func testStateAndSessionIdSnapshotsAreIdleBeforeAnySession() {
    let (facade, _) = makeFacade()
    XCTAssertEqual(facade.state, .idle)
    XCTAssertNil(facade.sessionId)
  }

  func testBuildConfigReflectsCurrentManifestConfig() {
    let (facade, _) = makeFacade()
    // No AppductTrust/CliPins keys in this test bundle's Info.plist, so this resolves to the
    // documented zero-config default -- see `currentAppductBuildConfig()`.
    XCTAssertEqual(facade.buildConfig.trust, "link")
    XCTAssertFalse(facade.buildConfig.hasEmbeddedPins)
  }
}
