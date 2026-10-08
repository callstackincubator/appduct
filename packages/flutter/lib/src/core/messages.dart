import 'dart:convert';

import 'descriptors.dart';
import 'json.dart';

const protocolVersion = 2;
const _maxDeviceFieldLength = 256;

const _toolErrorTypes = {
  'tool_not_found',
  'tool_input_validation_error',
  'tool_output_validation_error',
  'tool_execution_error',
  'tool_serialization_error',
  'tool_timeout',
  'tool_cancelled',
};

/// One JSON object per WebSocket text frame (`docs/PROTOCOL.md` section 4). Every message but
/// [UnknownMessage] belongs to a session.
sealed class WireMessage {
  const WireMessage();

  JsonObject toJson();
}

/// A frame with a `type` this core does not know. The core ignores it.
class UnknownMessage extends WireMessage {
  const UnknownMessage(this.type);

  final String type;

  @override
  JsonObject toJson() => {'type': type};
}

class SessionClaim extends WireMessage {
  const SessionClaim({
    required this.sessionId,
    required this.token,
    this.deviceManufacturer,
    this.deviceModel,
    this.deviceOs,
  });

  final String sessionId;
  final String token;
  final String? deviceManufacturer;
  final String? deviceModel;
  final String? deviceOs;

  @override
  JsonObject toJson() => {
    'type': 'session_claim',
    'protocol_version': protocolVersion,
    'session_id': sessionId,
    'token': token,
    if (deviceManufacturer != null) 'device_manufacturer': deviceManufacturer,
    if (deviceModel != null) 'device_model': deviceModel,
    if (deviceOs != null) 'device_os': deviceOs,
  };
}

class SessionResume extends WireMessage {
  const SessionResume({required this.sessionId, required this.resumeToken});

  final String sessionId;
  final String resumeToken;

  @override
  JsonObject toJson() => {
    'type': 'session_resume',
    'protocol_version': protocolVersion,
    'session_id': sessionId,
    'resume_token': resumeToken,
  };
}

class SessionAck extends WireMessage {
  const SessionAck({
    required this.sessionId,
    required this.alias,
    required this.resumeToken,
    required this.keepaliveIntervalS,
    required this.graceS,
    required this.eventRegistry,
  });

  final String sessionId;
  final String alias;
  final String resumeToken;

  /// JSON may deliver either `15` or `15.0`.
  final num keepaliveIntervalS;
  final num graceS;

  /// Whether the daemon accepts `event_registry_*` frames. An older daemon omits the key.
  final bool eventRegistry;

  @override
  JsonObject toJson() => {
    'type': 'session_ack',
    'session_id': sessionId,
    'status': 'ok',
    'alias': alias,
    'resume_token': resumeToken,
    'keepalive_interval_s': keepaliveIntervalS,
    'grace_s': graceS,
    if (eventRegistry) 'event_registry': true,
  };
}

class ToolRegistrySnapshot extends WireMessage {
  const ToolRegistrySnapshot({required this.sessionId, required this.tools});

  final String sessionId;
  final List<ToolDescriptor> tools;

  @override
  JsonObject toJson() => {
    'type': 'tool_registry_snapshot',
    'session_id': sessionId,
    'tools': [for (final tool in tools) tool.toJson()],
  };
}

class ToolRegistryUpsert extends WireMessage {
  const ToolRegistryUpsert({required this.sessionId, required this.tool});

  final String sessionId;
  final ToolDescriptor tool;

  @override
  JsonObject toJson() => {
    'type': 'tool_registry_delta',
    'session_id': sessionId,
    'operation': 'upsert',
    'tool': tool.toJson(),
  };
}

class ToolRegistryRemove extends WireMessage {
  const ToolRegistryRemove({required this.sessionId, required this.name});

  final String sessionId;
  final String name;

  @override
  JsonObject toJson() => {
    'type': 'tool_registry_delta',
    'session_id': sessionId,
    'operation': 'remove',
    'name': name,
  };
}

