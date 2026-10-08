import 'dart:async';
import 'dart:io';

import '../core/ports.dart';
import 'spki_pin.dart';
import 'trust.dart';

/// The pinned `wss` transport. The connection trusts no system root: the client's
/// [SecurityContext] is empty, so every certificate reaches `badCertificateCallback`, which
/// accepts a leaf only when the SHA-256 of its public key is one of the pins [TrustPolicy]
/// resolved. A connection that fails that check never gets an HTTP request out.
class IoTransport implements Transport {
  IoTransport(this._trust);

  final TrustPolicy _trust;

  /// Throws [TrustConfigError] when the build trusts the link's pin and [pin] is null.
  @override
  Socket open(Uri url, String? pin, SocketEvents events) {
    final pins = _trust.pinsFor(pin);
    final client = HttpClient(context: SecurityContext(withTrustedRoots: false))
      ..badCertificateCallback = (cert, host, port) {
        final actual = spkiPin(cert.der);
        return actual != null && pins.contains(actual);
      };
    return _IoSocket(url, client, events);
  }
}

class _IoSocket implements Socket {
  _IoSocket(Uri url, this._client, this._events) {
    unawaited(_connect(url));
  }

  final HttpClient _client;
  final SocketEvents _events;
  WebSocket? _ws;
  bool _closeRequested = false;
  bool _reportedClose = false;

  Future<void> _connect(Uri url) async {
    final WebSocket ws;
    try {
      ws = await WebSocket.connect(url.toString(), customClient: _client);
    } on Object catch (error) {
      _client.close(force: true);
      _events.onError(
        error is HandshakeException || error is TlsException
            ? 'TLS handshake failed: the daemon\'s key does not match the pin.'
            : 'Could not connect: $error',
      );
      _reportClose(null, null);
      return;
    }
    _ws = ws;
    if (_closeRequested) {
      unawaited(ws.close(1000));
    }

    ws.listen(
      (data) {
        if (data is String) {
          _events.onMessage(data);
        } else {
          close(1008, 'binary_frame_not_supported');
        }
      },
      onError: (Object error) => _events.onError('$error'),
      onDone: () {
        _client.close(force: true);
        _reportClose(ws.closeCode, ws.closeReason);
      },
      cancelOnError: false,
    );
    _events.onOpen();
  }

  void _reportClose(int? code, String? reason) {
    if (_reportedClose) return;
    _reportedClose = true;
    _events.onClose(code, reason);
  }

  @override
  void send(String text) {
    final ws = _ws;
    if (ws == null || _closeRequested || ws.readyState != WebSocket.open) {
      throw StateError('socket is not open');
    }
    ws.add(text);
  }

  @override
  void close(int code, String reason) {
    if (_closeRequested) return;
    _closeRequested = true;
    final ws = _ws;
    if (ws != null) unawaited(ws.close(code, reason));
  }

  @override
  void keepalive(Duration interval) {
    // Dart sends the pings and closes with 1001 when a pong goes missing.
    _ws?.pingInterval = interval;
  }
}
