import 'dart:async';
import 'dart:convert';

import 'ports.dart';

/// One socket the core opened, driven by the test.
class MemorySocket implements Socket {
  MemorySocket._(this.url, this.pin, this._events);

  final Uri url;
  final String? pin;
  final SocketEvents _events;

  /// Text frames the core sent, in order.
  final List<String> sent = [];

  /// The interval the core asked the socket to ping at, once it asked.
  Duration? keepaliveInterval;

  bool _isOpen = false;
  bool _closed = false;
  ({int code, String reason})? _closedByCore;

  /// Frames the core sent, parsed.
  List<Map<String, Object?>> frames() => [
    for (final text in sent) (jsonDecode(text) as Map).cast<String, Object?>(),
  ];

  /// How the core closed the socket, once it did.
  ({int code, String reason})? get closedByCore => _closedByCore;

  /// The socket opens; the core sends its first frame.
  void open() {
    _isOpen = true;
    _events.onOpen();
  }

  /// The daemon sends a frame; a non-string is sent as JSON.
  void receive(Object frame) {
    _events.onMessage(frame is String ? frame : jsonEncode(frame));
  }

  /// The daemon closes the socket.
  void closeFromDaemon([int? code, String? reason]) =>
      _deliverClose(code, reason);

  /// The connection drops: an error, then a close with no code.
  void drop([String message = 'connection dropped']) {
    if (_closed) return;
    _events.onError(message);
    _deliverClose(null, null);
  }

  /// The daemon's key does not match the pin: the transport says so, then the connection closes
  /// with no code.
  void rejectPin() {
    if (_closed) return;
    _events.onPinMismatch();
    _events.onError('pin mismatch');
    _deliverClose(null, null);
  }

  /// The socket's own keepalive gave up waiting for a pong: it closes with 1001, which the core
  /// resumes from.
  void missPong() => _deliverClose(1001, 'ping_timeout');

  void _deliverClose(int? code, String? reason) {
    if (_closed) return;
    _closed = true;
    _isOpen = false;
    _events.onClose(code, reason);
  }

  @override
  void send(String text) {
    if (!_isOpen) throw StateError('socket is not open');
    sent.add(text);
  }

  @override
  void close(int code, String reason) {
    if (_closed || _closedByCore != null) return;
    _closedByCore = (code: code, reason: reason);
    // A real socket reports the close after the call returns.
    scheduleMicrotask(() => _deliverClose(code, reason));
  }

  @override
  void keepalive(Duration interval) => keepaliveInterval = interval;
}

class MemoryTransport implements Transport {
  /// Every socket the core opened, oldest first.
  final List<MemorySocket> sockets = [];
  Object? _nextOpenError;

  /// The next `open` throws [error].
  void failNextOpen(Object error) => _nextOpenError = error;

  @override
  Socket open(Uri url, String? pin, SocketEvents events) {
    final error = _nextOpenError;
    if (error != null) {
      _nextOpenError = null;
      throw error;
    }
    final socket = MemorySocket._(url, pin, events);
    sockets.add(socket);
    return socket;
  }
}