class EventRegistrySnapshot extends WireMessage {
  const EventRegistrySnapshot({required this.sessionId, required this.events});

  final String sessionId;
  final List<EventDescriptor> events;

  @override
  JsonObject toJson() => {
    'type': 'event_registry_snapshot',
    'session_id': sessionId,
    'events': [for (final event in events) event.toJson()],
  };
}

class EventRegistryUpsert extends WireMessage {
  const EventRegistryUpsert({required this.sessionId, required this.event});

  final String sessionId;
  final EventDescriptor event;

  @override
  JsonObject toJson() => {
    'type': 'event_registry_delta',
    'session_id': sessionId,
    'operation': 'upsert',
    'event': event.toJson(),
  };
}

class EventRegistryRemove extends WireMessage {
  const EventRegistryRemove({required this.sessionId, required this.name});

  final String sessionId;
  final String name;

  @override
  JsonObject toJson() => {
    'type': 'event_registry_delta',
    'session_id': sessionId,
    'operation': 'remove',
    'name': name,
  };
}

class ToolCall extends WireMessage {
  const ToolCall({
    required this.sessionId,
    required this.id,
    required this.name,
    required this.args,
  });

  final String sessionId;
  final String id;
  final String name;
  final JsonObject args;

  @override
  JsonObject toJson() => {
    'type': 'tool_call',
    'session_id': sessionId,
    'id': id,
    'name': name,
    'args': args,
  };
}

class ToolResult extends WireMessage {
  const ToolResult({
    required this.sessionId,
    required this.id,
    required this.result,
  });

  final String sessionId;
  final String id;

  /// Any JSON value; `null` is a legitimate result.
  final Object? result;

  @override
  JsonObject toJson() => {
    'type': 'tool_result',
    'session_id': sessionId,
    'id': id,
    'result': result,
  };
}

class ToolError extends WireMessage {
  const ToolError({
    required this.sessionId,
    required this.id,
    required this.errorType,
    required this.message,
    this.details,
  });

  final String sessionId;
  final String id;

  /// One of the seven app-side types, such as `tool_execution_error`.
  final String errorType;
  final String message;
  final Object? details;

  @override
  JsonObject toJson() => {
    'type': 'tool_error',
    'session_id': sessionId,
    'id': id,
    'error': {
      'type': errorType,
      'message': message,
      if (details != null) 'details': details,
    },
  };
}

class ToolCallProgress extends WireMessage {
  const ToolCallProgress({
    required this.sessionId,
    required this.id,
    this.progress,
    this.message,
  });

  final String sessionId;
  final String id;
  final num? progress;
  final String? message;

  @override
  JsonObject toJson() => {
    'type': 'tool_call_progress',
    'session_id': sessionId,
    'id': id,
    if (progress != null) 'progress': progress,
    if (message != null) 'message': message,
  };
}

class ToolCancel extends WireMessage {
  const ToolCancel({
    required this.sessionId,
    required this.id,
    required this.reason,
  });

  final String sessionId;
  final String id;
  final String reason;

  @override
  JsonObject toJson() => {
    'type': 'tool_cancel',
    'session_id': sessionId,
    'id': id,
    'reason': reason,
  };
}

/// An app event (`type: "event"`), named `EventFrame` to keep it apart from the Dart-level idea of
/// an event.
class EventFrame extends WireMessage {
  const EventFrame({
    required this.sessionId,
    required this.name,
    this.payload,
    required this.ts,
  });

  final String sessionId;
  final String name;
  final Object? payload;

  /// Epoch milliseconds.
  final num ts;

  @override
  JsonObject toJson() => {
    'type': 'event',
    'session_id': sessionId,
    'name': name,
    if (payload != null) 'payload': payload,
    'ts': ts,
  };
}

String encodeFrame(WireMessage message) => jsonEncode(message.toJson());

