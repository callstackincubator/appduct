import XCTest
import AppductCore

/// Replays `packages/native/fixtures/session-scenarios.json` through `AppductClient`, the way
/// `packages/web/src/__tests__/session-scenarios.test.ts` replays it through the web core. The
/// format is documented in `packages/native/fixtures/README.md`: each step drives the client or
/// expects the next output of one of two ordered channels, wire (`connect`, `send`) and app
/// (`state`, `session`, `call`, `cancel`). Order between the channels is not asserted.
final class SessionScenariosTests: XCTestCase {
  private static func scenariosURL(_ file: String) -> URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // SessionScenariosTests.swift -> AppductCoreTests/
      .deletingLastPathComponent() // AppductCoreTests/ -> Tests/
      .deletingLastPathComponent() // Tests/ -> ios/
      .deletingLastPathComponent() // ios/ -> native/
      .appendingPathComponent("fixtures")
      .appendingPathComponent(file)
  }

  private func replayEveryScenario(in file: String) async throws {
    let data = try Data(contentsOf: Self.scenariosURL(file))
    let scenarios = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    XCTAssertGreaterThan(scenarios.count, 0)

    for scenario in scenarios {
      do {
        try await ScenarioReplay(scenario).run()
      } catch {
        XCTFail("\(error)")
      }
    }
  }

  func testReplaysEveryScenarioInSessionScenariosJson() async throws {
    try await replayEveryScenario(in: "session-scenarios.json")
  }

  func testReplaysEveryScenarioInSessionScenariosBackgroundJson() async throws {
    try await replayEveryScenario(in: "session-scenarios-background.json")
  }

  // MARK: The runner itself

  private static let sessionId = "session-1"
  private static var ack: [String: Any] { [
    "type": "session_ack", "session_id": sessionId, "status": "ok", "alias": "phone",
    "resume_token": "resume-1", "keepalive_interval_s": 15, "grace_s": 10,
  ] }
  private static var claimThenActive: [[String: Any]] { [
    ["drive": "connect", "sessionId": sessionId, "token": "claim-token", "expiresAt": 1_700_000_300],
    ["expect": "connect", "mode": "claim", "sessionId": sessionId],
    ["expect": "state", "state": "connecting"],
    ["drive": "receive", "frame": ack],
    ["expect": "state", "state": "active"],
    ["expect": "session", "type": "claimed"],
  ] }
  private static var snapshot: [String: Any] { [
    "expect": "send",
    "frame": ["tools": [Any](), "session_id": sessionId, "type": "tool_registry_snapshot"] as [String: Any],
  ] }

  private func inline(_ steps: [[String: Any]]) -> [String: Any] {
    ["name": "inline", "startMs": 1_700_000_000_000, "random": 0.5, "steps": steps]
  }

  /// Fails the test unless replaying `scenario` throws a message containing `fragment`.
  private func assertReplayFails(
    _ scenario: [String: Any],
    containing fragment: String,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    do {
      try await ScenarioReplay(scenario, timeoutSeconds: 0.3).run()
      XCTFail("expected the replay to fail", file: file, line: line)
    } catch {
      XCTAssertTrue("\(error)".contains(fragment), "\(error) does not contain \(fragment)", file: file, line: line)
    }
  }

  func testRunnerPassesAScenarioWhoseFrameKeysAreInAnotherOrder() async throws {
    try await ScenarioReplay(inline(Self.claimThenActive + [Self.snapshot])).run()
  }

  func testRunnerFailsAScenarioThatExpectsAnOutputTheClientNeverProduces() async {
    let steps = Self.claimThenActive + [Self.snapshot, ["expect": "state", "state": "closed"]]
    await assertReplayFails(inline(steps), containing: "nothing arrived")
  }

  func testRunnerFailsAScenarioThatLeavesAnOutputUnexpected() async {
    await assertReplayFails(inline(Self.claimThenActive), containing: "left over")
  }

  func testRunnerFailsAScenarioThatExpectsTwoOutputsOfOneChannelInTheWrongOrder() async {
    let steps: [[String: Any]] =
      Array(Self.claimThenActive[0..<2])
      + [["expect": "state", "state": "active"], ["expect": "state", "state": "connecting"]]
      + Array(Self.claimThenActive[3...])
    await assertReplayFails(inline(steps), containing: "step 3")
  }
}

// MARK: - Replay

/// `NSLock.withLock` needs macOS 13 / iOS 16, above this package's deployment targets.
private func scopedLock<T>(_ lock: NSLock, _ body: () -> T) -> T {
  lock.lock()
  defer { lock.unlock() }
  return body()
}

