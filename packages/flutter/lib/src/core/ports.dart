/// What the core needs from outside the process. Each port has a memory fake beside it.
library;

/// Callbacks the transport invokes for one socket. A socket that fails reports [onError] and then
/// [onClose] with no code.
class SocketEvents {
  const SocketEvents({
    required this.onOpen,
    required this.onMessage,
    required this.onClose,
    required this.onError,
  });

  final void Function() onOpen;

  /// One text frame.
  final void Function(String text) onMessage;
  final void Function(int? code, String? reason) onClose;
  final void Function(String message) onError;
}

abstract interface class Socket {
  /// Throws unless the socket is open.
  void send(String text);

  /// Closes with [code]: 1000, 1001, 1008 or 1011.
  void close(int code, String reason);

  /// Has the socket ping every [interval] (`docs/PROTOCOL.md` section 3) and close itself when a
  /// pong goes missing. That close is not terminal: the core resumes from it. Called once, after
  /// the ack.
  void keepalive(Duration interval);
}

/// Opens a WebSocket to the daemon at [url]. [pin] is the link's `sha256/...` SPKI pin, when the
/// link carried one.
abstract interface class Transport {
  Socket open(Uri url, String? pin, SocketEvents events);
}

/// Keeps the one value a resume needs: the lease JSON.
abstract interface class SessionStore {
  String? read();
  void write(String value);
  void clear();
}

/// Opaque handle returned by [Clock.setTimeout].
typedef TimerHandle = Object;

abstract interface class Clock {
  /// Unix time in milliseconds.
  int now();
  TimerHandle setTimeout(void Function() run, int ms);
  void clearTimeout(TimerHandle handle);
}

/// Sent on every `session_claim`.
class DeviceFields {
  const DeviceFields({
    required this.manufacturer,
    required this.model,
    required this.os,
  });

  final String manufacturer;
  final String model;
  final String os;
}
