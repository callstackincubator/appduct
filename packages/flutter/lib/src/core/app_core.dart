import 'descriptors.dart';
import 'json.dart';

/// Where the session is. The names are what the other cores report.
enum ClientState { idle, connecting, active, reconnecting, closed }

/// What `connect` needs: a decoded bootstrap payload plus the link's pin.
class ConnectInput {
  const ConnectInput({
    required this.ip,
    required this.port,
    required this.sessionId,
    required this.token,
    required this.expiresAt,
    this.pin,
  });

  final String ip;
  final int port;
  final String sessionId;

  /// Base64url claim token.
  final String token;

  /// Unix seconds.
  final int expiresAt;

  /// The link's `sha256/...` SPKI pin, when it carried one.
  final String? pin;
}

/// A call the daemon made; the app answers with `respondToToolCall`.
class ToolCallEvent {
  const ToolCallEvent({
    required this.id,
    required this.name,
    required this.args,
  });

  final String id;
  final String name;
  final JsonObject args;
}

/// A call the app should stop working on. The core has already answered the daemon, or no socket
/// is left to answer on.
class ToolCancelEvent {
  const ToolCancelEvent({required this.id, required this.reason});

  final String id;

  /// `client_cancelled`, `timeout` or `session_suspended`.
  final String reason;
}

class StateChangeEvent {
  const StateChangeEvent(this.state, [this.reason]);

  final ClientState state;
  final String? reason;
}

enum SessionChangeType { claimed, resumed, lost }

class SessionChangeEvent {
  const SessionChangeEvent({
    required this.type,
    this.sessionId,
    this.alias,
    this.reason,
  });

  final SessionChangeType type;
  final String? sessionId;
  final String? alias;

  /// Set only when [type] is [SessionChangeType.lost].
  final String? reason;
}

/// Something went wrong that the app may want to log.
class ErrorEvent {
  const ErrorEvent({
    required this.phase,
    required this.message,
    this.closeReason,
  });

  /// `connect`, `bootstrap`, `socket` or `tool`.
  final String phase;
  final String message;
  final String? closeReason;
}

/// How an app answers a call with an error. [type] is one of the app-side `tool_*` error types;
/// anything else is sent as `tool_execution_error`.
class ToolFailure implements Exception {
  const ToolFailure(this.type, this.message, {this.details});

  final String type;
  final String message;
  final Object? details;

  @override
  String toString() => 'ToolFailure($type): $message';
}

/// A connect that cannot proceed: invalid or expired input, a session already in progress, or a
/// handshake the daemon refused.
class AppductException implements Exception {
  const AppductException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// `postEvent` with no active session.
class NotActiveException implements Exception {
  const NotActiveException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// The session core: the Dart counterpart of the TypeScript `AppductCore`, with Dart values where
/// that one passes JSON strings.
abstract interface class AppductCore {
  /// Throws [ArgumentError] unless [descriptor] is valid (`docs/PROTOCOL.md` section 5).
  void registerTool(JsonObject descriptor);
  void unregisterTool(String name);

  /// Throws [ArgumentError] unless [descriptor] is valid (`docs/PROTOCOL.md` section 5a).
  void registerEvent(JsonObject descriptor);
  void unregisterEvent(String name);

  /// Whether [url] carries an `appduct` bootstrap payload. The connect it starts runs on its own;
  /// a link that cannot connect is reported on [errors].
  bool handleUrl(String url);

  /// Claims a session and completes once the daemon acks it.
  Future<void> connect(ConnectInput input, {bool supersede = false});

  /// Resumes the session in the store. False when there is none, or it is too old.
  Future<bool> restoreSession();

  /// Closes the session and forgets it.
  Future<void> disconnect();

  /// Throws [NotActiveException] unless a session is active.
  Future<void> postEvent(String name, [Object? payload]);

  /// Answers call [id] with [result], or with [error] when given. A call that already finished is
  /// ignored.
  void respondToToolCall(String id, {Object? result, ToolFailure? error});

  void reportToolProgress(String id, {num? progress, String? message});

  /// The app left the foreground: the session is suspended and stays so until [foreground].
  void background();

  /// The app came back: a suspended session resumes at once.
  void foreground();

  ClientState get state;
  String? get sessionId;
  List<ToolDescriptor> get registeredTools;

  Stream<ToolCallEvent> get toolCalls;
  Stream<ToolCancelEvent> get toolCancels;
  Stream<StateChangeEvent> get stateChanges;
  Stream<SessionChangeEvent> get sessionChanges;
  Stream<ErrorEvent> get errors;
}
