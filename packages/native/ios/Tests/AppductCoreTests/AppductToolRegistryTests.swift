import XCTest
@testable import AppductCore

/// Ports `registry.test.ts`'s coverage of `client/registry.ts` (registration order, upsert-keeps-
/// position, stale-disposer immunity is exercised at the `AppductClient` level instead, since the
/// store itself has no disposer concept -- `AppductClient.unregisterTool` is the disposer).
final class AppductToolRegistryTests: XCTestCase {
  private let noopHandler: ToolHandler = { _, _ in .null }

  func testUpsertPreservesRegistrationOrderForNewNames() throws {
    let store = AppductToolRegistryStore()
    try store.upsert(ToolDescriptor(name: "b", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)
    try store.upsert(ToolDescriptor(name: "a", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)
    try store.upsert(ToolDescriptor(name: "c", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)

    XCTAssertEqual(store.snapshot().map(\.name), ["b", "a", "c"])
  }

  func testUpsertOfExistingNameKeepsItsPosition() throws {
    let store = AppductToolRegistryStore()
    try store.upsert(ToolDescriptor(name: "a", description: "first"), handler: noopHandler, defaultTimeoutMs: 10_000)
    try store.upsert(ToolDescriptor(name: "b", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)
    try store.upsert(ToolDescriptor(name: "a", description: "second"), handler: noopHandler, defaultTimeoutMs: 10_000)

    let snapshot = store.snapshot()
    XCTAssertEqual(snapshot.map(\.name), ["a", "b"])
    XCTAssertEqual(snapshot[0].description, "second")
  }

  func testRemoveDropsFromOrderAndLookup() throws {
    let store = AppductToolRegistryStore()
    try store.upsert(ToolDescriptor(name: "a", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)

    XCTAssertTrue(store.remove("a"))
    XCTAssertFalse(store.remove("a"))
    XCTAssertNil(store.lookup("a"))
    XCTAssertEqual(store.snapshot(), [])
  }

  func testUpsertRejectsInvalidDescriptorWithoutMutatingTheStore() {
    let store = AppductToolRegistryStore()
    XCTAssertThrowsError(
      try store.upsert(ToolDescriptor(name: "bad name!", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)
    )
    XCTAssertEqual(store.snapshot(), [])
  }

  func testTimeoutFallsBackToDefaultWhenDescriptorOmitsIt() throws {
    let store = AppductToolRegistryStore()
    try store.upsert(ToolDescriptor(name: "a", description: "x"), handler: noopHandler, defaultTimeoutMs: 4_242)
    XCTAssertEqual(store.lookup("a")?.timeoutMs, 4_242)
  }

  func testExplicitTimeoutOverridesDefault() throws {
    let store = AppductToolRegistryStore()
    try store.upsert(
      ToolDescriptor(name: "a", description: "x", timeoutMs: 30_000),
      handler: noopHandler,
      defaultTimeoutMs: 4_242
    )
    XCTAssertEqual(store.lookup("a")?.timeoutMs, 30_000)
  }

  // MARK: - timeout_ms clamping (fix for issue #48 review: native cores must clamp like the JS
  // registry used to via clampToolTimeoutMs, packages/shared/src/domains/tool-descriptor.ts)

  func testTimeoutBelowMinimumIsClampedUp() throws {
    let store = AppductToolRegistryStore()
    try store.upsert(
      ToolDescriptor(name: "a", description: "x", timeoutMs: 50),
      handler: noopHandler,
      defaultTimeoutMs: 4_242
    )
    XCTAssertEqual(store.lookup("a")?.timeoutMs, APPDUCT_MIN_TOOL_TIMEOUT_MS)
    XCTAssertEqual(store.snapshot().first?.timeoutMs, APPDUCT_MIN_TOOL_TIMEOUT_MS)
  }

  func testTimeoutAboveMaximumIsClampedDown() throws {
    let store = AppductToolRegistryStore()
    try store.upsert(
      ToolDescriptor(name: "a", description: "x", timeoutMs: 5_000_000),
      handler: noopHandler,
      defaultTimeoutMs: 4_242
    )
    XCTAssertEqual(store.lookup("a")?.timeoutMs, APPDUCT_MAX_TOOL_TIMEOUT_MS)
    XCTAssertEqual(store.snapshot().first?.timeoutMs, APPDUCT_MAX_TOOL_TIMEOUT_MS)
  }

  func testUpsertReturnsTheClampedDescriptorForWireDeltaSends() throws {
    let store = AppductToolRegistryStore()
    let stored = try store.upsert(
      ToolDescriptor(name: "a", description: "x", timeoutMs: 5_000_000),
      handler: noopHandler,
      defaultTimeoutMs: 4_242
    )
    XCTAssertEqual(stored.timeoutMs, APPDUCT_MAX_TOOL_TIMEOUT_MS)
  }

  func testNonPositiveTimeoutIsStillRejectedRatherThanClamped() {
    let store = AppductToolRegistryStore()
    XCTAssertThrowsError(
      try store.upsert(
        ToolDescriptor(name: "a", description: "x", timeoutMs: 0),
        handler: noopHandler,
        defaultTimeoutMs: 4_242
      )
    )
    XCTAssertEqual(store.snapshot(), [])
  }
}