/// Decodes one text frame. Returns [UnknownMessage] for a `type` this core does not know, and null
/// for text that is not JSON, not an object, has no string `type`, or fails its type's rules.
WireMessage? decodeFrame(String text) {
  final Object? decoded;
  try {
    decoded = jsonDecode(text);
  } on FormatException {
    return null;
  }

  final json = asObject(decoded);
  final type = json?['type'];
  if (json == null || type is! String) return null;

  return switch (type) {
    'session_claim' => _claim(json),
    'session_resume' => _resume(json),
    'session_ack' => _ack(json),
    'tool_registry_snapshot' => _toolSnapshot(json),
    'tool_registry_delta' => _toolDelta(json),
    'event_registry_snapshot' => _eventSnapshot(json),
    'event_registry_delta' => _eventDelta(json),
    'tool_call' => _toolCall(json),
    'tool_result' => _toolResult(json),
    'tool_error' => _toolError(json),
    'tool_call_progress' => _progress(json),
    'tool_cancel' => _cancel(json),
    'event' => _event(json),
    _ => UnknownMessage(type),
  };
}

bool _isSessionId(Object? value) => isBoundedString(value, maxWireIdLength);

SessionClaim? _claim(JsonObject json) {
  final device = [
    for (final key in ['device_manufacturer', 'device_model', 'device_os'])
      if (json.containsKey(key)) json[key],
  ];
  final devicesValid = device.every(
    (v) => v is String && v.length <= _maxDeviceFieldLength,
  );

  if (json['protocol_version'] != protocolVersion ||
      !_isSessionId(json['session_id']) ||
      !isBoundedString(json['token'], maxWireIdLength) ||
      !devicesValid) {
    return null;
  }

  return SessionClaim(
    sessionId: json['session_id']! as String,
    token: json['token']! as String,
    deviceManufacturer: json['device_manufacturer'] as String?,
    deviceModel: json['device_model'] as String?,
    deviceOs: json['device_os'] as String?,
  );
}

SessionResume? _resume(JsonObject json) {
  if (json['protocol_version'] != protocolVersion ||
      !_isSessionId(json['session_id']) ||
      !isBoundedString(json['resume_token'], maxWireIdLength)) {
    return null;
  }

  return SessionResume(
    sessionId: json['session_id']! as String,
    resumeToken: json['resume_token']! as String,
  );
}

SessionAck? _ack(JsonObject json) {
  if (!isAbsentOrValid(json, 'event_registry', (v) => v == true) ||
      json['status'] != 'ok' ||
      !_isSessionId(json['session_id']) ||
      !isBoundedString(json['alias'], maxWireIdLength) ||
      !isBoundedString(json['resume_token'], maxWireIdLength) ||
      !isFiniteNumber(json['keepalive_interval_s']) ||
      !isFiniteNumber(json['grace_s'])) {
    return null;
  }

  return SessionAck(
    sessionId: json['session_id']! as String,
    alias: json['alias']! as String,
    resumeToken: json['resume_token']! as String,
    keepaliveIntervalS: json['keepalive_interval_s']! as num,
    graceS: json['grace_s']! as num,
    eventRegistry: json['event_registry'] == true,
  );
}

/// Every element must pass [parse]; one invalid element invalidates the whole list.
List<T>? _parseAll<T>(Object? value, T? Function(Object?) parse) {
  if (value is! List) return null;
  final parsed = <T>[];
  for (final item in value) {
    final element = parse(item);
    if (element == null) return null;
    parsed.add(element);
  }
  return parsed;
}

ToolRegistrySnapshot? _toolSnapshot(JsonObject json) {
  final tools = _parseAll(json['tools'], parseToolDescriptor);
  if (!_isSessionId(json['session_id']) || tools == null) return null;

  return ToolRegistrySnapshot(
    sessionId: json['session_id']! as String,
    tools: tools,
  );
}

WireMessage? _toolDelta(JsonObject json) {
  if (!_isSessionId(json['session_id'])) return null;
  final sessionId = json['session_id']! as String;

  switch (json['operation']) {
    case 'upsert':
      final tool = parseToolDescriptor(json['tool']);
      return tool == null
          ? null
          : ToolRegistryUpsert(sessionId: sessionId, tool: tool);
    case 'remove':
      return isBoundedString(json['name'], maxWireStringLength)
          ? ToolRegistryRemove(
              sessionId: sessionId,
              name: json['name']! as String,
            )
          : null;
    default:
      return null;
  }
}

