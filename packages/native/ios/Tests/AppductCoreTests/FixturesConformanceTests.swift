import XCTest
@testable import AppductCore

/// Cross-language conformance fixtures (issue #48, "Parity is the risk"): every vector loaded
/// here also loads and asserts in TypeScript
/// (`packages/shared/src/__tests__/fixtures-conformance.test.ts`,
/// `packages/appduct/src/__tests__/spki-pin.test.ts`) and Kotlin
/// (`packages/native/android/core/src/test/.../FixturesConformanceTest.kt`) against their own
/// implementations of the same rules. See `packages/native/fixtures/README.md` for the rule that
/// a divergence found this way is fixed in the implementation that disagrees with
/// `docs/PROTOCOL.md`, never in the fixture.
final class FixturesConformanceTests: XCTestCase {
  /// `packages/native/fixtures`, located relative to this file's own path (this test target has
  /// no bundle resource copying set up for arbitrary repo-relative files, so `#filePath` is the
  /// only stable anchor): this file lives at
  /// `packages/native/ios/Tests/AppductCoreTests/FixturesConformanceTests.swift`, three
  /// directories below `packages/native`.
  private static let fixturesDirectory: URL = {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // FixturesConformanceTests.swift -> AppductCoreTests/
      .deletingLastPathComponent() // AppductCoreTests/ -> Tests/
      .deletingLastPathComponent() // Tests/ -> ios/
      .deletingLastPathComponent() // ios/ -> native/
      .appendingPathComponent("fixtures")
  }()

  private static func loadFixture(_ name: String) throws -> Any {
    let url = fixturesDirectory.appendingPathComponent(name)
    let data = try Data(contentsOf: url)
    return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
  }

  private static func intValue(_ any: Any?) -> Int? {
    (any as? NSNumber)?.intValue
  }

  // MARK: - bootstrap-payloads.json

  func testBootstrapPayloadsFixture() throws {
    let vectors = try Self.loadFixture("bootstrap-payloads.json") as! [[String: Any]]
    XCTAssertGreaterThan(vectors.count, 0)

    for vector in vectors {
      let name = vector["name"] as! String
      let base64url = vector["base64url"] as! String
      let expected = vector["expected"] as? [String: Any]
      let decoded = decodeAppductBootstrap(base64url)

      guard let expected else {
        XCTAssertNil(decoded, name)
        continue
      }

      guard let decoded else {
        XCTFail("\(name): expected a successful decode")
        continue
      }

      XCTAssertEqual(decoded.family.rawValue, Self.intValue(expected["family"]), name)
      XCTAssertEqual(decoded.address, expected["address"] as? String, name)
      XCTAssertEqual(decoded.port, Self.intValue(expected["port"]), name)
      XCTAssertEqual(decoded.sessionId, expected["sessionId"] as? String, name)
      XCTAssertEqual(decoded.token, expected["tokenBase64url"] as? String, name)
      XCTAssertEqual(decoded.expiresAt, Self.intValue(expected["expiresAt"]), name)
    }
  }

  // MARK: - bootstrap-links.json

  func testBootstrapLinksFixture() throws {
    let payloads = try Self.loadFixture("bootstrap-payloads.json") as! [[String: Any]]
    let links = try Self.loadFixture("bootstrap-links.json") as! [[String: Any]]
    XCTAssertGreaterThan(links.count, 0)

    for link in links {
      let name = link["name"] as! String
      let urlString = link["url"] as! String
      let expected = link["expected"] as! [String: Any]
      let payloadIndex = Self.intValue(expected["payloadIndex"])!
      let expectedPin = expected["pin"] as? String

      guard let components = URLComponents(string: urlString) else {
        XCTFail("\(name): not a parseable URL")
        continue
      }

      let appductValue = components.queryItems?.first(where: { $0.name == "appduct" })?.value
      XCTAssertEqual(appductValue, payloads[payloadIndex]["base64url"] as? String, name)

      let pin = extractAppductLinkPin(from: components)
      XCTAssertEqual(pin, expectedPin, name)
    }
  }

  // MARK: - tool-descriptors.json

  func testToolDescriptorsFixture() throws {
    let vectors = try Self.loadFixture("tool-descriptors.json") as! [[String: Any]]
    XCTAssertGreaterThan(vectors.count, 0)

    for vector in vectors {
      let name = vector["name"] as! String
      let descriptorRaw = vector["descriptor"] ?? NSNull()
      let expectedValid = vector["valid"] as! Bool
      let jsonValue = JSONValue.from(foundation: descriptorRaw)

      let isValid: Bool
      do {
        _ = try parseToolDescriptor(jsonValue)
        isValid = true
      } catch {
        isValid = false
      }

      XCTAssertEqual(isValid, expectedValid, name)
    }
  }

  // MARK: - event-descriptors.json

