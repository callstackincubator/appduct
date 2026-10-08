import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'app_core.dart';
import 'backoff.dart';
import 'bootstrap.dart';
import 'close_codes.dart';
import 'connection.dart';
import 'descriptors.dart';
import 'json.dart';
import 'lease.dart';
import 'messages.dart';
import 'ports.dart';
import 'registry.dart';
import 'tool_invoker.dart';

/// Everything the core reaches outside the process through.
class DartCorePorts {
  const DartCorePorts({
    required this.transport,
    required this.sessionStore,
    required this.clock,
    required this.random,
    required this.device,
  });

  final Transport transport;
  final SessionStore sessionStore;
  final Clock clock;

  /// Reconnect jitter.
  final Random random;
  final DeviceFields device;
}

/// The session the core holds: the token to resume it with and the endpoint to resume against.
/// [disconnectedAtMs] is stamped the first time the socket is lost.
class _HeldSession {
  _HeldSession({
    required this.sessionId,
    required this.resumeToken,
    required this.alias,
    required this.graceS,
    required this.ip,
    required this.port,
    required this.pin,
    required this.acceptsEventRegistry,
    this.disconnectedAtMs,
  });

  final String sessionId;
  final String resumeToken;
  final String alias;
  final num graceS;
  final String ip;
  final int port;
  final String? pin;
  final bool acceptsEventRegistry;
  int? disconnectedAtMs;
}

/// A handshake the daemon rejected by closing the socket before (or instead of) an ack.
class _HandshakeClosed extends AppductException {
  const _HandshakeClosed(super.message, this.code, this.reason);

  final int? code;
  final String? reason;
}

class _Pending {
  _Pending(this.onAck);

  final void Function(SessionAck ack) onAck;
  final Completer<void> done = Completer();
}

/// The session core: a Dart port of the web core (`packages/web/src/core`), itself a port of the
/// Swift and Kotlin cores. It owns the claim and resume handshake, reconnect with full jitter, the
/// grace timer, the keepalive pings, backgrounding, the tool and event registries and their
/// frames, and per-call deadline and cancel.
///
/// Everything runs on one isolate and every callback runs to completion before the next starts, so
/// there is no locking.
AppductCore createDartCore(DartCorePorts ports) => _DartCore(ports);

class _DartCore implements AppductCore {
  _DartCore(this._ports) {
    _connection = Connection(
      transport: _ports.transport,
      sessionStore: _ports.sessionStore,
      clock: _ports.clock,
      device: _ports.device,
      handlers: ConnectionHandlers(
        onAck: _onAck,
        onMessage: _onMessage,
        onClose: _onClose,
      ),
    );
    _invoker = ToolInvoker(
      clock: _ports.clock,
      registry: _tools,
      sessionId: () => _held?.sessionId,
      send: (frame) => _connection.send(frame),
      emitToolCall: _toolCalls.add,
      emitToolCancel: _toolCancels.add,
      onSendError: (message) => _emitError('tool', message),
    );
  }

  final DartCorePorts _ports;
  late final Connection _connection;
  late final ToolInvoker _invoker;
  final _tools = createToolRegistry();
  final _events = createEventRegistry();

  // Synchronous, so a listener hears an event before the call that caused it returns, in the order
  // the other cores report them.
  final _toolCalls = StreamController<ToolCallEvent>.broadcast(sync: true);
  final _toolCancels = StreamController<ToolCancelEvent>.broadcast(sync: true);
  final _stateChanges = StreamController<StateChangeEvent>.broadcast(
    sync: true,
  );
  final _sessionChanges = StreamController<SessionChangeEvent>.broadcast(
    sync: true,
  );
  final _errors = StreamController<ErrorEvent>.broadcast(sync: true);

  ClientState _state = ClientState.idle;
  _HeldSession? _held;

  /// The session an in-flight `connect()` is claiming, before an ack sets [_held].
  String? _connectingSessionId;
  int _epoch = 0;
  _Pending? _pending;
  int _reconnectAttempt = 0;
  TimerHandle? _reconnectTimer;
  TimerHandle? _graceTimer;
  bool _resumeInFlight = false;
  bool _backgrounded = false;

  /// True while an ack is being announced: what is registered then goes out in the snapshot that
  /// follows, so it sends no delta of its own.
  bool _snapshotPending = false;

