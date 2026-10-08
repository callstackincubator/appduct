import 'dart:async';

import 'app_core.dart';
import 'json.dart';

/// Runs a tool for one call.
typedef ToolHandler =
    FutureOr<Object?> Function(JsonObject args, ToolContext context);

/// What a [ToolHandler] can see and do while its call is in flight.
class ToolContext {
  ToolContext._(this._report);

  final void Function(num? progress, String? message) _report;
  final Completer<String> _cancelled = Completer();

  /// Completes with the reason when the call is cancelled: `client_cancelled`, `timeout` or
  /// `session_suspended`. Never completes for a call that finishes.
  Future<String> get cancelled => _cancelled.future;

  void reportProgress({num? progress, String? message}) =>
      _report(progress, message);
}

/// Runs registered handlers for the calls a core receives and answers them.
class ToolHost {
  ToolHost(this._core) {
    _subscriptions = [
      _core.toolCalls.listen(_run),
      _core.toolCancels.listen((event) {
        final context = _inFlight.remove(event.id);
        if (context != null && !context._cancelled.isCompleted) {
          context._cancelled.complete(event.reason);
        }
      }),
    ];
  }

  final AppductCore _core;
  final Map<String, ToolHandler> _handlers = {};
  final Map<String, ToolContext> _inFlight = {};
  late final List<StreamSubscription<Object?>> _subscriptions;

  /// Registers [descriptor] with the core and serves its calls with [handler].
  void register(JsonObject descriptor, ToolHandler handler) {
    _core.registerTool(descriptor);
    _handlers[descriptor['name']! as String] = handler;
  }

  void unregister(String name) {
    _handlers.remove(name);
    _core.unregisterTool(name);
  }

  void dispose() {
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
  }

  void _run(ToolCallEvent call) {
    final handler = _handlers[call.name];
    if (handler == null) return;
    final context = ToolContext._(
      (progress, message) => _core.reportToolProgress(
        call.id,
        progress: progress,
        message: message,
      ),
    );
    _inFlight[call.id] = context;

    void fail(Object error) {
      _inFlight.remove(call.id);
      _core.respondToToolCall(
        call.id,
        error: error is ToolFailure
            ? error
            : ToolFailure('tool_execution_error', error.toString()),
      );
    }

    // An error from a future the handler never awaited has no caller to reach; the zone catches it.
    runZonedGuarded(() async {
      try {
        final result = await handler(call.args, context);
        _inFlight.remove(call.id);
        _core.respondToToolCall(call.id, result: result);
      } on Object catch (error) {
        fail(error);
      }
    }, (error, stack) => fail(error));
  }
}
