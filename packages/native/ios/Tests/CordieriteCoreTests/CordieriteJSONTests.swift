import XCTest
@testable import CordieriteCore

final class CordieriteJSONTests: XCTestCase {
  func testRoundTripsObject() throws {
    let value = JSONValue.object([
      "a": .number(1),
      "b": .string("two"),
      "c": .bool(true),
      "d": .null,
      "e": .array([.number(1), .number(2)]),
    ])
    let text = try value.serialized()
    let parsed = try JSONValue.parse(text)
    XCTAssertEqual(parsed, value)
  }

  func testRejectsNonFiniteNumbers() {
    XCTAssertThrowsError(try JSONValue.number(.nan).serialized())
    XCTAssertThrowsError(try JSONValue.number(.infinity).serialized())
    XCTAssertThrowsError(try JSONValue.object(["x": .number(.infinity)]).serialized())
  }

  func testParsesTopLevelScalars() throws {
    XCTAssertEqual(try JSONValue.parse("42"), .number(42))
    XCTAssertEqual(try JSONValue.parse("\"hi\""), .string("hi"))
    XCTAssertEqual(try JSONValue.parse("true"), .bool(true))
    XCTAssertEqual(try JSONValue.parse("null"), .null)
  }

  func testBoolAndNumberAreDistinguished() throws {
    let object = try XCTUnwrap(JSONValue.from(foundation: ["flag": true, "count": 1]).objectValue)
    XCTAssertEqual(object["flag"], .bool(true))
    XCTAssertEqual(object["count"], .number(1))
  }
}