  Clock get _clock => _ports.clock;

  void _setState(ClientState next, [String? reason]) {
    if (_state == next && reason == null) return;
    _state = next;
    _stateChanges.add(StateChangeEvent(next, reason));
  }

  void _emitError(String phase, String message, [String? closeReason]) =>
      _errors.add(
        ErrorEvent(phase: phase, message: message, closeReason: closeReason),
      );

  void _clearReconnectTimer() {
    final timer = _reconnectTimer;
    if (timer != null) _clock.clearTimeout(timer);
    _reconnectTimer = null;
  }

  void _clearGraceTimer() {
    final timer = _graceTimer;
    if (timer != null) _clock.clearTimeout(timer);
    _graceTimer = null;
  }

  /// Settles the handshake in flight, if any. Returns whether there was one.
  bool _settlePending(Exception error) {
    final attempt = _pending;
    if (attempt == null) return false;
    _pending = null;
    attempt.done.completeError(error);
    return true;
  }

  /// Opens a socket and completes once [onAck] has run for the ack, or fails if the handshake does.
  Future<void> _handshake(
    ConnectionOptions options,
    void Function(SessionAck ack) onAck,
  ) {
    final attempt = _Pending(onAck);
    _pending = attempt;
    try {
      _connection.open(options);
    } on Object catch (error) {
      _settlePending(AppductException('$error'));
    }
    return attempt.done.future;
  }

  void _sendFrame(WireMessage frame, String phase, String failure) {
    try {
      _connection.send(frame);
    } on FrameTooLargeException catch (error) {
      _emitError(phase, error.message);
    } on Object {
      _emitError(phase, failure);
    }
  }

  // --- the handshake and the frames that follow ---

  void _onAck(SessionAck ack) {
    final attempt = _pending;
    _pending = null;
    attempt?.onAck(ack);
    attempt?.done.complete();
  }

  void _onMessage(WireMessage message) {
    switch (message) {
      case ToolCall():
        _invoker.handleToolCall(message);
      case ToolCancel():
        _invoker.handleToolCancel(message.id);
      default:
        break;
    }
  }

  void _onClose(int? code, String? reason, String? error) {
    final settled = _settlePending(
      _HandshakeClosed(
        reason ?? error ?? 'Appduct connection closed.',
        code,
        reason,
      ),
    );
    if (settled) return;
    _handleSocketLost(code, reason, error);
    // The socket is gone, so no `tool_cancel` could arrive for what is in flight: abort it here,
    // after the state change, which is the order the Swift and Kotlin cores report them in.
    _invoker.abortAll();
  }

  void _sendSnapshots(bool acceptsEvents) {
    final session = _held;
    if (_state != ClientState.active || session == null) return;
    _sendFrame(
      ToolRegistrySnapshot(sessionId: session.sessionId, tools: _tools.list()),
      'tool',
      'Failed to send the tool registry snapshot.',
    );
    if (!acceptsEvents) return;
    _sendFrame(
      EventRegistrySnapshot(
        sessionId: session.sessionId,
        events: _events.list(),
      ),
      'tool',
      'Failed to sync the event registry.',
    );
  }

  void _onAckReceived(
    SessionAck ack,
    SessionChangeType kind,
    ConnectionOptions endpoint,
  ) {
    _clearReconnectTimer();
    _clearGraceTimer();
    _reconnectAttempt = 0;
    _resumeInFlight = false;

    _held = _HeldSession(
      sessionId: ack.sessionId,
      resumeToken: ack.resumeToken,
      alias: ack.alias,
      graceS: ack.graceS,
      ip: endpoint.ip,
      port: endpoint.port,
      pin: endpoint.pin,
      acceptsEventRegistry: ack.eventRegistry,
    );
    _connectingSessionId = null;

    _snapshotPending = true;
    try {
      _setState(ClientState.active);
      _sessionChanges.add(
        SessionChangeEvent(
          type: kind,
          sessionId: ack.sessionId,
          alias: ack.alias,
        ),
      );
    } finally {
      _snapshotPending = false;
    }
    _sendSnapshots(ack.eventRegistry);
  }

  // --- reconnect, grace, loss ---

