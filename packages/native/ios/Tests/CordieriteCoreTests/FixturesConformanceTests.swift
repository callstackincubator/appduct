import XCTest
@testable import CordieriteCore

/// Cross-language conformance fixtures (issue #48, "Parity is the risk"): every vector loaded
/// here also loads and asserts in TypeScript
/// (`packages/shared/src/__tests__/fixtures-conformance.test.ts`,
/// `packages/cordierite/src/__tests__/spki-pin.test.ts`) and Kotlin
/// (`packages/native/android/core/src/test/.../FixturesConformanceTest.kt`) against their own
/// implementations of the same rules. See `packages/native/fixtures/README.md` for the rule that
/// a divergence found this way is fixed in the implementation that disagrees with
/// `docs/PROTOCOL.md`, never in the fixture.
final class FixturesConformanceTests: XCTestCase {
  /// `packages/native/fixtures`, located relative to this file's own path (this test target has
  /// no bundle resource copying set up for arbitrary repo-relative files, so `#filePath` is the
  /// only stable anchor): this file lives at
  /// `packages/native/ios/Tests/CordieriteCoreTests/FixturesConformanceTests.swift`, three
  /// directories below `packages/native`.
  private static let fixturesDirectory: URL = {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // FixturesConformanceTests.swift -> CordieriteCoreTests/
      .deletingLastPathComponent() // CordieriteCoreTests/ -> Tests/
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
      let decoded = decodeCordieriteBootstrap(base64url)

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

      let cordieriteValue = components.queryItems?.first(where: { $0.name == "cordierite" })?.value
      XCTAssertEqual(cordieriteValue, payloads[payloadIndex]["base64url"] as? String, name)

      let pin = extractCordieriteLinkPin(from: components)
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

  // MARK: - close-codes.json

  func testCloseCodesFixture() throws {
    let vectors = try Self.loadFixture("close-codes.json") as! [[String: Any]]
    XCTAssertGreaterThan(vectors.count, 0)

    for (index, vector) in vectors.enumerated() {
      let code = Self.intValue(vector["code"])
      let reason = vector["reason"] as? String
      let terminal = vector["terminal"] as! Bool
      let event = CordieriteCloseEvent(code: code, reason: reason)

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

    let manager = CordieriteConnectionManager()
    let pin = try manager.spkiPin(for: certificate)

    XCTAssertEqual(pin, expectedPin)
  }
}
