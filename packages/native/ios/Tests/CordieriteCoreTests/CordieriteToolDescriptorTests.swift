import XCTest
@testable import CordieriteCore

/// Ports the `isToolDescriptor` half of `@cordierite/shared`'s `tool-descriptor.test.ts`.
final class CordieriteToolDescriptorTests: XCTestCase {
  func testValidMinimalDescriptor() throws {
    let descriptor = ToolDescriptor(name: "seed_cart", description: "Fill the cart.")
    XCTAssertNoThrow(try validateToolDescriptor(descriptor))
  }

  func testValidFullDescriptor() throws {
    let descriptor = ToolDescriptor(
      name: "seed-cart_2",
      description: "Fill the cart with test items.",
      inputSchema: ["type": .string("object")],
      outputSchema: ["type": .string("object")],
      annotations: ToolAnnotations(readOnlyHint: false, destructiveHint: true, idempotentHint: nil),
      timeoutMs: 5_000
    )
    XCTAssertNoThrow(try validateToolDescriptor(descriptor))
  }

  func testNameMustMatchPattern() {
    XCTAssertThrowsError(try validateToolDescriptor(ToolDescriptor(name: "has a space", description: "x")))
    XCTAssertThrowsError(try validateToolDescriptor(ToolDescriptor(name: "", description: "x")))
    XCTAssertThrowsError(try validateToolDescriptor(ToolDescriptor(name: String(repeating: "a", count: 65), description: "x")))
    XCTAssertNoThrow(try validateToolDescriptor(ToolDescriptor(name: String(repeating: "a", count: 64), description: "x")))
  }

  func testDescriptionMustBeNonEmptyAndBounded() {
    XCTAssertThrowsError(try validateToolDescriptor(ToolDescriptor(name: "tool", description: "")))
    XCTAssertThrowsError(
      try validateToolDescriptor(ToolDescriptor(name: "tool", description: String(repeating: "x", count: 4_097)))
    )
    XCTAssertNoThrow(
      try validateToolDescriptor(ToolDescriptor(name: "tool", description: String(repeating: "x", count: 4_096)))
    )
  }

  func testTimeoutMsMustBePositive() {
    XCTAssertThrowsError(try validateToolDescriptor(ToolDescriptor(name: "tool", description: "x", timeoutMs: 0)))
    XCTAssertThrowsError(try validateToolDescriptor(ToolDescriptor(name: "tool", description: "x", timeoutMs: -1)))
    XCTAssertNoThrow(try validateToolDescriptor(ToolDescriptor(name: "tool", description: "x", timeoutMs: 1)))
  }

  // MARK: parseToolDescriptor (wire JSON -> typed descriptor)

  func testParseRoundTripsWireShape() throws {
    let wire = JSONValue.object([
      "name": .string("seed_cart"),
      "description": .string("Fill the cart."),
      "input_schema": .object(["type": .string("object")]),
      "annotations": .object(["readOnlyHint": .bool(true)]),
      "timeout_ms": .number(2_500),
    ])
    let descriptor = try parseToolDescriptor(wire)
    XCTAssertEqual(descriptor.name, "seed_cart")
    XCTAssertEqual(descriptor.timeoutMs, 2_500)
    XCTAssertEqual(descriptor.annotations?.readOnlyHint, true)
  }

  func testParseRejectsUnknownAnnotationKey() {
    let wire = JSONValue.object([
      "name": .string("tool"),
      "description": .string("x"),
      "annotations": .object(["bogusHint": .bool(true)]),
    ])
    XCTAssertThrowsError(try parseToolDescriptor(wire))
  }

  func testParseRejectsNonObjectSchema() {
    let wire = JSONValue.object([
      "name": .string("tool"),
      "description": .string("x"),
      "input_schema": .string("not an object"),
    ])
    XCTAssertThrowsError(try parseToolDescriptor(wire))
  }

  func testParseRejectsNonIntegerTimeout() {
    let wire = JSONValue.object([
      "name": .string("tool"),
      "description": .string("x"),
      "timeout_ms": .number(2.5),
    ])
    XCTAssertThrowsError(try parseToolDescriptor(wire))
  }
}