  void _finalizeSessionLost(String reason) {
    final hadSession = _held != null;

    _epoch += 1;
    _clearReconnectTimer();
    _clearGraceTimer();
    _held = null;
    _resumeInFlight = false;
    _connection.close();
    _settlePending(AppductException('Appduct session was lost: $reason.'));

    _setState(ClientState.closed, reason);
    if (hadSession) {
      _sessionChanges.add(
        SessionChangeEvent(type: SessionChangeType.lost, reason: reason),
      );
    }
  }

  bool _graceElapsed(_HeldSession session) {
    final nowMs = _clock.now();
    session.disconnectedAtMs ??= nowMs;
    return nowMs - session.disconnectedAtMs! >=
        (session.graceS * 1000).truncate();
  }

  Future<void> _attemptResume(int epoch) async {
    final session = _held;
    if (_resumeInFlight || epoch != _epoch || session == null) return;
    if (_graceElapsed(session)) {
      _finalizeSessionLost('grace_expired');
      return;
    }

    _resumeInFlight = true;
    final options = ConnectionOptions(
      ip: session.ip,
      port: session.port,
      sessionId: session.sessionId,
      resumeToken: session.resumeToken,
      pin: session.pin,
    );
    try {
      await _handshake(
        options,
        (ack) => _onAckReceived(ack, SessionChangeType.resumed, options),
      );
    } on Object catch (error) {
      _resumeInFlight = false;
      if (epoch != _epoch) return;

      final cause = '$error'.replaceFirst(RegExp(r'\.+$'), '');
      _emitError('socket', 'Appduct resume attempt failed: $cause.');

      if (error is _HandshakeClosed && isTerminalClose(error.code)) {
        // The daemon rejected the resume itself. Retrying the same frame until the grace window
        // ends would leave the app "reconnecting" for minutes before it reports the loss.
        _finalizeSessionLost(error.reason ?? 'rejected_by_daemon');
        return;
      }
      _scheduleReconnect(epoch);
    }
  }

  void _scheduleReconnect(int epoch) {
    if (epoch != _epoch || _held == null) return;
    _setState(ClientState.reconnecting);
    // No timer in the background: foregrounding resumes at once.
    if (_backgrounded) return;
    final delayMs = fullJitterBackoffMs(_reconnectAttempt, _ports.random);
    _reconnectAttempt += 1;
    _reconnectTimer = _clock.setTimeout(() {
      _reconnectTimer = null;
      unawaited(_attemptResume(epoch));
    }, delayMs);
  }

  void _scheduleGraceExpiry(int epoch) {
    final session = _held;
    if (_graceTimer != null || session == null) return;
    final nowMs = _clock.now();
    session.disconnectedAtMs ??= nowMs;
    final remainingMs =
        (session.graceS * 1000).truncate() -
        (nowMs - session.disconnectedAtMs!);
    _graceTimer = _clock.setTimeout(() {
      _graceTimer = null;
      if (epoch == _epoch && _held != null) {
        _finalizeSessionLost('grace_expired');
      }
    }, max(remainingMs, 0));
  }

  void _handleSocketLost(int? code, String? reason, String? lastError) {
    final session = _held;
    if (session == null) {
      _setState(ClientState.closed, 'socket_closed');
      return;
    }
    if (code == 1000) {
      _finalizeSessionLost('revoked');
      return;
    }

    // Our own background close is deliberate, not a failure the app should hear about.
    if (!(code == 1001 && reason == 'app_backgrounded')) {
      _emitError(
        'socket',
        reason ?? lastError ?? 'Appduct connection lost.',
        reason,
      );
    }

    if (isTerminalClose(code)) {
      _finalizeSessionLost(reason ?? 'rejected_by_daemon');
      return;
    }
    if (_graceElapsed(session)) {
      _finalizeSessionLost('grace_expired');
      return;
    }
    _scheduleGraceExpiry(_epoch);
    _scheduleReconnect(_epoch);
  }

  // --- connect and restore ---

