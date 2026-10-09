import 'dart:convert';

import 'json.dart';

const _schemaVersion = 1;

/// What a resume needs, kept in the [SessionStore] as JSON. Port of the native `ResumeLeaseV1`.
class ResumeLease {
  const ResumeLease({
    required this.sessionId,
    required this.resumeToken,
    required this.alias,
    required this.ip,
    required this.port,
    required this.keepaliveIntervalS,
    required this.graceS,
    this.linkPin,
    this.disconnectedAtMs,
  });

  final String sessionId;
  final String resumeToken;
  final String alias;
  final String ip;
  final int port;
  final num keepaliveIntervalS;
  final num graceS;

  /// The SPKI pin the claim was made with, so a resume talks to the same daemon.
  final String? linkPin;

  /// When the socket was first lost, in unix milliseconds; null while it is up.
  final int? disconnectedAtMs;

  ResumeLease disconnectedAt(int nowMs) => ResumeLease(
    sessionId: sessionId,
    resumeToken: resumeToken,
    alias: alias,
    ip: ip,
    port: port,
    keepaliveIntervalS: keepaliveIntervalS,
    graceS: graceS,
    linkPin: linkPin,
    disconnectedAtMs: nowMs,
  );

  bool isExpiredAt(int nowMs) =>
      disconnectedAtMs != null &&
      nowMs - disconnectedAtMs! >= (graceS * 1000).truncate();

  String encode() => jsonEncode({
    'schemaVersion': _schemaVersion,
    'sessionId': sessionId,
    'resumeToken': resumeToken,
    'alias': alias,
    'endpoint': {'ip': ip, 'port': port},
    'keepaliveIntervalS': keepaliveIntervalS,
    'graceS': graceS,
    'linkPin': linkPin,
    'disconnectedAtMs': disconnectedAtMs,
  });
}

bool _isPositiveFinite(Object? value) =>
    isFiniteNumber(value) && (value! as num) > 0;

/// Reads a stored lease, or null when the value is not a valid one.
ResumeLease? parseResumeLease(String? raw) {
  if (raw == null) return null;
  final Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } on FormatException {
    return null;
  }
  final json = asObject(decoded);
  final endpoint = asObject(json?['endpoint']);
  if (json == null || endpoint == null) return null;

  final port = endpoint['port'];
  final linkPin = json['linkPin'];
  final disconnectedAtMs = json['disconnectedAtMs'];
  if (json['schemaVersion'] != _schemaVersion ||
      !isBoundedString(json['sessionId'], maxWireIdLength) ||
      !isBoundedString(json['resumeToken'], maxWireIdLength) ||
      !isBoundedString(json['alias'], maxWireIdLength) ||
      !isBoundedString(endpoint['ip'], maxWireStringLength) ||
      port is! int ||
      port < 1 ||
      port > 65535 ||
      !_isPositiveFinite(json['keepaliveIntervalS']) ||
      !_isPositiveFinite(json['graceS']) ||
      (linkPin != null && linkPin is! String) ||
      (disconnectedAtMs != null &&
          (disconnectedAtMs is! int || disconnectedAtMs < 0))) {
    return null;
  }

  return ResumeLease(
    sessionId: json['sessionId']! as String,
    resumeToken: json['resumeToken']! as String,
    alias: json['alias']! as String,
    ip: endpoint['ip']! as String,
    port: port,
    keepaliveIntervalS: json['keepaliveIntervalS']! as num,
    graceS: json['graceS']! as num,
    linkPin: linkPin as String?,
    disconnectedAtMs: disconnectedAtMs as int?,
  );
}
