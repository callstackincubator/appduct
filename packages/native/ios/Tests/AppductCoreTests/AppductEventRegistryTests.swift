import XCTest
@testable import AppductCore

/// `registerEvent` (issue #126): the event registry frames an SDK sends (`docs/PROTOCOL.md` §5a),
/// observed on a fake transport. The frame scenarios come from
/// `packages/native/fixtures/event-registry-frames.json`, shared with the Kotlin suite.
final class AppductEventRegistryTests: XCTestCase {
  override func setUp() {
    super.setUp()
    AppductProcessResumeLeaseStore.shared.resetForTests()
  }

  private func makeClient(timers: FakeClientTimers = FakeClientTimers()) -> (AppductClient, FakeTransportSession) {
    let transport = FakeTransportSession()
    let client = AppductClient(
      transport: transport,
      timers: timers,
      requirePrivateIp: true,
      foregroundObserver: NeverBackgroundedObserver()
    )
    return (client, transport)
  }

  private func connect(
    _ client: AppductClient,
    _ transport: FakeTransportSession,
    sessionId: String = "session-1",
    eventRegistry: Bool
  ) async throws {
    let input = AppductConnectInput(
      ip: "192.168.1.10",
      port: 8_443,
      sessionId: sessionId,
      token: "claim-token",
      expiresAt: 9_999_999_999
    )
    let connectTask = Task { try await client.connect(input) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: sessionId, eventRegistry: eventRegistry)
    try await connectTask.value
  }

  /// The `event_registry_*` frames sent so far, parsed.
  private func eventFrames(_ transport: FakeTransportSession) -> [JSONValue] {
    transport.sentMessages.compactMap { text in
      guard let value = try? JSONValue.parse(text), value["type"]?.stringValue?.hasPrefix("event_registry_") == true else {
        return nil
      }
      return value
    }
  }

  private func descriptor(_ name: String, description: String = "d") -> EventDescriptor {
    EventDescriptor(name: name, description: description)
  }

  // MARK: fixture

  func testFramesMatchTheSharedFixture() async throws {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("fixtures/event-registry-frames.json")
    let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
    XCTAssertGreaterThan(cases.count, 0)

    for scenario in cases {
      AppductProcessResumeLeaseStore.shared.resetForTests()
      let name = scenario["name"] as! String
      let sessionId = scenario["sessionId"] as! String
      let (client, transport) = makeClient()

      var registrations: [String: EventRegistration] = [:]
      for raw in scenario["declaredBeforeAck"] as! [Any] {
        let event = try parseEventDescriptor(JSONValue.from(foundation: raw))
        registrations[event.name] = try client.registerEvent(event)
      }
      try await connect(client, transport, sessionId: sessionId, eventRegistry: true)

      let expected = (scenario["frames"] as! [Any]).map { JSONValue.from(foundation: $0) }
      for step in scenario["afterAck"] as! [[String: Any]] {
        switch step["op"] as! String {
        case "register":
          let event = try parseEventDescriptor(JSONValue.from(foundation: step["event"]!))
          registrations[event.name] = try client.registerEvent(event)
        case "remove":
          registrations[step["name"] as! String]!.remove()
        default:
          XCTFail("\(name): unknown step")
        }
      }

      try await waitUntil("\(name): the frames reached the wire") { self.eventFrames(transport).count >= expected.count }
      await allowQueuedWorkToRun()
      XCTAssertEqual(eventFrames(transport), expected, name)
    }
  }

  // MARK: behaviour

  func testAckWithoutTheFlagSendsNoEventFrames() async throws {
    let (client, transport) = makeClient()
    let registration = try client.registerEvent(descriptor("a"))
    try await connect(client, transport, eventRegistry: false)
    try client.registerEvent(descriptor("b"))
    registration.remove()
    try await waitUntil("the tool snapshot reached the wire") {
      transport.sentMessages.contains { $0.contains("tool_registry_snapshot") }
    }
    await allowQueuedWorkToRun()

    XCTAssertEqual(eventFrames(transport), [])
  }