  Future<void> _connect(ConnectInput input, bool supersede) async {
    final hasCredential = input.token.isNotEmpty;
    if (input.ip.isEmpty ||
        input.sessionId.isEmpty ||
        input.port < 1 ||
        input.port > 65535 ||
        !hasCredential ||
        input.expiresAt <= _clock.now() ~/ 1000) {
      throw const AppductException(
        'Invalid or expired Appduct bootstrap payload.',
      );
    }

    final supersedingReconnect =
        _state == ClientState.reconnecting || supersede;
    if (_connection.isBusy && !supersedingReconnect) {
      throw const AppductException(
        'An Appduct session is already connecting or active.',
      );
    }

    _epoch += 1;
    final epoch = _epoch;
    _clearReconnectTimer();
    _clearGraceTimer();
    _reconnectAttempt = 0;
    _held = null;
    _connectingSessionId = input.sessionId;
    _resumeInFlight = false;
    _ports.sessionStore.clear();

    if (supersedingReconnect) {
      _invoker.abortAll();
      _settlePending(
        const AppductException(
          'Appduct recovery was superseded by a fresh connection.',
        ),
      );
      _connection.close();
    }

    final options = ConnectionOptions(
      ip: input.ip,
      port: input.port,
      sessionId: input.sessionId,
      token: input.token,
      pin: input.pin,
      deviceManufacturer: input.deviceManufacturer,
      deviceModel: input.deviceModel,
      deviceOs: input.deviceOs,
    );
    try {
      _setState(ClientState.connecting);
      await _handshake(
        options,
        (ack) => _onAckReceived(ack, SessionChangeType.claimed, options),
      );
    } on Object catch (error) {
      if (epoch == _epoch) {
        _connectingSessionId = null;
        _setState(ClientState.closed, 'connect_error');
        _emitError(
          'connect',
          error is AppductException ? error.message : 'Appduct connect failed.',
        );
      }
      rethrow;
    }
  }

  Future<void> _processLink(BootstrapLink link) async {
    final bootstrap = decodeBootstrap(link.payload);
    if (bootstrap == null) {
      _emitError('bootstrap', 'Invalid or expired Appduct bootstrap payload.');
      return;
    }

    final holdsSession =
        _state == ClientState.connecting || _state == ClientState.active;
    final heldId = _held?.sessionId ?? _connectingSessionId;
    // A re-delivered link is ignored, not re-claimed: its token is single-use.
    if (holdsSession && heldId == bootstrap.sessionId) return;

    try {
      await _connect(
        ConnectInput(
          ip: bootstrap.address,
          port: bootstrap.port,
          sessionId: bootstrap.sessionId,
          token: bootstrap.token,
          expiresAt: bootstrap.expiresAt,
          pin: link.pin,
        ),
        holdsSession,
      );
    } on Object {
      _emitError('bootstrap', 'Appduct bootstrap connect failed.');
    }
  }

  // --- AppductCore ---

  void _sendToolDelta(WireMessage frame) {
    if (_state != ClientState.active || _held == null || _snapshotPending) {
      return;
    }
    _sendFrame(frame, 'tool', 'Failed to sync the tool registry.');
  }

  void _sendEventDelta(WireMessage frame) {
    final session = _held;
    if (_state != ClientState.active ||
        session == null ||
        _snapshotPending ||
        !session.acceptsEventRegistry) {
      return;
    }
    _sendFrame(frame, 'tool', 'Failed to sync the event registry.');
  }

  @override
  void registerTool(JsonObject descriptor) {
    final tool = _tools.upsert(descriptor);
    final session = _held;
    if (session == null) return;
    _sendToolDelta(
      ToolRegistryUpsert(sessionId: session.sessionId, tool: tool),
    );
  }

  @override
  void unregisterTool(String name) {
    final session = _held;
    if (!_tools.remove(name) || session == null) return;
    _sendToolDelta(
      ToolRegistryRemove(sessionId: session.sessionId, name: name),
    );
  }

  @override
  void registerEvent(JsonObject descriptor) {
    final event = _events.upsert(descriptor);
    final session = _held;
    if (session == null) return;
    _sendEventDelta(
      EventRegistryUpsert(sessionId: session.sessionId, event: event),
    );
  }

  @override
  void unregisterEvent(String name) {
    final session = _held;
    if (!_events.remove(name) || session == null) return;
    _sendEventDelta(
      EventRegistryRemove(sessionId: session.sessionId, name: name),
    );
  }

  @override
  bool handleUrl(String url) {
    final link = parseBootstrapLink(url);
    if (link == null) return false;
    unawaited(_processLink(link));
    return true;
  }

  @override
  Future<void> connect(ConnectInput input, {bool supersede = false}) =>
      _connect(input, supersede);

