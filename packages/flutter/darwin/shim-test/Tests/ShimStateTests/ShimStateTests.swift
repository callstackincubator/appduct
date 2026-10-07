import ShimState
import XCTest



private let link = "myapp:///?appduct=AAAA&pin=sha256/x"
private let device = ShimDevice(manufacturer: "Apple", model: "iPhone", os: "iOS 18.2")

final class ShimStateTests: XCTestCase {
  private var received: [String] = []
  private let engineA = NSObject()
  private let engineB = NSObject()

  override func setUp() {
    received = []
  }

  private func activateA(_ state: ShimState) -> [String: Any?] {
    state.activate(engine: engineA, device: device) { self.received.append($0) }
  }

  func testTheFirstActivateOwnsTheShimAndReturnsTheDevice() {
    let result = activateA(ShimState())

    XCTAssertEqual(result["owner"] as? Bool, true)
    XCTAssertEqual(result["links"] as? [String], [])
    XCTAssertNil(result["lease"] ?? nil)
    XCTAssertEqual(
      result["device"] as? [String: String],
      ["manufacturer": "Apple", "model": "iPhone", "os": "iOS 18.2"])
  }

  func testASecondEngineGetsOwnerFalseAndNothingElse() {
    let state = ShimState()
    _ = activateA(state)

    let result = state.activate(engine: engineB, device: device) { _ in }

    XCTAssertEqual(result.count, 1)
    XCTAssertEqual(result["owner"] as? Bool, false)
  }

  func testTheOwnerActivatingAgainAfterAHotRestartKeepsItsLease() {
    let state = ShimState()
    _ = activateA(state)
    state.writeLease(engine: engineA, lease: "lease-1")

    let again = activateA(state)

    XCTAssertEqual(again["owner"] as? Bool, true)
    XCTAssertEqual(again["lease"] as? String, "lease-1")
  }

  func testALeaseSurvivesTheEngineBeingDetachedAndANewEngineActivating() {
    let state = ShimState()
    _ = activateA(state)
    state.writeLease(engine: engineA, lease: "lease-1")
    state.release(engine: engineA)

    let result = state.activate(engine: engineB, device: device) { _ in }

    XCTAssertEqual(result["owner"] as? Bool, true)
    XCTAssertEqual(result["lease"] as? String, "lease-1")
  }

  func testClearLeaseRemovesTheLease() {
    let state = ShimState()
    _ = activateA(state)
    state.writeLease(engine: engineA, lease: "lease-1")
    state.clearLease(engine: engineA)

    XCTAssertNil(activateA(state)["lease"] ?? nil)
  }

  func testALeaseWrittenByANonOwnerIsIgnored() {
    let state = ShimState()
    _ = activateA(state)
    _ = state.activate(engine: engineB, device: device) { _ in }
    state.writeLease(engine: engineB, lease: "intruder")

    XCTAssertNil(activateA(state)["lease"] ?? nil)
  }

  func testBeforeActivateALinkIsRememberedButNotClaimed() {
    let state = ShimState()

    XCTAssertFalse(state.onLink(link))
    XCTAssertEqual(received, [])
  }

  func testActivateReturnsOnlyTheLatestLinkReceivedBeforeIt() {
    let state = ShimState()
    _ = state.onLink("myapp:///?appduct=OLD")
    _ = state.onLink(link)

    XCTAssertEqual(activateA(state)["links"] as? [String], [link])
    XCTAssertEqual(activateA(state)["links"] as? [String], [])
  }

  func testBeforeActivateNothingIsStoredForALeaseWrite() {
    let state = ShimState()
    state.writeLease(engine: engineA, lease: "early")

    XCTAssertNil(activateA(state)["lease"] ?? nil)
  }

  func testAfterActivateALinkIsSentToDartAndClaimed() {
    let state = ShimState()
    _ = activateA(state)

    XCTAssertTrue(state.onLink(link))
    XCTAssertEqual(received, [link])
  }

  func testALinkThatDoesNotCarryAppductPassesThrough() {
    let state = ShimState()
    _ = activateA(state)

    XCTAssertFalse(state.onLink("myapp:///profile?id=1"))
    XCTAssertFalse(state.onLink("myapp:///profile?notappduct=1"))
    XCTAssertFalse(state.onLink("myapp:///profile#?appduct=1"))
    XCTAssertEqual(received, [])
  }

  func testALinkArrivingWhileNoEngineIsAttachedIsRememberedForTheNextActivate() {
    let state = ShimState()
    _ = activateA(state)
    state.release(engine: engineA)

    XCTAssertFalse(state.onLink(link))
    XCTAssertEqual(
      state.activate(engine: engineB, device: device) { _ in }["links"] as? [String], [link])
  }
}
