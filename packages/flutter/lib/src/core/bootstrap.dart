import 'dart:convert';
import 'dart:typed_data';

/// A decoded v2 bootstrap payload (`docs/PROTOCOL.md` section 2).
class Bootstrap {
  const Bootstrap({
    required this.family,
    required this.address,
    required this.port,
    required this.sessionId,
    required this.token,
    required this.expiresAt,
  });

  /// 4 or 6.
  final int family;
  final String address;
  final int port;
  final String sessionId;

  /// Base64url, no padding, of the 32 raw token bytes.
  final String token;

  /// Unix seconds.
  final int expiresAt;
}

/// The two query values of a bootstrap deep link.
class BootstrapLink {
  const BootstrapLink({required this.payload, this.pin});

  /// The raw `appduct` value, still base64url.
  final String payload;

  /// The `pin` value when it has the shape `sha256/<43 base64 chars>=`; a malformed pin counts as
  /// absent.
  final String? pin;
}

const _versionV2 = 0x02;
const _familyIpv4 = 0x04;
const _familyIpv6 = 0x06;
const _tokenBytes = 32;
const _expiresAtBytes = 8;

final _pinPattern = RegExp(r'^sha256/[A-Za-z0-9+/]{43}=$');

/// Reads the `appduct` and `pin` query values of `<scheme>:///?appduct=<payload>&pin=...`.
/// Returns null when the link has no `appduct` value or is not a URL.
BootstrapLink? parseBootstrapLink(String url) {
  final Uri uri;
  try {
    uri = Uri.parse(url);
  } on FormatException {
    return null;
  }

  final payload = uri.queryParametersAll['appduct']?.first;
  if (payload == null) return null;

  final pin = uri.queryParametersAll['pin']?.first;
  return BootstrapLink(
    payload: payload,
    pin: pin != null && _pinPattern.hasMatch(pin) ? pin : null,
  );
}

/// Strictly decodes a base64url bootstrap payload. Returns null for a wrong version (v1
/// included), an unknown family byte, a buffer of the wrong total length, an empty session id,
/// invalid UTF-8 in the session id, or port 0 — never a partial result.
Bootstrap? decodeBootstrap(String base64url) {
  final bytes = _decodeBase64Url(base64url);
  if (bytes == null || bytes.length < 2 || bytes[0] != _versionV2) return null;

  final family = bytes[1];
  if (family != _familyIpv4 && family != _familyIpv6) return null;

  final addressLength = family == _familyIpv4 ? 4 : 16;
  final portOffset = 2 + addressLength;
  if (bytes.length < portOffset + 3) return null;

  final view = ByteData.sublistView(bytes);
  final port = view.getUint16(portOffset);
  final sessionIdLength = bytes[portOffset + 2];
  final sessionIdOffset = portOffset + 3;
  final tokenOffset = sessionIdOffset + sessionIdLength;

  if (sessionIdLength == 0 ||
      bytes.length != tokenOffset + _tokenBytes + _expiresAtBytes) {
    return null;
  }
  if (port == 0) return null;

  final String sessionId;
  try {
    sessionId = utf8.decode(bytes.sublist(sessionIdOffset, tokenOffset));
  } on FormatException {
    return null;
  }

  final address = bytes.sublist(2, portOffset);
  return Bootstrap(
    family: family == _familyIpv4 ? 4 : 6,
    address: family == _familyIpv4 ? address.join('.') : _formatIpv6(address),
    port: port,
    sessionId: sessionId,
    token: base64Url
        .encode(bytes.sublist(tokenOffset, tokenOffset + _tokenBytes))
        .replaceAll('=', ''),
    expiresAt: view.getUint64(tokenOffset + _tokenBytes),
  );
}

Uint8List? _decodeBase64Url(String input) {
  if (input.isEmpty) return null;
  try {
    return base64Url.decode(base64Url.normalize(input));
  } on FormatException {
    return null;
  }
}

/// Lowercase hex groups, with the first longest run of two or more zero groups written as `::`.
String _formatIpv6(Uint8List bytes) {
  final groups = [
    for (var i = 0; i < 16; i += 2) (bytes[i] << 8) | bytes[i + 1],
  ];

  var bestStart = -1;
  var bestLength = 0;
  var runStart = -1;
  for (var i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] == 0) {
      if (runStart == -1) runStart = i;
      continue;
    }
    if (runStart != -1 && i - runStart > bestLength) {
      bestStart = runStart;
      bestLength = i - runStart;
    }
    runStart = -1;
  }

  String hex(Iterable<int> values) =>
      values.map((g) => g.toRadixString(16)).join(':');
  if (bestLength < 2) return hex(groups);
  return '${hex(groups.take(bestStart))}::${hex(groups.skip(bestStart + bestLength))}';
}