private struct ScenarioFailure: Error, CustomStringConvertible {
  let description: String
}

/// First in, first out, filled from the client's listener callbacks on other threads. Each entry is
/// JSON text, so it is `Sendable`.
private final class OutputQueue: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String] = []

  func push(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed])
    let text = String(decoding: data, as: UTF8.self)
    scopedLock(lock) { items.append(text) }
  }

  func pop() -> String? {
    scopedLock(lock) { items.isEmpty ? nil : items.removeFirst() }
  }
}

/// What a scenario's `respond` step hands to the handler waiting on that call.
private final class ResponseBox: @unchecked Sendable {
  private let lock = NSLock()
  private var responses: [String: Result<JSONValue, AppductToolHandlerError>] = [:]

  func put(_ response: Result<JSONValue, AppductToolHandlerError>, for call: String) {
    scopedLock(lock) { responses[call] = response }
  }

  func take(_ call: String) -> Result<JSONValue, AppductToolHandlerError>? {
    scopedLock(lock) { responses.removeValue(forKey: call) }
  }
}

/// Plays one scenario against a fresh `AppductClient` over `FakeTransportSession` and
/// `FakeClientTimers`. Throws, instead of failing the test, so a test can assert that a scenario
/// is rejected.
private final class ScenarioReplay {
  private let scenario: [String: Any]
  private let timeoutSeconds: TimeInterval
  private let timers: FakeClientTimers
  private let transport = FakeTransportSession()
  private let client: AppductClient
  private let app = OutputQueue()
  private let responses = ResponseBox()
  private var wireCursor = 0
  private var acksDelivered = 0

  init(_ scenario: [String: Any], timeoutSeconds: TimeInterval = 5) {
    self.scenario = scenario
    self.timeoutSeconds = timeoutSeconds
    timers = FakeClientTimers(
      startMs: (scenario["startMs"] as! NSNumber).doubleValue,
      random: (scenario["random"] as! NSNumber).doubleValue
    )
    client = AppductClient(
      transport: transport,
      timers: timers,
      defaultToolTimeoutMs: 10_000,
      requirePrivateIp: true,
      foregroundObserver: NeverBackgroundedObserver()
    )
  }

  func run() async throws {
    let name = scenario["name"] as! String
    let app = self.app
    await client.onStateChange { event in
      var output: [String: Any] = ["kind": "state", "state": event.state.rawValue]
      if let reason = event.reason { output["reason"] = reason }
      app.push(output)
    }
    await client.onSessionChange { event in
      var output: [String: Any] = ["kind": "session", "type": event.type.rawValue]
      if let reason = event.reason { output["reason"] = reason }
      app.push(output)
    }

    for (index, step) in (scenario["steps"] as! [[String: Any]]).enumerated() {
      let label = "\(name), step \(index + 1)"
      if let drive = step["drive"] as? String {
        try await self.drive(drive, step, label: label)
      } else {
        try await expect(step, label: label)
      }
    }

    await allowQueuedWorkToRun()
    var leftover: [String] = []
    while let item = try nextWire() { leftover.append(describe(item)) }
    while let item = app.pop() { leftover.append(item) }
    if !leftover.isEmpty {
      throw ScenarioFailure(description: "\(name): the steps ran out with outputs left over: \(leftover)")
    }
  }

  // MARK: Drive

