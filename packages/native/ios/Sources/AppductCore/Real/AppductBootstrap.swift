// Vendored into @appduct/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if APPDUCT_ENABLED

import Foundation

/// Ports `@appduct/shared`'s `decodeBootstrap`/`isExpiredAt`/`isLocalAddress` and
/// `packages/react-native/src/bootstrap.ts`'s URL-layer wrapping (ARCHITECTURE.md §8) into Swift, so
/// `AppductClient.handleUrl` needs no JS round trip to judge a deep link.
public enum AppductAddressFamily: Int, Sendable, Equatable {
  case ipv4 = 4
  case ipv6 = 6
}

public struct AppductBootstrapPayload: Sendable, Equatable {
  public let family: AppductAddressFamily
  public let address: String
  public let port: Int
  public let sessionId: String
  /// Base64url (no padding) encoding of the 32 raw token bytes.
  public let token: String
  /// Unix seconds.
  public let expiresAt: Int
  /// The bootstrap deep link's separate `pin` query param (opt-in hardening dev-mode), if present
  /// and well-formed.
  public var linkPin: String?
}

public struct AppductBootstrapParseError: Error, Sendable, Equatable {
  public enum Code: String, Sendable {
    case invalidUrl = "invalid_url"
    case missingPayload = "missing_payload"
    case invalidPayload = "invalid_payload"
    case expiredPayload = "expired_payload"
  }
  public let code: Code
  public let message: String
  public init(_ code: Code, _ message: String) {
    self.code = code
    self.message = message
  }
}

private let bootstrapVersionV2: UInt8 = 0x02
private let familyIpv4: UInt8 = 0x04
private let familyIpv6: UInt8 = 0x06
private let tokenBytes = 32
private let expiresAtBytes = 8

private func decodeBase64Url(_ input: String) -> Data? {
  guard !input.isEmpty else { return nil }
  var normalized = input.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  let padLength = (4 - normalized.count % 4) % 4
  normalized += String(repeating: "=", count: padLength)
  return Data(base64Encoded: normalized)
}

private func encodeBase64Url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private func ipv4StringToBytes(_ ip: String) -> [UInt8]? {
  let parts = ip.split(separator: ".", omittingEmptySubsequences: false)
  guard parts.count == 4 else { return nil }
  var out: [UInt8] = []
  for part in parts {
    guard let value = Int(part), value >= 0, value <= 255 else { return nil }
    out.append(UInt8(value))
  }
  return out
}

private func bytesToIpv4String(_ bytes: [UInt8]) -> String {
  bytes.map { String($0) }.joined(separator: ".")
}

private func ipv6GroupsToBytes(_ groups: [Substring]) -> [UInt8]? {
  guard groups.count == 8 else { return nil }
  var out: [UInt8] = []
  for group in groups {
    guard group.count >= 1, group.count <= 4, let value = UInt16(group, radix: 16) else { return nil }
    out.append(UInt8(value >> 8))
    out.append(UInt8(value & 0xff))
  }
  return out
}

private func ipv6StringToBytes(_ address: String) -> [UInt8]? {
  guard !address.isEmpty, !address.contains("%") else { return nil }

  guard let doubleColonRange = address.range(of: "::") else {
    return ipv6GroupsToBytes(address.split(separator: ":", omittingEmptySubsequences: false))
  }

  let afterFirst = address[doubleColonRange.upperBound...]
  if afterFirst.range(of: "::") != nil {
    return nil
  }

  let head = String(address[address.startIndex..<doubleColonRange.lowerBound])
  let tail = String(afterFirst)
  let headParts = head.isEmpty ? [] : head.split(separator: ":", omittingEmptySubsequences: false)
  let tailParts = tail.isEmpty ? [] : tail.split(separator: ":", omittingEmptySubsequences: false)
  let missing = 8 - (headParts.count + tailParts.count)
  guard missing >= 0 else { return nil }

  let filled = headParts + Array(repeating: Substring("0"), count: missing) + tailParts
  return ipv6GroupsToBytes(filled)
}

private func bytesToIpv6String(_ bytes: [UInt8]) -> String {
  var groups: [UInt16] = []
  for i in 0..<8 {
    groups.append((UInt16(bytes[i * 2]) << 8) | UInt16(bytes[i * 2 + 1]))
  }

  var bestStart = -1
  var bestLen = 0
  var runStart = -1
  for i in 0...groups.count {
    let isZero = i < groups.count && groups[i] == 0
    if isZero {
      if runStart == -1 { runStart = i }
    } else if runStart != -1 {
      let runLen = i - runStart
      if runLen > bestLen {
        bestLen = runLen
        bestStart = runStart
      }
      runStart = -1
    }
  }

  if bestLen < 2 {
    return groups.map { String($0, radix: 16) }.joined(separator: ":")
  }

  let before = groups[0..<bestStart].map { String($0, radix: 16) }
  let after = groups[(bestStart + bestLen)...].map { String($0, radix: 16) }
  return "\(before.joined(separator: ":"))::\(after.joined(separator: ":"))"
}