  func testEventDescriptorsFixture() throws {
    let vectors = try Self.loadFixture("event-descriptors.json") as! [[String: Any]]
    XCTAssertGreaterThan(vectors.count, 0)

    for vector in vectors {
      let name = vector["name"] as! String
      let descriptorRaw = vector["descriptor"] ?? NSNull()
      let expectedValid = vector["valid"] as! Bool

      let isValid: Bool
      do {
        _ = try parseEventDescriptor(JSONValue.from(foundation: descriptorRaw))
        isValid = true
      } catch {
        isValid = false
      }

      XCTAssertEqual(isValid, expectedValid, name)
    }
  }

  // MARK: - close-codes.json

  func testCloseCodesFixture() throws {
    let vectors = try Self.loadFixture("close-codes.json") as! [[String: Any]]
    XCTAssertGreaterThan(vectors.count, 0)

    for (index, vector) in vectors.enumerated() {
      let code = Self.intValue(vector["code"])
      let reason = vector["reason"] as? String
      let terminal = vector["terminal"] as! Bool
      let event = AppductCloseEvent(code: code, reason: reason)

      XCTAssertEqual(isTerminalCloseEvent(event), terminal, "vector #\(index) (code \(String(describing: code)))")
    }
  }

  func testOnlyCode1008IsEverTerminal() throws {
    let vectors = try Self.loadFixture("close-codes.json") as! [[String: Any]]

    for vector in vectors where (vector["terminal"] as! Bool) {
      XCTAssertEqual(Self.intValue(vector["code"]), 1_008)
    }
  }

  // MARK: - spki-pin.json

  func testSpkiPinFixtureMatchesTheSharedFixtureCertificate() throws {
    let fixture = try Self.loadFixture("spki-pin.json") as! [String: Any]
    let certificateDerBase64 = fixture["certificateDerBase64"] as! String
    let expectedPin = fixture["expectedPin"] as! String

    guard let der = Data(base64Encoded: certificateDerBase64),
      let certificate = SecCertificateCreateWithData(nil, der as CFData)
    else {
      XCTFail("Failed to decode the fixture certificate")
      return
    }

    let manager = AppductConnectionManager()
    let pin = try manager.spkiPin(for: certificate)

    XCTAssertEqual(pin, expectedPin)
  }

  // MARK: - frame-limits.json

