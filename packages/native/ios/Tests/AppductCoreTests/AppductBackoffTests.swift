import XCTest
@testable import AppductCore

/// Ports `backoff.test.ts`.
final class AppductBackoffTests: XCTestCase {
  func testAttemptZeroIsBoundedByBase() {
    let delay = AppductBackoff.fullJitterMs(attempt: 0, random: { 0.999999 })
    XCTAssertLessThanOrEqual(delay, AppductBackoff.baseMs)
    XCTAssertGreaterThanOrEqual(delay, 0)
  }

  func testGrowsExponentiallyUntilCap() {
    XCTAssertEqual(AppductBackoff.fullJitterMs(attempt: 1, random: { 1 }), 1_000)
    XCTAssertEqual(AppductBackoff.fullJitterMs(attempt: 2, random: { 1 }), 2_000)
    XCTAssertEqual(AppductBackoff.fullJitterMs(attempt: 3, random: { 1 }), 4_000)
    XCTAssertEqual(AppductBackoff.fullJitterMs(attempt: 4, random: { 1 }), 8_000)
    XCTAssertEqual(AppductBackoff.fullJitterMs(attempt: 5, random: { 1 }), 16_000)
  }

  func testCapsAtThirtySeconds() {
    XCTAssertEqual(AppductBackoff.fullJitterMs(attempt: 6, random: { 1 }), AppductBackoff.capMs)
    XCTAssertEqual(AppductBackoff.fullJitterMs(attempt: 100, random: { 1 }), AppductBackoff.capMs)
  }

  func testNegativeAttemptClampsToZero() {
    XCTAssertEqual(
      AppductBackoff.fullJitterMs(attempt: -5, random: { 1 }),
      AppductBackoff.fullJitterMs(attempt: 0, random: { 1 })
    )
  }

  func testZeroJitterProducesZeroDelay() {
    XCTAssertEqual(AppductBackoff.fullJitterMs(attempt: 3, random: { 0 }), 0)
  }

  func testCustomBaseAndCap() {
    let delay = AppductBackoff.fullJitterMs(attempt: 10, baseMs: 100, capMs: 500, random: { 1 })
    XCTAssertEqual(delay, 500)
  }
}