/// Decodes and strictly validates a base64url bootstrap payload -- ports `decodeBootstrap` exactly:
/// rejects wrong version (including v1's), bad family byte, truncated/oversized buffers (exact
/// total-length check), non-UTF-8 session ids, and port 0.
public func decodeAppductBootstrap(_ b64url: String) -> AppductBootstrapPayload? {
  guard let decodedData = decodeBase64Url(b64url), decodedData.count >= 2 else { return nil }
  let bytes = [UInt8](decodedData)

  guard bytes[0] == bootstrapVersionV2 else { return nil }

  let familyByte = bytes[1]
  guard familyByte == familyIpv4 || familyByte == familyIpv6 else { return nil }
  let family: AppductAddressFamily = familyByte == familyIpv4 ? .ipv4 : .ipv6
  let addressLen = family == .ipv4 ? 4 : 16
  let headerLen = 1 + 1 + addressLen + 2

  guard bytes.count >= headerLen + 1 else { return nil }

  var offset = 2
  let addressBytes = Array(bytes[offset..<(offset + addressLen)])
  offset += addressLen

  let port = (Int(bytes[offset]) << 8) | Int(bytes[offset + 1])
  offset += 2

  guard bytes.count > offset else { return nil }

  let sessionIdLen = Int(bytes[offset])
  offset += 1

  let totalLen = offset + sessionIdLen + tokenBytes + expiresAtBytes
  guard sessionIdLen != 0, bytes.count == totalLen else { return nil }

  let sessionIdBytes = Array(bytes[offset..<(offset + sessionIdLen)])
  offset += sessionIdLen

  let tokenRaw = Array(bytes[offset..<(offset + tokenBytes)])
  offset += tokenBytes

  var expiresAt: UInt64 = 0
  for i in 0..<expiresAtBytes {
    expiresAt = (expiresAt << 8) | UInt64(bytes[offset + i])
  }

  guard port >= 1, port <= 65_535 else { return nil }
  guard let sessionId = String(bytes: sessionIdBytes, encoding: .utf8) else { return nil }

  let address = family == .ipv4 ? bytesToIpv4String(addressBytes) : bytesToIpv6String(addressBytes)

  return AppductBootstrapPayload(
    family: family,
    address: address,
    port: port,
    sessionId: sessionId,
    token: encodeBase64Url(Data(tokenRaw)),
    expiresAt: Int(expiresAt),
    linkPin: nil
  )
}

public func isAppductExpired(expiresAt: Int, now: Int) -> Bool {
  expiresAt <= now
}

private func isPrivateIpv4(_ value: String) -> Bool {
  guard let octets = ipv4StringToBytes(value) else { return false }
  let first = Int(octets[0])
  let second = Int(octets[1])
  return first == 10 || (first == 172 && second >= 16 && second <= 31) || (first == 192 && second == 168)
}

private func isLoopbackIpv4(_ value: String) -> Bool {
  guard let octets = ipv4StringToBytes(value) else { return false }
  return octets[0] == 127
}

private func isLocalIpv6(_ value: String) -> Bool {
  let normalized = value.lowercased()
  if normalized == "::1" { return true }
  if normalized.range(of: "^fe80:", options: .regularExpression) != nil { return true }
  if normalized.range(of: "^f[cd][0-9a-f]{2}:", options: .regularExpression) != nil { return true }
  return false
}

public func isAppductLocalAddress(family: AppductAddressFamily, address: String) -> Bool {
  family == .ipv4 ? (isPrivateIpv4(address) || isLoopbackIpv4(address)) : isLocalIpv6(address)
}

/// True if `rawUrl` parses as a URL and includes a `appduct` query parameter -- ports
/// `hasAppductBootstrapQuery` exactly.
public func hasAppductBootstrapQuery(_ rawUrl: String?) -> Bool {
  guard let rawUrl, let components = URLComponents(string: rawUrl) else { return false }
  return components.queryItems?.contains { $0.name == "appduct" } ?? false
}

/// `sha256/` + 44 base64 chars (32-byte digest, standard alphabet incl. padding).
private let linkPinPattern = "^sha256/[A-Za-z0-9+/]{43}=$"

func extractAppductLinkPin(from components: URLComponents) -> String? {
  guard let pin = components.queryItems?.first(where: { $0.name == "pin" })?.value else { return nil }
  guard pin.range(of: linkPinPattern, options: .regularExpression) != nil else { return nil }
  return pin
}

/// Ports `parseBootstrapUrl` (via `parseBootstrapPayload`): decodes the `appduct` query param,
/// checks expiry, optionally requires a private/loopback address, and folds in the sibling `pin`
/// param.
public func parseAppductBootstrapUrl(
  _ rawUrl: String,
  now: Int,
  requirePrivateIp: Bool
) throws -> AppductBootstrapPayload {
  guard let components = URLComponents(string: rawUrl) else {
    throw AppductBootstrapParseError(.invalidUrl, "Invalid bootstrap URL.")
  }

  guard let payload = components.queryItems?.first(where: { $0.name == "appduct" })?.value, !payload.isEmpty else {
    throw AppductBootstrapParseError(.missingPayload, "Bootstrap URL is missing the appduct query parameter.")
  }

  guard let decoded = decodeAppductBootstrap(payload) else {
    throw AppductBootstrapParseError(
      .invalidPayload,
      "Bootstrap payload must be a valid base64url-encoded v2 bootstrap blob (see Appduct HANDSHAKE docs)."
    )
  }

  if isAppductExpired(expiresAt: decoded.expiresAt, now: now) {
    throw AppductBootstrapParseError(.expiredPayload, "Bootstrap payload has expired.")
  }

  if requirePrivateIp && !isAppductLocalAddress(family: decoded.family, address: decoded.address) {
    throw AppductBootstrapParseError(.invalidPayload, "Bootstrap payload is invalid.")
  }

  var result = decoded
  result.linkPin = extractAppductLinkPin(from: components)
  return result
}

#endif
