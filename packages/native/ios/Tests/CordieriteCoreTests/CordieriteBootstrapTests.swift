import XCTest
@testable import CordieriteCore

/// Ports the relevant halves of `@cordierite/shared`'s `bootstrap.test.ts` and
/// `packages/react-native/src/__tests__/bootstrap.test.ts` / `deep-link-bootstrap.test.ts`.
final class CordieriteBootstrapTests: XCTestCase {
  private func encode(
    family: CordieriteAddressFamily = .ipv4,
    address: String = "192.168.1.10",
    port: Int = 8_443,
    sessionId: String = "session-1",
    tokenByte: UInt8 = 0x01,
    expiresAt: Int
  ) -> String {
    var bytes: [UInt8] = [0x02, family == .ipv4 ? 0x04 : 0x06]
    if family == .ipv4 {
      bytes += address.split(separator: ".").map { UInt8($0)! }
    } else {
      // Not exercised by these tests but kept for completeness.
      bytes += [UInt8](repeating: 0, count: 16)
    }
    bytes += [UInt8(port >> 8), UInt8(port & 0xff)]
    let sessionIdBytes = Array(sessionId.utf8)
    bytes.append(UInt8(sessionIdBytes.count))
    bytes += sessionIdBytes
    bytes += [UInt8](repeating: tokenByte, count: 32)
    for shift in stride(from: 56, through: 0, by: -8) {
      bytes.append(UInt8((expiresAt >> shift) & 0xff))
    }
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  func testDecodesValidV2Payload() throws {
    let payload = encode(expiresAt: 4_000_000_000)
    let decoded = try XCTUnwrap(decodeCordieriteBootstrap(payload))
    XCTAssertEqual(decoded.family, .ipv4)
    XCTAssertEqual(decoded.address, "192.168.1.10")
    XCTAssertEqual(decoded.port, 8_443)
    XCTAssertEqual(decoded.sessionId, "session-1")
    XCTAssertEqual(decoded.expiresAt, 4_000_000_000)
    XCTAssertEqual(decoded.token.count, 43) // 32 bytes base64url, no padding
  }

  func testRejectsWrongVersionByte() {
    var bytes: [UInt8] = [0x01, 0x04] // v1 version byte
    bytes += [192, 168, 1, 10, 0x20, 0xfb]
    bytes.append(9)
    bytes += Array("session-1".utf8)
    bytes += [UInt8](repeating: 1, count: 32)
    bytes += [UInt8](repeating: 0, count: 8)
    let payload = Data(bytes).base64EncodedString()
    XCTAssertNil(decodeCordieriteBootstrap(payload))
  }

  func testRejectsBadFamilyByte() {
    var bytes: [UInt8] = [0x02, 0x99]
    bytes += [UInt8](repeating: 0, count: 20)
    let payload = Data(bytes).base64EncodedString()
    XCTAssertNil(decodeCordieriteBootstrap(payload))
  }

  func testRejectsTruncatedBuffer() {
    let full = encode(expiresAt: 4_000_000_000)
    let truncated = String(full.dropLast(4))
    XCTAssertNil(decodeCordieriteBootstrap(truncated))
  }

  func testRejectsZeroSessionIdLength() {
    var bytes: [UInt8] = [0x02, 0x04]
    bytes += [192, 168, 1, 10]
    bytes += [0x20, 0xfb]
    bytes.append(0) // sessionIdLen = 0
    bytes += [UInt8](repeating: 1, count: 32)
    bytes += [UInt8](repeating: 0, count: 8)
    let payload = Data(bytes).base64EncodedString()
    XCTAssertNil(decodeCordieriteBootstrap(payload))
  }

  func testRejectsPortZero() {
    let payload = encode(port: 0, expiresAt: 4_000_000_000)
    XCTAssertNil(decodeCordieriteBootstrap(payload))
  }

  func testIsExpired() {
    XCTAssertTrue(isCordieriteExpired(expiresAt: 100, now: 100))
    XCTAssertTrue(isCordieriteExpired(expiresAt: 100, now: 101))
    XCTAssertFalse(isCordieriteExpired(expiresAt: 100, now: 99))
  }

  func testLocalAddressClassification() {
    XCTAssertTrue(isCordieriteLocalAddress(family: .ipv4, address: "192.168.1.10"))
    XCTAssertTrue(isCordieriteLocalAddress(family: .ipv4, address: "10.0.0.1"))
    XCTAssertTrue(isCordieriteLocalAddress(family: .ipv4, address: "172.16.0.1"))
    XCTAssertTrue(isCordieriteLocalAddress(family: .ipv4, address: "127.0.0.1"))
    XCTAssertFalse(isCordieriteLocalAddress(family: .ipv4, address: "8.8.8.8"))
    XCTAssertTrue(isCordieriteLocalAddress(family: .ipv6, address: "::1"))
    XCTAssertTrue(isCordieriteLocalAddress(family: .ipv6, address: "fd00::1"))
    XCTAssertTrue(isCordieriteLocalAddress(family: .ipv6, address: "fe80::1"))
    XCTAssertFalse(isCordieriteLocalAddress(family: .ipv6, address: "2001:db8::1"))
  }

  func testHasCordieriteBootstrapQuery() {
    XCTAssertTrue(hasCordieriteBootstrapQuery("myapp://open?cordierite=abc123"))
    XCTAssertFalse(hasCordieriteBootstrapQuery("myapp://open?other=abc123"))
    XCTAssertFalse(hasCordieriteBootstrapQuery(nil))
    XCTAssertFalse(hasCordieriteBootstrapQuery(""))
  }

  func testParseBootstrapUrlHappyPath() throws {
    let payload = encode(expiresAt: 4_000_000_000)
    let url = "myapp://open?cordierite=\(payload)"
    let decoded = try parseCordieriteBootstrapUrl(url, now: 1_000, requirePrivateIp: true)
    XCTAssertEqual(decoded.sessionId, "session-1")
    XCTAssertNil(decoded.linkPin)
  }

  func testParseBootstrapUrlExtractsValidLinkPin() throws {
    let payload = encode(expiresAt: 4_000_000_000)
    let pin = "sha256/" + String(repeating: "A", count: 43) + "="
    let url = "myapp://open?cordierite=\(payload)&pin=\(pin)"
    let decoded = try parseCordieriteBootstrapUrl(url, now: 1_000, requirePrivateIp: true)
    XCTAssertEqual(decoded.linkPin, pin)
  }

  func testParseBootstrapUrlIgnoresMalformedLinkPin() throws {
    let payload = encode(expiresAt: 4_000_000_000)
    let url = "myapp://open?cordierite=\(payload)&pin=not-a-real-pin"
    let decoded = try parseCordieriteBootstrapUrl(url, now: 1_000, requirePrivateIp: true)
    XCTAssertNil(decoded.linkPin)
  }

  func testParseBootstrapUrlRejectsExpired() {
    let payload = encode(expiresAt: 1_000)
    let url = "myapp://open?cordierite=\(payload)"
    XCTAssertThrowsError(try parseCordieriteBootstrapUrl(url, now: 2_000, requirePrivateIp: true)) { error in
      XCTAssertEqual((error as? CordieriteBootstrapParseError)?.code, .expiredPayload)
    }
  }

  func testParseBootstrapUrlRejectsNonPrivateAddressWhenRequired() {
    let payload = encode(address: "8.8.8.8", expiresAt: 4_000_000_000)
    let url = "myapp://open?cordierite=\(payload)"
    XCTAssertThrowsError(try parseCordieriteBootstrapUrl(url, now: 1_000, requirePrivateIp: true)) { error in
      XCTAssertEqual((error as? CordieriteBootstrapParseError)?.code, .invalidPayload)
    }
  }

  func testParseBootstrapUrlAllowsNonPrivateAddressWhenNotRequired() throws {
    let payload = encode(address: "8.8.8.8", expiresAt: 4_000_000_000)
    let url = "myapp://open?cordierite=\(payload)"
    let decoded = try parseCordieriteBootstrapUrl(url, now: 1_000, requirePrivateIp: false)
    XCTAssertEqual(decoded.address, "8.8.8.8")
  }

  func testParseBootstrapUrlMissingPayload() {
    XCTAssertThrowsError(try parseCordieriteBootstrapUrl("myapp://open", now: 1_000, requirePrivateIp: true)) { error in
      XCTAssertEqual((error as? CordieriteBootstrapParseError)?.code, .missingPayload)
    }
  }
}
