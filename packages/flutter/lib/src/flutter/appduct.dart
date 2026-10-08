import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../core/core.dart';
import 'composition.dart';
import 'enabled.dart';
import 'ports.dart';
import 'shim.dart';

/// Where the session is: `idle`, `connecting`, `active`, `reconnecting` or `closed`.
typedef AppductState = ClientState;

/// What a tool handler can see and do while its call is in flight.
abstract interface class ToolCallContext {
  bool get isCancelled;

  /// Completes when the call is cancelled, times out or is suspended by the app going to the
  /// background. Never completes for a call that finishes.
  Future<void> get cancelled;

  void reportProgress(num progress, [String? message]);
}

typedef AppductToolHandler =
    FutureOr<Object?> Function(
      Map<String, Object?> args,
      ToolCallContext context,
    );

/// The entry point of the binding. Call [ensureInitialized] before `runApp`.
abstract final class Appduct {
  static Appduct? _instance;

  /// Starts Appduct and returns it. Idempotent. Returns a no-op instance when Appduct is compiled
  /// out or when another isolate or engine already owns it.
  static Appduct ensureInitialized() {
    if (!appductEnabled) return _noop;
    final existing = _instance;
    if (existing != null) return existing;
    developer.log('started', name: appductDartCoreMarker);
    return installAppduct(productionPorts());
  }

  static Appduct get instance {
    if (!appductEnabled) return _noop;
    return _instance ??
        (throw StateError(
          'Call Appduct.ensureInitialized() before runApp, before using Appduct.instance.',
        ));
  }

  /// Registers a tool the daemon can call. The returned function unregisters it.
  ///
  /// [outputSchema] describes the result object. The hints tell the agent what calling the tool
  /// does; leave one out to say nothing about it.
  void Function() registerTool(
    String name, {
    required String description,
    Map<String, Object?>? inputSchema,
    Map<String, Object?>? outputSchema,
    bool? readOnlyHint,
    bool? destructiveHint,
    bool? idempotentHint,
    Duration? timeout,
    String? group,
    required AppductToolHandler handler,
  });

  void Function() registerEvent(
    String name, {
    required String description,
    Map<String, Object?>? payloadSchema,
  });

  /// Sends an event on the active session. Dropped when there is none.
  Future<void> postEvent(String name, [Object? payload]);

  /// Connects with an Appduct link, completing once the daemon accepts it.
  Future<void> connect(String link);

  Future<void> disconnect();

  ValueListenable<AppductState> get state;
}

final Appduct _noop = _Noop();

/// Builds the instance over [ports] and makes it [Appduct.instance], replacing and stopping the
/// previous one. Apps call [Appduct.ensureInitialized]; tests call this with fakes.
@visibleForTesting
Appduct installAppduct(BindingPorts ports) {
  final previous = Appduct._instance;
  if (previous is _Live) previous._stop();

  final Appduct next;
  if (ports.isRootIsolate()) {
    next = _Live(ports);
  } else {
    // A background isolate reaches native on its engine's messenger, so native could not tell it
    // from a restarted root isolate and would hand it the pending link.
    ports.warn(
      'Appduct is off in this isolate: it only runs in the root isolate of an app.',
    );
    next = _Noop();
  }
  return Appduct._instance = next;
}

final class _Noop implements Appduct {
  @override
  final ValueNotifier<AppductState> state = ValueNotifier(ClientState.idle);

  @override
  void Function() registerTool(
    String name, {
    required String description,
    Map<String, Object?>? inputSchema,
    Map<String, Object?>? outputSchema,
    bool? readOnlyHint,
    bool? destructiveHint,
    bool? idempotentHint,
    Duration? timeout,
    String? group,
    required AppductToolHandler handler,
  }) => _nothing;

  @override
  void Function() registerEvent(
    String name, {
    required String description,
    Map<String, Object?>? payloadSchema,
  }) => _nothing;

  @override
  Future<void> postEvent(String name, [Object? payload]) async {}

  @override
  Future<void> connect(String link) async {}

  @override
  Future<void> disconnect() async {}

