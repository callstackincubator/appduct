import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/core.dart';
import 'ports.dart';

/// Where the session is: `idle`, `connecting`, `active`, `reconnecting` or `closed`.
typedef AppductState = ClientState;

/// What a tool handler can see and do while its call is in flight.
abstract interface class ToolCallContext {
  bool get isCancelled;
  Future<void> get cancelled;
  void reportProgress(num progress, [String? message]);
}

typedef AppductToolHandler =
    FutureOr<Object?> Function(
      Map<String, Object?> args,
      ToolCallContext context,
    );

abstract final class Appduct {
  static Appduct ensureInitialized() => throw UnimplementedError();
  static Appduct get instance => throw UnimplementedError();

  void Function() registerTool(
    String name, {
    required String description,
    Map<String, Object?>? inputSchema,
    Duration? timeout,
    String? group,
    required AppductToolHandler handler,
  });

  void Function() registerEvent(
    String name, {
    required String description,
    Map<String, Object?>? payloadSchema,
  });

  Future<void> postEvent(String name, [Object? payload]);
  Future<void> connect(String link);
  Future<void> disconnect();
  ValueListenable<AppductState> get state;
}

/// Builds an instance over [ports]. Tests use this; apps call [Appduct.ensureInitialized].
@visibleForTesting
Appduct createAppduct(BindingPorts ports) => throw UnimplementedError();