  private func drive(_ kind: String, _ step: [String: Any], label: String) async throws {
    switch kind {
    case "connect":
      let input = AppductConnectInput(
        ip: "192.168.1.10",
        port: 8_443,
        sessionId: step["sessionId"] as! String,
        token: step["token"] as? String,
        expiresAt: (step["expiresAt"] as! NSNumber).intValue
      )
      let client = self.client
      Task { try? await client.connect(input) }

    case "receive":
      let frame = step["frame"] as! [String: Any]
      try await wait("the client to wire its transport, for \(label)") { self.transport.isWired }
      if frame["type"] as? String == "session_ack" {
        // An ack that arrives before the client has a handshake in flight is dropped as stray.
        try await wait("a handshake in flight to answer, for \(label)") { self.connectCount() > self.acksDelivered }
        acksDelivered += 1
        transport.stateSnapshot = "active"
      }
      transport.simulateIncoming(try jsonText(frame))

    case "close":
      try await wait("the client to wire its transport, for \(label)") { self.transport.isWired }
      transport.simulateClose(code: (step["code"] as? NSNumber)?.intValue, reason: step["reason"] as? String)

    case "drop":
      try await wait("the client to wire its transport, for \(label)") { self.transport.isWired }
      transport.simulateClose(code: nil, reason: nil)

    case "advance":
      // Timers hand their work to the client's actor on a `Task`; give it a chance to arm any
      // timer before time moves, and to act on the one that fired before the next step.
      await allowQueuedWorkToRun(ms: 30)
      timers.advance(byMs: (step["ms"] as! NSNumber).doubleValue)
      await allowQueuedWorkToRun(ms: 30)

    case "registerTool":
      let descriptor = try parseToolDescriptor(JSONValue.from(foundation: step["descriptor"] as Any))
      try client.registerTool(descriptor, handler: callHandler())

    case "respond":
      let call = step["call"] as! String
      if let error = step["error"] as? [String: Any] {
        responses.put(
          .failure(AppductToolHandlerError(type: error["type"] as! String, message: error["message"] as! String)),
          for: call
        )
      } else {
        responses.put(.success(JSONValue.from(foundation: step["result"] as Any)), for: call)
      }

    case "disconnect":
      await client.disconnect()

    default:
      throw ScenarioFailure(description: "\(label): unknown drive step \"\(kind)\"")
    }
  }

  /// Reports the call on the app channel, then waits for the scenario's `respond`. When the client
  /// cancels the call, reports that with the reason the client gave.
  private func callHandler() -> ToolHandler {
    let app = self.app
    let responses = self.responses
    return { args, context in
      app.push(["kind": "call", "name": context.toolName, "args": JSONValue.object(args).foundationValue])
      do {
        while true {
          if let response = responses.take(context.callId) { return try response.get() }
          try await Task.sleep(nanoseconds: 2_000_000)
        }
      } catch is CancellationError {
        let reason = await context.cancelReason() ?? "unknown"
        app.push(["kind": "cancel", "call": context.callId, "reason": reason])
        throw CancellationError()
      }
    }
  }

  // MARK: Expect

  private func expect(_ step: [String: Any], label: String) async throws {
    let kind = step["expect"] as! String
    var wanted = step
    wanted.removeValue(forKey: "expect")
    wanted["kind"] = kind

    let deadline = Date().addingTimeInterval(timeoutSeconds)
    var got = try next(kind)
    while got == nil, Date() < deadline {
      try await Task.sleep(nanoseconds: 2_000_000)
      got = try next(kind)
    }
    guard let got else {
      throw ScenarioFailure(
        description: "\(label): expected \(describe(wanted)) but nothing arrived within \(timeoutSeconds) s"
      )
    }
    guard (got as NSDictionary).isEqual(to: wanted) else {
      throw ScenarioFailure(description: "\(label): expected \(describe(wanted)) but got \(describe(got))")
    }
  }

  private func next(_ kind: String) throws -> [String: Any]? {
    switch kind {
    case "connect", "send":
      return try nextWire()
    case "state", "session", "call", "cancel":
      return try app.pop().map { try parseObject($0) }
    default:
      throw ScenarioFailure(description: "unknown expect step \"\(kind)\"")
    }
  }

  /// The next thing the client asked of the transport, as the `connect` or `send` output a step
  /// spells out.
  private func nextWire() throws -> [String: Any]? {
    let events = transport.wireEvents
    guard wireCursor < events.count else { return nil }
    let event = events[wireCursor]
    wireCursor += 1
    switch event {
    case .connect(let options):
      var output: [String: Any] = [
        "kind": "connect",
        "mode": options.resumeToken == nil ? "claim" : "resume",
        "sessionId": options.sessionId,
      ]
      if let resumeToken = options.resumeToken { output["resumeToken"] = resumeToken }
      return output
    case .send(let text):
      return ["kind": "send", "frame": try JSONSerialization.jsonObject(with: Data(text.utf8))]
    }
  }

  private func connectCount() -> Int {
    transport.wireEvents.filter { if case .connect = $0 { return true } else { return false } }.count
  }

  // MARK: Helpers

  private func wait(_ what: String, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while !condition() {
      if Date() >= deadline {
        throw ScenarioFailure(description: "timed out after \(timeoutSeconds) s waiting for \(what)")
      }
      try await Task.sleep(nanoseconds: 2_000_000)
    }
  }

  private func parseObject(_ text: String) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
      throw ScenarioFailure(description: "not a JSON object: \(text)")
    }
    return object
  }

  private func jsonText(_ object: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
  }

  private func describe(_ object: [String: Any]) -> String {
    (try? jsonText(object)) ?? "\(object)"
  }
}