  private final class StringBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = ""
    var value: String {
      get { lock.lock(); defer { lock.unlock() }; return stored }
      set { lock.lock(); stored = newValue; lock.unlock() }
    }
  }

  private static func padding(frameBytes: Int, filler: String, emptyFrameBytes: Int) -> String {
    let pad = frameBytes - emptyFrameBytes
    let unit = filler.utf8.count
    let count = pad / unit
    return String(repeating: filler, count: count) + String(repeating: "a", count: pad - count * unit)
  }

  private func activeClient() async throws -> (AppductClient, FakeTransportSession) {
    AppductProcessResumeLeaseStore.shared.resetForTests()
    let transport = FakeTransportSession()
    let client = AppductClient(
      transport: transport,
      timers: FakeClientTimers(),
      defaultToolTimeoutMs: 10_000,
      requirePrivateIp: true,
      foregroundObserver: NeverBackgroundedObserver()
    )
    let input = AppductConnectInput(
      ip: "192.168.1.10",
      port: 8_443,
      sessionId: "session-1",
      token: "claim-token",
      expiresAt: 9_999_999_999,
      linkPin: nil
    )
    let connecting = Task { try await client.connect(input) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connecting.value
    return (client, transport)
  }

  private func frames(_ transport: FakeTransportSession, ofType type: String) -> [[String: Any]] {
    rawFrames(transport, ofType: type).compactMap { text in
      try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    }
  }

  private func rawFrames(_ transport: FakeTransportSession, ofType type: String) -> [String] {
    transport.sentMessages.filter { text in
      let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
      return object?["type"] as? String == type
    }
  }

  func testFrameLimitsFixtureDecidesWhichToolResultsAreSent() async throws {
    let fixture = try Self.loadFixture("frame-limits.json") as! [String: Any]
    let limitBytes = Self.intValue(fixture["limitBytes"])!
    let vectors = fixture["vectors"] as! [[String: Any]]
    XCTAssertEqual(limitBytes, 262_144)
    XCTAssertGreaterThan(vectors.count, 0)

    for vector in vectors {
      let name = vector["name"] as! String
      let frameBytes = Self.intValue(vector["frameBytes"])!
      let (client, transport) = try await activeClient()
      let answer = StringBox()
      try client.registerTool(ToolDescriptor(name: "big", description: "Returns a string."), handler: { _, _ in .string(answer.value) })
      try await waitUntil("the registry delta reached the wire") { !self.frames(transport, ofType: "tool_registry_delta").isEmpty }
      let call = { (id: String) in
        transport.simulateIncoming(
          "{\"type\":\"tool_call\",\"session_id\":\"session-1\",\"id\":\"\(id)\",\"name\":\"big\",\"args\":{}}"
        )
      }

      call("id-a")
      try await waitUntil("the empty result reached the wire") { self.frames(transport, ofType: "tool_result").count == 1 }
      let emptyFrameBytes = rawFrames(transport, ofType: "tool_result")[0].utf8.count

      answer.value = Self.padding(frameBytes: frameBytes, filler: vector["filler"] as! String, emptyFrameBytes: emptyFrameBytes)
      call("id-b")

      if vector["sent"] as! Bool {
        try await waitUntil("\(name): the result reached the wire") { self.frames(transport, ofType: "tool_result").count == 2 }
        XCTAssertEqual(rawFrames(transport, ofType: "tool_result")[1].utf8.count, frameBytes, name)
      } else {
        try await waitUntil("\(name): a tool error reached the wire") { !self.frames(transport, ofType: "tool_error").isEmpty }
        XCTAssertEqual(frames(transport, ofType: "tool_result").count, 1, name)
        let error = frames(transport, ofType: "tool_error")[0]
        XCTAssertEqual(error["id"] as? String, "id-b", name)
        let body = error["error"] as? [String: Any]
        XCTAssertEqual(body?["type"] as? String, "tool_serialization_error", name)
        XCTAssertEqual(body?["message"] as? String, "Appduct frame is \(frameBytes) bytes, over the \(limitBytes)-byte limit.", name)
      }
      let finalState = await client.state
      XCTAssertEqual(finalState, .active, name)
    }
  }

  func testFrameLimitsFixtureDecidesWhichEventsAreSent() async throws {
    let fixture = try Self.loadFixture("frame-limits.json") as! [String: Any]
    let limitBytes = Self.intValue(fixture["limitBytes"])!
    let vectors = fixture["vectors"] as! [[String: Any]]

    for vector in vectors {
      let name = vector["name"] as! String
      let frameBytes = Self.intValue(vector["frameBytes"])!
      let (client, transport) = try await activeClient()
      let errors = EventCollector<AppductUnifiedErrorEvent>()
      _ = await client.onError { errors.append($0) }

      try await client.postEvent("big", payload: .string(""))
      let emptyFrameBytes = transport.sentMessages.last!.utf8.count
      let payload = Self.padding(frameBytes: frameBytes, filler: vector["filler"] as! String, emptyFrameBytes: emptyFrameBytes)

      if vector["sent"] as! Bool {
        try await client.postEvent("big", payload: .string(payload))
        XCTAssertEqual(frames(transport, ofType: "event").count, 2, name)
        XCTAssertEqual(transport.sentMessages.last!.utf8.count, frameBytes, name)
        XCTAssertTrue(errors.all.isEmpty, name)
      } else {
        _ = try? await client.postEvent("big", payload: .string(payload))
        XCTAssertEqual(frames(transport, ofType: "event").count, 1, name)
        XCTAssertEqual(errors.all.map(\.message), ["Appduct frame is \(frameBytes) bytes, over the \(limitBytes)-byte limit."], name)
        XCTAssertEqual(errors.all.first?.phase, "socket", name)
      }
      let finalState = await client.state
      XCTAssertEqual(finalState, .active, name)
    }
  }

  func testToolRegistrySnapshotOverTheFrameLimitGoesToTheErrorListener() async throws {
    AppductProcessResumeLeaseStore.shared.resetForTests()
    let transport = FakeTransportSession()
    let client = AppductClient(
      transport: transport,
      timers: FakeClientTimers(),
      defaultToolTimeoutMs: 10_000,
      requirePrivateIp: true,
      foregroundObserver: NeverBackgroundedObserver()
    )
    let errors = EventCollector<AppductUnifiedErrorEvent>()
    _ = await client.onError { errors.append($0) }
    for index in 0..<70 {
      try client.registerTool(
        ToolDescriptor(name: "tool_\(index)", description: String(repeating: "x", count: 4096)),
        handler: { _, _ in .null }
      )
    }

    let input = AppductConnectInput(
      ip: "192.168.1.10", port: 8_443, sessionId: "session-1", token: "claim-token", expiresAt: 9_999_999_999, linkPin: nil
    )
    let connecting = Task { try await client.connect(input) }
    try await waitUntil("the client started its transport handshake") { transport.isWired && transport.connectCallCount >= 1 }
    transport.simulateAck(sessionId: "session-1")
    try await connecting.value

    try await waitUntil("the snapshot was refused") { !errors.all.isEmpty }
    XCTAssertTrue(frames(transport, ofType: "tool_registry_snapshot").isEmpty)
    XCTAssertTrue(errors.all[0].message.hasPrefix("Appduct frame is "))
    XCTAssertTrue(errors.all[0].message.hasSuffix(" bytes, over the 262144-byte limit."))
    let finalState = await client.state
    XCTAssertEqual(finalState, .active)
  }
}
