import 'dart:convert';
import 'dart:typed_data';

const startMs = 1700000000000;

/// A well-formed Appduct link for session [sessionId], valid for a minute after [startMs].
String playgroundLink({String sessionId = 'session-1'}) {
  final id = utf8.encode(sessionId);
  final bytes = BytesBuilder()
    ..add([2, 4, 192, 168, 1, 10, 0x20, 0xfb, id.length])
    ..add(id)
    ..add(List.filled(32, 7))
    ..add(
      (ByteData(8)..setUint64(0, startMs ~/ 1000 + 60)).buffer.asUint8List(),
    );
  final payload = base64Url.encode(bytes.toBytes()).replaceAll('=', '');
  return 'appduct-flutter:///?appduct=$payload';
}

/// The daemon's accepting answer to a claim.
Map<String, Object?> ack({String sessionId = 'session-1'}) => {
  'type': 'session_ack',
  'session_id': sessionId,
  'status': 'ok',
  'alias': 'pixel',
  'resume_token': 'resume-1',
  'keepalive_interval_s': 15,
  'grace_s': 600,
};