  func testEveryAckCarryingTheFlagIsFollowedByASnapshotIncludingAfterResume() async throws {
    let timers = FakeClientTimers(random: 0)
    let (client, transport) = makeClient(timers: timers)
    try client.registerEvent(descriptor("a"))
    try await connect(client, transport, eventRegistry: true)
    try await waitUntil("the first snapshot reached the wire") { self.eventFrames(transport).count == 1 }

    transport.simulateClose(code: 1_006, reason: nil)
    try await waitUntil("the client is reconnecting") { await client.state == .reconnecting }
    try client.registerEvent(descriptor("b"))
    timers.advance(byMs: AppductBackoff.capMs)
    try await waitUntil("the resume handshake started") { transport.isWired && transport.connectCallCount >= 2 }
    transport.simulateAck(sessionId: "session-1", resumeToken: "resume-2", eventRegistry: true)
    try await waitUntil("the snapshot after the resume reached the wire") { self.eventFrames(transport).count == 2 }

    let second = eventFrames(transport)[1]
    XCTAssertEqual(second["type"]?.stringValue, "event_registry_snapshot")
    XCTAssertEqual(second["events"]?.arrayValue?.compactMap { $0["name"]?.stringValue }, ["a", "b"])
  }

  func testRemovingTwiceSendsOneRemoveDelta() async throws {
    let (client, transport) = makeClient()
    let registration = try client.registerEvent(descriptor("a"))
    try await connect(client, transport, eventRegistry: true)
    try await waitUntil("the snapshot reached the wire") { self.eventFrames(transport).count == 1 }

    registration.remove()
    registration.remove()
    try await waitUntil("the remove delta reached the wire") { self.eventFrames(transport).count == 2 }
    await allowQueuedWorkToRun()

    XCTAssertEqual(eventFrames(transport).count, 2)
  }

  func testRemoveThenRegisterOfTheSameNameInALoopEndsWithTheUpsert() async throws {
    let (client, transport) = makeClient()
    var registration = try client.registerEvent(descriptor("a"))
    try await connect(client, transport, eventRegistry: true)

    for _ in 0..<50 {
      registration.remove()
      registration = try client.registerEvent(descriptor("a"))
    }
    try await waitUntil("every frame reached the wire") { self.eventFrames(transport).count >= 101 }
    await allowQueuedWorkToRun()

    let frames = eventFrames(transport)
    XCTAssertEqual(frames.count, 101)
    XCTAssertEqual(frames.last?["operation"]?.stringValue, "upsert")
    let operations = frames.dropFirst().compactMap { $0["operation"]?.stringValue }
    XCTAssertEqual(operations, Array(repeating: ["remove", "upsert"], count: 50).flatMap { $0 })
  }

  func testRegisterEventRejectsAnInvalidDescriptorAndDeclaresNothing() async throws {
    let (client, transport) = makeClient()
    XCTAssertThrowsError(try client.registerEvent(EventDescriptor(name: "", description: "d")))
    XCTAssertThrowsError(try client.registerEvent(EventDescriptor(name: "a", description: "")))
    try await connect(client, transport, eventRegistry: true)
    try await waitUntil("the snapshot reached the wire") { self.eventFrames(transport).count == 1 }

    XCTAssertEqual(eventFrames(transport)[0]["events"]?.arrayValue?.count, 0)
  }

  func testRegisterEventAcceptsADottedNameAndAFullLengthName() throws {
    let (client, _) = makeClient()
    XCTAssertNoThrow(try client.registerEvent(descriptor("cart.item_added")))
    XCTAssertNoThrow(try client.registerEvent(descriptor(String(repeating: "a", count: 4_096))))
    XCTAssertThrowsError(try client.registerEvent(descriptor(String(repeating: "a", count: 4_097))))
  }

  func testFacadeRegisterEventConvertsThePayloadSchemaAndDisposes() async throws {
    let (client, transport) = makeClient()
    let facade = Appduct(client: client)
    let registration = try facade.registerEvent(
      name: "checkout_completed",
      description: "Fired once an order finishes checkout.",
      payloadSchema: ["type": "object", "properties": ["orderId": ["type": "string"]]]
    )
    try await connect(client, transport, eventRegistry: true)
    try await waitUntil("the snapshot reached the wire") { self.eventFrames(transport).count == 1 }
    let schema = eventFrames(transport)[0]["events"]?.arrayValue?.first?["payload_schema"]
    XCTAssertEqual(schema?["type"]?.stringValue, "object")

    registration.remove()
    try await waitUntil("the remove delta reached the wire") { self.eventFrames(transport).count == 2 }
  }
}

private extension JSONValue {
  subscript(key: String) -> JSONValue? { objectValue?[key] }
}
