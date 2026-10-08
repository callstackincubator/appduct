import 'dart:async';
import 'dart:convert';

import 'lease.dart';
import 'messages.dart';
import 'ports.dart';

/// The daemon closes the socket with 1009 on a larger frame (`docs/PROTOCOL.md` section 3).
const maxFrameBytes = 262144;

const _missedPingsBeforeLoss = 2;

/// An outgoing frame over the daemon's limit; refused before it reaches the socket.
class FrameTooLargeException implements Exception {
  FrameTooLargeException(int bytes)
    : message =
          'Appduct frame is $bytes bytes, over the $maxFrameBytes-byte limit.';

  final String message;

  @override
  String toString() => message;
}

class ConnectionOptions {
  const ConnectionOptions({
    required this.ip,
    required this.port,
    required this.sessionId,
    this.token,
    this.resumeToken,
    this.pin,
    this.deviceManufacturer,
    this.deviceModel,
    this.deviceOs,
  });

  final String ip;
  final int port;
  final String sessionId;

  /// Sends `session_claim`.
  final String? token;

  /// Sends `session_resume` instead.
  final String? resumeToken;
  final String? pin;
  final String? deviceManufacturer;
  final String? deviceModel;
  final String? deviceOs;
}

class ConnectionHandlers {
  const ConnectionHandlers({
    required this.onAck,
    required this.onMessage,
    required this.onClose,
  });

  /// The first frame after the one we sent: a valid `session_ack` for the session we asked for.
  final void Function(SessionAck ack) onAck;

  /// A frame after the ack, for the session this connection holds.
  final void Function(WireMessage message) onMessage;

  /// The socket closed on its own. Not called for a close this side asked for with [Connection.close].
  final void Function(int? code, String? reason, String? error) onClose;
}

enum _Phase { connecting, active, failed }

class _Current {
  _Current(this.options);

  final ConnectionOptions options;
  Socket? socket;
  _Phase phase = _Phase.connecting;
  String? lastError;

  /// Why this side closed the socket, reported from `onClose` in place of the echoed wire code.
  ({int code, String reason})? closedByCore;

  TimerHandle? keepalive;
  int missedPings = 0;
}

bool _isJsonObject(String text) {
  try {
    return jsonDecode(text) is Map;
  } on FormatException {
    return false;
  }
}

/// One socket to the daemon: the first frame, the ack check, the lease the ack hands us, the
/// keepalive pings and the session-id rule for every later frame (`docs/PROTOCOL.md` sections 3
/// and 4). Port of the web core's `createConnection`, plus the pings the browser sends itself.
class Connection {
  Connection({
    required Transport transport,
    required SessionStore sessionStore,
    required Clock clock,
    required DeviceFields device,
    required ConnectionHandlers handlers,
  }) : _transport = transport,
       _sessionStore = sessionStore,
       _clock = clock,
       _device = device,
       _handlers = handlers;

  final Transport _transport;
  final SessionStore _sessionStore;
  final Clock _clock;
  final DeviceFields _device;
  final ConnectionHandlers _handlers;
  _Current? _current;

  /// Whether a socket is connecting or active.
  bool get isBusy => _current != null && _current!.phase != _Phase.failed;

  void _markDisconnected(String sessionId) {
    final lease = parseResumeLease(_sessionStore.read());
    if (lease == null ||
        lease.sessionId != sessionId ||
        lease.disconnectedAtMs != null) {
      return;
    }
    _sessionStore.write(lease.disconnectedAt(_clock.now()).encode());
  }

  void _stopKeepalive(_Current entry) {
    final timer = entry.keepalive;
    if (timer != null) _clock.clearTimeout(timer);
    entry.keepalive = null;
  }

  void _fail(_Current entry, String message, int code, String reason) {
    _stopKeepalive(entry);
    entry.phase = _Phase.failed;
    entry.lastError = message;
    entry.closedByCore = (code: code, reason: reason);
    entry.socket?.close(code, reason);
  }

  WireMessage _firstFrame(ConnectionOptions options) {
    final resumeToken = options.resumeToken;
    if (resumeToken != null) {
      return SessionResume(
        sessionId: options.sessionId,
        resumeToken: resumeToken,
      );
    }
    return SessionClaim(
      sessionId: options.sessionId,
      token: options.token!,
      deviceManufacturer: options.deviceManufacturer ?? _device.manufacturer,
      deviceModel: options.deviceModel ?? _device.model,
      deviceOs: options.deviceOs ?? _device.os,
    );
  }

  bool _isAcceptable(WireMessage? message, ConnectionOptions options) =>
      message is SessionAck &&
      message.sessionId == options.sessionId &&
      message.keepaliveIntervalS > 0 &&
      message.graceS > 0;