  static void _nothing() {}
}

/// Mutable device names: the core reads them when it claims, after `activate` has answered.
class _Device implements DeviceFields {
  DeviceFields _fields = const DeviceFields(
    manufacturer: 'Unknown',
    model: 'Unknown',
    os: 'Unknown',
  );

  @override
  String get manufacturer => _fields.manufacturer;
  @override
  String get model => _fields.model;
  @override
  String get os => _fields.os;
}

class _Context implements ToolCallContext {
  _Context(this._inner) {
    unawaited(_inner.cancelled.then((_) => _isCancelled = true));
  }

  final ToolContext _inner;
  bool _isCancelled = false;

  @override
  bool get isCancelled => _isCancelled;

  @override
  Future<void> get cancelled => _inner.cancelled.then((_) {});

  @override
  void reportProgress(num progress, [String? message]) =>
      _inner.reportProgress(progress: progress, message: message);
}

final class _Live with WidgetsBindingObserver implements Appduct {
  _Live(this._ports) {
    final device = _Device();
    _device = device;
    _shim = Shim(fallbackDevice: _fallbackDevice());
    _shimStore = _ports.leaseStore == null ? ShimSessionStore(_shim) : null;
    _store = _ports.leaseStore ?? _shimStore!;
    _core = createDartCore(
      DartCorePorts(
        transport: _ports.transport,
        sessionStore: _store,
        clock: _ports.clock,
        random: _ports.random,
        device: device,
        allowPrivateLanOnly: _ports.allowPrivateLanOnly,
      ),
    );
    _tools = ToolHost(_core);
    _stateChanges = _core.stateChanges.listen((e) => _state.value = e.state);

    // Before runApp, so the guard sees a link before the app's router does.
    WidgetsFlutterBinding.ensureInitialized().addObserver(this);
    _shim.listenForLinks(_feed);
    _ready = _activate();
  }

  final BindingPorts _ports;
  late final _Device _device;
  late final Shim _shim;
  late final ShimSessionStore? _shimStore;
  late final SessionStore _store;
  late final AppductCore _core;
  late final ToolHost _tools;
  late final StreamSubscription<StateChangeEvent> _stateChanges;
  late final Future<void> _ready;
  final ValueNotifier<AppductState> _state = ValueNotifier(ClientState.idle);
  bool _disabled = false;

  @override
  ValueListenable<AppductState> get state => _state;

  DeviceFields _fallbackDevice() => DeviceFields(
    manufacturer: 'Unknown',
    model: 'Unknown',
    os: defaultTargetPlatform.name,
  );

  Future<void> _activate() async {
    final activation = await _shim.activate();
    if (!activation.owner) {
      _disabled = true;
      _ports.warn(
        'Appduct is off in this engine: another engine or isolate already owns it.',
      );
      return;
    }
    _device._fields = activation.device;
    _shimStore?.load(activation.lease);

    // After a hot restart the process still holds the links the app started from: the route name
    // and APPDUCT_LINK last as long as the process, whichever session the lease belongs to now.
    // Their tokens are spent, so feeding them again would replace the live session; the lease
    // resumes it instead. Only the shim's pending links are new, and they are filtered by session.
    final lease = _store.read();
    final leased = _leasedSessionId(lease);
    final links = <String>{
      ...activation.links,
      if (lease == null) ...[?_coldStartLink(), ?_desktopLink()],
    }..removeWhere((link) => leased != null && _sessionIdOf(link) == leased);
    if (links.isEmpty) {
      await _core.restoreSession();
    } else {
      links.forEach(_feed);
    }
  }

  String? _coldStartLink() {
    final route = WidgetsBinding.instance.platformDispatcher.defaultRouteName;
    return _isAppductLink(route) ? route : null;
  }

  String? _desktopLink() {
    const desktop = {
      TargetPlatform.windows,
      TargetPlatform.linux,
      TargetPlatform.macOS,
    };
    if (!kDebugMode || !desktop.contains(defaultTargetPlatform)) return null;
    return _ports.environment['APPDUCT_LINK'];
  }