EventRegistrySnapshot? _eventSnapshot(JsonObject json) {
  final events = _parseAll(json['events'], parseEventDescriptor);
  if (!_isSessionId(json['session_id']) || events == null) return null;

  return EventRegistrySnapshot(
    sessionId: json['session_id']! as String,
    events: events,
  );
}

WireMessage? _eventDelta(JsonObject json) {
  if (!_isSessionId(json['session_id'])) return null;
  final sessionId = json['session_id']! as String;

  switch (json['operation']) {
    case 'upsert':
      final event = parseEventDescriptor(json['event']);
      return event == null
          ? null
          : EventRegistryUpsert(sessionId: sessionId, event: event);
    case 'remove':
      return isBoundedString(json['name'], maxWireStringLength)
          ? EventRegistryRemove(
              sessionId: sessionId,
              name: json['name']! as String,
            )
          : null;
    default:
      return null;
  }
}

ToolCall? _toolCall(JsonObject json) {
  final args = asObject(json['args']);
  if (!_isSessionId(json['session_id']) ||
      !isBoundedString(json['id'], maxWireIdLength) ||
      !isBoundedString(json['name'], maxWireStringLength) ||
      args == null) {
    return null;
  }

  return ToolCall(
    sessionId: json['session_id']! as String,
    id: json['id']! as String,
    name: json['name']! as String,
    args: args,
  );
}

ToolResult? _toolResult(JsonObject json) {
  if (!_isSessionId(json['session_id']) ||
      !isBoundedString(json['id'], maxWireIdLength) ||
      !json.containsKey('result')) {
    return null;
  }

  return ToolResult(
    sessionId: json['session_id']! as String,
    id: json['id']! as String,
    result: json['result'],
  );
}

ToolError? _toolError(JsonObject json) {
  final error = asObject(json['error']);
  if (!_isSessionId(json['session_id']) ||
      !isBoundedString(json['id'], maxWireIdLength) ||
      error == null ||
      !_toolErrorTypes.contains(error['type']) ||
      !isBoundedString(error['message'], maxWireStringLength)) {
    return null;
  }

  return ToolError(
    sessionId: json['session_id']! as String,
    id: json['id']! as String,
    errorType: error['type']! as String,
    message: error['message']! as String,
    details: error['details'],
  );
}

ToolCallProgress? _progress(JsonObject json) {
  if (!_isSessionId(json['session_id']) ||
      !isBoundedString(json['id'], maxWireIdLength) ||
      !isAbsentOrValid(json, 'progress', isFiniteNumber) ||
      !isAbsentOrValid(
        json,
        'message',
        (v) => isBoundedString(v, maxWireStringLength),
      )) {
    return null;
  }

  return ToolCallProgress(
    sessionId: json['session_id']! as String,
    id: json['id']! as String,
    progress: json['progress'] as num?,
    message: json['message'] as String?,
  );
}

ToolCancel? _cancel(JsonObject json) {
  if (!_isSessionId(json['session_id']) ||
      !isBoundedString(json['id'], maxWireIdLength) ||
      !isBoundedString(json['reason'], maxWireStringLength)) {
    return null;
  }

  return ToolCancel(
    sessionId: json['session_id']! as String,
    id: json['id']! as String,
    reason: json['reason']! as String,
  );
}

EventFrame? _event(JsonObject json) {
  if (!_isSessionId(json['session_id']) ||
      !isBoundedString(json['name'], maxWireStringLength) ||
      !isFiniteNumber(json['ts'])) {
    return null;
  }

  return EventFrame(
    sessionId: json['session_id']! as String,
    name: json['name']! as String,
    payload: json['payload'],
    ts: json['ts']! as num,
  );
}
