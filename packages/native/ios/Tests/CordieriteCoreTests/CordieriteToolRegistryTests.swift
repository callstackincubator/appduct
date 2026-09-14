import XCTest
@testable import CordieriteCore

/// Ports `registry.test.ts`'s coverage of `client/registry.ts` (registration order, upsert-keeps-
/// position, stale-disposer immunity is exercised at the `CordieriteClient` level instead, since the
/// store itself has no disposer concept -- `CordieriteClient.unregisterTool` is the disposer).
final class CordieriteToolRegistryTests: XCTestCase {
  private let noopHandler: ToolHandler = { _, _ in .null }

  func testUpsertPreservesRegistrationOrderForNewNames() throws {
    let store = CordieriteToolRegistryStore()
    try store.upsert(ToolDescriptor(name: "b", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)
    try store.upsert(ToolDescriptor(name: "a", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)
    try store.upsert(ToolDescriptor(name: "c", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)

    XCTAssertEqual(store.snapshot().map(\.name), ["b", "a", "c"])
  }

  func testUpsertOfExistingNameKeepsItsPosition() throws {
    let store = CordieriteToolRegistryStore()
    try store.upsert(ToolDescriptor(name: "a", description: "first"), handler: noopHandler, defaultTimeoutMs: 10_000)
    try store.upsert(ToolDescriptor(name: "b", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)
    try store.upsert(ToolDescriptor(name: "a", description: "second"), handler: noopHandler, defaultTimeoutMs: 10_000)

    let snapshot = store.snapshot()
    XCTAssertEqual(snapshot.map(\.name), ["a", "b"])
    XCTAssertEqual(snapshot[0].description, "second")
  }

  func testRemoveDropsFromOrderAndLookup() throws {
    let store = CordieriteToolRegistryStore()
    try store.upsert(ToolDescriptor(name: "a", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)

    XCTAssertTrue(store.remove("a"))
    XCTAssertFalse(store.remove("a"))
    XCTAssertNil(store.lookup("a"))
    XCTAssertEqual(store.snapshot(), [])
  }

  func testUpsertRejectsInvalidDescriptorWithoutMutatingTheStore() {
    let store = CordieriteToolRegistryStore()
    XCTAssertThrowsError(
      try store.upsert(ToolDescriptor(name: "bad name!", description: "x"), handler: noopHandler, defaultTimeoutMs: 10_000)
    )
    XCTAssertEqual(store.snapshot(), [])
  }

  func testTimeoutFallsBackToDefaultWhenDescriptorOmitsIt() throws {
    let store = CordieriteToolRegistryStore()
    try store.upsert(ToolDescriptor(name: "a", description: "x"), handler: noopHandler, defaultTimeoutMs: 4_242)
    XCTAssertEqual(store.lookup("a")?.timeoutMs, 4_242)
  }

  func testExplicitTimeoutOverridesDefault() throws {
    let store = CordieriteToolRegistryStore()
    try store.upsert(
      ToolDescriptor(name: "a", description: "x", timeoutMs: 999),
      handler: noopHandler,
      defaultTimeoutMs: 4_242
    )
    XCTAssertEqual(store.lookup("a")?.timeoutMs, 999)
  }
}