  void _scheduleKeepalive(_Current entry, SessionAck ack) {
    final intervalMs = (ack.keepaliveIntervalS * 1000).round();
    void tick() {
      entry.keepalive = _clock.setTimeout(tick, intervalMs);
      unawaited(
        entry.socket!.ping().then(
          (_) => entry.missedPings = 0,
          onError: (Object _) {
            entry.missedPings += 1;
            if (entry.missedPings >= _missedPingsBeforeLoss &&
                _current == entry &&
                entry.phase == _Phase.active) {
              _fail(
                entry,
                'Appduct keepalive ping went unanswered.',
                1011,
                'ping_timeout',
              );
            }
          },
        ),
      );
    }

    entry.keepalive = _clock.setTimeout(tick, intervalMs);
  }

  void _handleMessage(_Current entry, String text) {
    final message = decodeFrame(text);
    if (message == null && !_isJsonObject(text)) {
      _fail(
        entry,
        'Incoming Appduct message must be a JSON object.',
        1008,
        'invalid_message',
      );
      return;
    }

    if (entry.phase == _Phase.connecting) {
      if (!_isAcceptable(message, entry.options)) {
        _fail(
          entry,
          'Appduct session acknowledgement was invalid.',
          1008,
          'invalid_ack',
        );
        return;
      }
      final ack = message! as SessionAck;
      // Stored before anyone hears of the ack, so a restart right after still has the rotated token.
      _sessionStore.write(
        ResumeLease(
          sessionId: ack.sessionId,
          resumeToken: ack.resumeToken,
          alias: ack.alias,
          ip: entry.options.ip,
          port: entry.options.port,
          keepaliveIntervalS: ack.keepaliveIntervalS,
          graceS: ack.graceS,
          linkPin: entry.options.pin,
        ).encode(),
      );
      entry.phase = _Phase.active;
      _scheduleKeepalive(entry, ack);
      _handlers.onAck(ack);
      return;
    }

    if (message == null || message is UnknownMessage) return;
    if (message.sessionId != entry.options.sessionId) {
      _fail(
        entry,
        'Incoming Appduct message does not match the active session.',
        1008,
        'session_mismatch',
      );
      return;
    }
    _handlers.onMessage(message);
  }

  /// Opens a socket; the first frame goes out once it is open. Throws if the transport cannot open.
  void open(ConnectionOptions options) {
    final entry = _Current(options);
    _current = entry;
    try {
      entry.socket = _transport.open(
        Uri(scheme: 'wss', host: options.ip, port: options.port),
        options.pin,
        SocketEvents(
          onOpen: () {
            if (_current != entry || entry.socket == null) return;
            try {
              entry.socket!.send(encodeFrame(_firstFrame(options)));
            } on Object {
              _fail(
                entry,
                'Appduct session claim could not be sent because the socket is closing.',
                1011,
                'send_failed',
              );
            }
          },
          onMessage: (text) {
            if (_current == entry) _handleMessage(entry, text);
          },
          onError: (message) {
            if (_current == entry) entry.lastError = message;
          },
          onClose: (code, reason) {
            if (_current != entry) return;
            _current = null;
            _stopKeepalive(entry);
            final byCore = entry.closedByCore;
            if (byCore != null) (code, reason) = (byCore.code, byCore.reason);
            if (code == 1000) {
              _sessionStore.clear();
            } else {
              _markDisconnected(options.sessionId);
            }
            _handlers.onClose(
              code,
              reason == null || reason.isEmpty ? null : reason,
              entry.lastError,
            );
          },
        ),
      );
    } on Object {
      _current = null;
      rethrow;
    }
  }

  /// Throws unless active, or if the frame is for another session, or if it is over
  /// [maxFrameBytes] ([FrameTooLargeException]). A frame JSON cannot encode throws
  /// [JsonUnsupportedObjectError]; nothing is sent in either case.
  void send(WireMessage frame) {
    final entry = _current;
    final socket = entry?.socket;
    if (entry == null || entry.phase != _Phase.active || socket == null) {
      throw StateError('Appduct session is not active.');
    }
    if (frame.sessionId != entry.options.sessionId) {
      throw StateError(
        'Outgoing Appduct message session_id does not match the active session.',
      );
    }
    final text = encodeFrame(frame);
    final bytes = utf8.encode(text).length;
    if (bytes > maxFrameBytes) throw FrameTooLargeException(bytes);
    try {
      socket.send(text);
    } on Object {
      const message =
          'Appduct message could not be sent because the socket is closing.';
      _fail(entry, message, 1011, 'send_failed');
      throw StateError(message);
    }
  }

  /// Closes with 1001 `app_backgrounded` and keeps the lease. The close reaches `onClose` like any
  /// other, with that code and reason.
  void suspend() {
    final entry = _current;
    if (entry == null || entry.phase != _Phase.active) return;
    _fail(entry, 'The app went to the background.', 1001, 'app_backgrounded');
  }

  /// Closes with 1000 and forgets the stored lease. Nothing is reported for it afterwards.
  void close() {
    _sessionStore.clear();
    final entry = _current;
    _current = null;
    if (entry != null) _stopKeepalive(entry);
    entry?.socket?.close(1000, 'client_close');
  }
}