  static String? _leasedSessionId(String? lease) {
    if (lease == null) return null;
    try {
      final decoded = jsonDecode(lease);
      final id = decoded is Map ? decoded['sessionId'] : null;
      return id is String ? id : null;
    } on FormatException {
      return null;
    }
  }

  static String? _sessionIdOf(String link) {
    final parsed = parseBootstrapLink(link);
    return parsed == null ? null : decodeBootstrap(parsed.payload)?.sessionId;
  }

  static bool _isAppductLink(String link) =>
      Uri.tryParse(link)?.queryParameters.containsKey('appduct') ?? false;

  void _feed(String link) {
    if (!_disabled) _core.handleUrl(link);
  }

  /// Stops listening; a newer instance replaces this one.
  void _stop() {
    WidgetsBinding.instance.removeObserver(this);
    _shim.stopListening();
    unawaited(_stateChanges.cancel());
    _tools.dispose();
    _disabled = true;
  }

  // --- WidgetsBindingObserver ---

  /// Takes an Appduct link before the app's router can read it as a route.
  @override
  Future<bool> didPushRouteInformation(
    RouteInformation routeInformation,
  ) async {
    final link = routeInformation.uri.toString();
    if (!_isAppductLink(link)) return false;
    _feed(link);
    return true;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycle) {
    if (_disabled) return;
    switch (lifecycle) {
      case AppLifecycleState.paused:
        _core.background();
      case AppLifecycleState.resumed:
        _core.foreground();
      case AppLifecycleState.detached ||
          AppLifecycleState.inactive ||
          AppLifecycleState.hidden:
        break;
    }
  }

  // --- Appduct ---

  @override
  void Function() registerTool(
    String name, {
    required String description,
    Map<String, Object?>? inputSchema,
    Map<String, Object?>? outputSchema,
    bool? readOnlyHint,
    bool? destructiveHint,
    bool? idempotentHint,
    Duration? timeout,
    String? group,
    required AppductToolHandler handler,
  }) {
    if (_disabled) return _Noop._nothing;
    _tools.register({
      'name': name,
      'description': description,
      'input_schema': ?inputSchema,
      'output_schema': ?outputSchema,
      if (readOnlyHint != null ||
          destructiveHint != null ||
          idempotentHint != null)
        'annotations': {
          'readOnlyHint': ?readOnlyHint,
          'destructiveHint': ?destructiveHint,
          'idempotentHint': ?idempotentHint,
        },
      if (timeout != null) 'timeout_ms': timeout.inMilliseconds,
      'group': ?group,
    }, (args, context) => handler(args, _Context(context)));
    return () => _tools.unregister(name);
  }

  @override
  void Function() registerEvent(
    String name, {
    required String description,
    Map<String, Object?>? payloadSchema,
  }) {
    if (_disabled) return _Noop._nothing;
    _core.registerEvent({
      'name': name,
      'description': description,
      'payload_schema': ?payloadSchema,
    });
    return () => _core.unregisterEvent(name);
  }

  @override
  Future<void> postEvent(String name, [Object? payload]) async {
    await _ready;
    if (_disabled) return;
    try {
      await _core.postEvent(name, payload);
    } on NotActiveException {
      // Events are best effort: with no session there is nobody to tell.
    }
  }

  @override
  Future<void> connect(String link) async {
    await _ready;
    if (_disabled) return;
    final parsed = parseBootstrapLink(link);
    final bootstrap = parsed == null ? null : decodeBootstrap(parsed.payload);
    if (parsed == null || bootstrap == null) {
      throw const AppductException('Not an Appduct link.');
    }
    await _core.connect(
      ConnectInput(
        ip: bootstrap.address,
        port: bootstrap.port,
        sessionId: bootstrap.sessionId,
        token: bootstrap.token,
        expiresAt: bootstrap.expiresAt,
        pin: parsed.pin,
      ),
      supersede:
          _state.value == ClientState.connecting ||
          _state.value == ClientState.active,
    );
  }

  @override
  Future<void> disconnect() async {
    await _ready;
    if (_disabled) return;
    await _core.disconnect();
  }
}
