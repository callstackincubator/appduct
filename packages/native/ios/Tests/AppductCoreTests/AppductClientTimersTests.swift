import XCTest
@testable import AppductCore

/// Pins the unit of the clock a shipped app stamps `event.ts` with. Every `AppductClient` test
/// injects a `FakeClientTimers`, whose `startMs` is whatever the test picks, so without this the
/// seconds-versus-milliseconds choice in `SystemAppductClientTimers.now()` — the one #154 got wrong
/// — sat behind a fake. The 1 s tolerance covers a slow host; a seconds or microseconds clock is
/// out by three orders of magnitude. No `#if APPDUCT_ENABLED` guard, as in `AppductAPITests`: that
/// define is set on the `AppductCore` target in Debug, which is what `swift test` always builds.
final class AppductClientTimersTests: XCTestCase {
  func testTheRealClockReportsUnixMilliseconds() {
    XCTAssertEqual(SystemAppductClientTimers().now(), Date().timeIntervalSince1970 * 1_000, accuracy: 1_000)
  }
}
