import XCTest
@testable import CordieriteCore

/// Ports `backoff.test.ts`.
final class CordieriteBackoffTests: XCTestCase {
  func testAttemptZeroIsBoundedByBase() {
    let delay = CordieriteBackoff.fullJitterMs(attempt: 0, random: { 0.999999 })
    XCTAssertLessThanOrEqual(delay, CordieriteBackoff.baseMs)
    XCTAssertGreaterThanOrEqual(delay, 0)
  }

  func testGrowsExponentiallyUntilCap() {
    XCTAssertEqual(CordieriteBackoff.fullJitterMs(attempt: 1, random: { 1 }), 1_000)
    XCTAssertEqual(CordieriteBackoff.fullJitterMs(attempt: 2, random: { 1 }), 2_000)
    XCTAssertEqual(CordieriteBackoff.fullJitterMs(attempt: 3, random: { 1 }), 4_000)
    XCTAssertEqual(CordieriteBackoff.fullJitterMs(attempt: 4, random: { 1 }), 8_000)
    XCTAssertEqual(CordieriteBackoff.fullJitterMs(attempt: 5, random: { 1 }), 16_000)
  }

  func testCapsAtThirtySeconds() {
    XCTAssertEqual(CordieriteBackoff.fullJitterMs(attempt: 6, random: { 1 }), CordieriteBackoff.capMs)
    XCTAssertEqual(CordieriteBackoff.fullJitterMs(attempt: 100, random: { 1 }), CordieriteBackoff.capMs)
  }

  func testNegativeAttemptClampsToZero() {
    XCTAssertEqual(
      CordieriteBackoff.fullJitterMs(attempt: -5, random: { 1 }),
      CordieriteBackoff.fullJitterMs(attempt: 0, random: { 1 })
    )
  }

  func testZeroJitterProducesZeroDelay() {
    XCTAssertEqual(CordieriteBackoff.fullJitterMs(attempt: 3, random: { 0 }), 0)
  }

  func testCustomBaseAndCap() {
    let delay = CordieriteBackoff.fullJitterMs(attempt: 10, baseMs: 100, capMs: 500, random: { 1 })
    XCTAssertEqual(delay, 500)
  }
}
