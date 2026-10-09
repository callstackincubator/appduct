import 'dart:convert';

import 'app_core.dart';
import 'connection.dart';
import 'descriptors.dart';
import 'messages.dart';
import 'ports.dart';
import 'registry.dart';

const _defaultToolTimeoutMs = 10000;

class _InFlight {
  _InFlight(this.name, this.timer);

  final String name;
  final TimerHandle timer;
}

/// Per-call deadline, cancel and reply frames (`docs/PROTOCOL.md` section 4). The app runs the
/// handler; this answers the daemon, so a handler that never answers still gets a `tool_timeout`.
/// Port of the web core's `createToolInvoker`.
class ToolInvoker {
  ToolInvoker({
    required Clock clock,
    required Registry<ToolDescriptor> registry,
    required String? Function() sessionId,
    required void Function(WireMessage) send,
    required void Function(ToolCallEvent) emitToolCall,
    required void Function(ToolCancelEvent) emitToolCancel,
    required void Function(String) onSendError,
  }) : _clock = clock,
       _registry = registry,
       _sessionId = sessionId,
       _send = send,
       _emitToolCall = emitToolCall,
       _emitToolCancel = emitToolCancel,
       _onSendError = onSendError;

  final Clock _clock;
  final Registry<ToolDescriptor> _registry;
  final String? Function() _sessionId;
  final void Function(WireMessage) _send;
  final void Function(ToolCallEvent) _emitToolCall;
  final void Function(ToolCancelEvent) _emitToolCancel;
  final void Function(String) _onSendError;
  final Map<String, _InFlight> _inFlight = {};

  void _sendReply(WireMessage message) {
    try {
      _send(message);
    } on FrameTooLargeException catch (error) {
      _onSendError(error.message);
    } on Object {
      _onSendError('Failed to send a tool response frame.');
    }
  }

  /// One over the frame limit becomes a `tool_serialization_error` naming its size.
  void _sendError(
    String sessionId,
    String id,
    String type,
    String message, {
    Object? details,
  }) {
    try {
      _send(
        ToolError(
          sessionId: sessionId,
          id: id,
          errorType: type,
          message: message,
          details: details,
        ),
      );
    } on FrameTooLargeException catch (error) {
      _sendError(sessionId, id, 'tool_serialization_error', error.message);
    } on Object {
      _onSendError('Failed to send a tool response frame.');
    }
  }

  /// Takes [id] out of flight, or returns null when it is not (or no longer) in flight.
  _InFlight? _finish(String id) {
    final entry = _inFlight.remove(id);
    if (entry != null) _clock.clearTimeout(entry.timer);
    return entry;
  }

  void handleToolCall(ToolCall call) {
    final sessionId = _sessionId();
    if (sessionId == null) return;
    final tool = _registry.get(call.name);
    if (tool == null) {
      _sendError(
        sessionId,
        call.id,
        'tool_not_found',
        'Tool "${call.name}" is not registered in the app.',
      );
      return;
    }

    final timeoutMs = tool.timeoutMs ?? _defaultToolTimeoutMs;
    final timer = _clock.setTimeout(() {
      if (_finish(call.id) == null) return;
      _sendError(
        sessionId,
        call.id,
        'tool_timeout',
        'Tool "${call.name}" did not respond within ${timeoutMs}ms.',
      );
      _emitToolCancel(ToolCancelEvent(id: call.id, reason: 'timeout'));
    }, timeoutMs);
    _inFlight[call.id] = _InFlight(call.name, timer);
    _emitToolCall(ToolCallEvent(id: call.id, name: call.name, args: call.args));
  }

  /// A `tool_cancel` frame. An unknown or finished id is a no-op.
  void handleToolCancel(String id) {
    final entry = _finish(id);
    final sessionId = _sessionId();
    if (entry == null || sessionId == null) return;
    _sendError(
      sessionId,
      id,
      'tool_cancelled',
      'Tool "${entry.name}" was cancelled.',
    );
    _emitToolCancel(ToolCancelEvent(id: id, reason: 'client_cancelled'));
  }

  /// The app's answer. An unknown or finished id is a no-op.
  void respond(String id, {Object? result, ToolFailure? error}) {
    final sessionId = _sessionId();
    if (_finish(id) == null || sessionId == null) return;

    if (error != null) {
      _respondWithFailure(sessionId, id, error);
      return;
    }

    try {
      _send(ToolResult(sessionId: sessionId, id: id, result: result));
    } on FrameTooLargeException catch (error) {
      _sendError(sessionId, id, 'tool_serialization_error', error.message);
    } on JsonUnsupportedObjectError {
      _sendError(
        sessionId,
        id,
        'tool_serialization_error',
        'Appduct tool result is not JSON-serializable.',
      );
    } on Object {
      _onSendError('Failed to send a tool response frame.');
    }
  }

  void _respondWithFailure(String sessionId, String id, ToolFailure failure) {
    final message = failure.message.isEmpty
        ? 'Appduct tool execution failed.'
        : failure.message;
    final type = toolErrorTypes.contains(failure.type)
        ? failure.type
        : 'tool_execution_error';
    try {
      _send(
        ToolError(
          sessionId: sessionId,
          id: id,
          errorType: type,
          message: message,
          details: failure.details,
        ),
      );
    } on Object {
      // Details the wire cannot carry are dropped; the failure itself still gets through.
      _sendError(sessionId, id, type, message);
    }
  }

  void progress(String id, {num? progress, String? message}) {
    final sessionId = _sessionId();
    if (!_inFlight.containsKey(id) || sessionId == null) return;
    _sendReply(
      ToolCallProgress(
        sessionId: sessionId,
        id: id,
        progress: progress,
        message: message,
      ),
    );
  }

  /// Drops every call in flight without sending anything: no socket is left to send on.
  void abortAll() {
    for (final id in _inFlight.keys.toList()) {
      _finish(id);
      _emitToolCancel(ToolCancelEvent(id: id, reason: 'session_suspended'));
    }
  }
}