  @override
  Future<bool> restoreSession() async {
    if (_held != null ||
        (_state != ClientState.idle && _state != ClientState.closed)) {
      return false;
    }

    final lease = parseResumeLease(_ports.sessionStore.read());
    if (lease == null) {
      _ports.sessionStore.clear();
      return false;
    }
    final nowMs = _clock.now();
    if (lease.isExpiredAt(nowMs)) {
      _ports.sessionStore.clear();
      return false;
    }
    if (_connection.isBusy) return false;

    _epoch += 1;
    final epoch = _epoch;
    _clearReconnectTimer();
    _clearGraceTimer();
    _reconnectAttempt = 0;
    _held = _HeldSession(
      sessionId: lease.sessionId,
      resumeToken: lease.resumeToken,
      alias: lease.alias,
      graceS: lease.graceS,
      disconnectedAtMs: lease.disconnectedAtMs ?? nowMs,
      ip: lease.ip,
      port: lease.port,
      pin: lease.linkPin,
      // Not acked yet; the ack that resumes the session says.
      acceptsEventRegistry: false,
    );
    _setState(ClientState.reconnecting);
    _scheduleGraceExpiry(epoch);
    unawaited(_attemptResume(epoch));
    return true;
  }

  @override
  Future<void> disconnect() async {
    _epoch += 1;
    _clearReconnectTimer();
    _clearGraceTimer();

    final hadSession = _held != null;
    _held = null;
    _connectingSessionId = null;
    _resumeInFlight = false;
    _settlePending(const AppductException('Appduct client was closed.'));
    _invoker.abortAll();
    _connection.close();

    _setState(ClientState.closed, 'closed_by_app');
    if (hadSession) {
      _sessionChanges.add(
        const SessionChangeEvent(
          type: SessionChangeType.lost,
          reason: 'closed_by_app',
        ),
      );
    }
  }

  @override
  Future<void> postEvent(String name, [Object? payload]) async {
    final session = _held;
    if (_state != ClientState.active || session == null) {
      throw NotActiveException(
        'Appduct postEvent("$name") dropped: no active Appduct session.',
      );
    }
    try {
      _connection.send(
        EventFrame(
          sessionId: session.sessionId,
          name: name,
          payload: payload,
          ts: _clock.now(),
        ),
      );
    } on FrameTooLargeException catch (error) {
      _emitError('socket', error.message);
    } on JsonUnsupportedObjectError {
      throw ArgumentError.value(
        payload,
        'payload',
        'Appduct event "$name" payload is not JSON-serializable.',
      );
    } on Object {
      _emitError('socket', 'Failed to send event "$name".');
    }
  }

  @override
  void respondToToolCall(String id, {Object? result, ToolFailure? error}) =>
      _invoker.respond(id, result: result, error: error);

  @override
  void reportToolProgress(String id, {num? progress, String? message}) =>
      _invoker.progress(id, progress: progress, message: message);

  @override
  void background() {
    if (_backgrounded) return;
    _backgrounded = true;
    _clearReconnectTimer();
    // Tell the daemon, so a call to this app fails at once naming the background instead of
    // timing out. The close takes the usual non-terminal path: no reconnect while backgrounded,
    // a resume on foreground.
    if (_state == ClientState.active && _held != null) _connection.suspend();
  }

  @override
  void foreground() {
    if (!_backgrounded) return;
    _backgrounded = false;
    if (_held != null &&
        _state == ClientState.reconnecting &&
        !_resumeInFlight) {
      _clearReconnectTimer();
      unawaited(_attemptResume(_epoch));
    }
  }

  @override
  ClientState get state => _state;

  @override
  String? get sessionId => _held?.sessionId ?? _connectingSessionId;

  @override
  List<ToolDescriptor> get registeredTools => _tools.list();

  @override
  Stream<ToolCallEvent> get toolCalls => _toolCalls.stream;

  @override
  Stream<ToolCancelEvent> get toolCancels => _toolCancels.stream;

  @override
  Stream<StateChangeEvent> get stateChanges => _stateChanges.stream;

  @override
  Stream<SessionChangeEvent> get sessionChanges => _sessionChanges.stream;

  @override
  Stream<ErrorEvent> get errors => _errors.stream;
}
