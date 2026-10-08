import 'json.dart';

final _toolNamePattern = RegExp(r'^[a-zA-Z0-9_-]{1,64}$');
final _toolGroupPattern = RegExp(
  r'^[a-zA-Z0-9_-]{1,64}(?:/[a-zA-Z0-9_-]{1,64})?$',
);
const _annotationKeys = {'readOnlyHint', 'destructiveHint', 'idempotentHint'};

/// A tool as declared on the wire (`docs/PROTOCOL.md` section 5).
class ToolDescriptor {
  const ToolDescriptor({
    required this.name,
    required this.description,
    this.inputSchema,
    this.outputSchema,
    this.annotations,
    this.timeoutMs,
    this.group,
  });

  final String name;
  final String description;
  final JsonObject? inputSchema;
  final JsonObject? outputSchema;

  /// Only `readOnlyHint`, `destructiveHint` and `idempotentHint`, each a bool.
  final Map<String, bool>? annotations;
  final int? timeoutMs;
  final String? group;

  JsonObject toJson() => {
    'name': name,
    'description': description,
    if (inputSchema != null) 'input_schema': inputSchema,
    if (outputSchema != null) 'output_schema': outputSchema,
    if (annotations != null) 'annotations': annotations,
    if (timeoutMs != null) 'timeout_ms': timeoutMs,
    if (group != null) 'group': group,
  };
}

/// An event as declared on the wire (`docs/PROTOCOL.md` section 5a).
class EventDescriptor {
  const EventDescriptor({
    required this.name,
    required this.description,
    this.payloadSchema,
  });

  final String name;
  final String description;
  final JsonObject? payloadSchema;

  JsonObject toJson() => {
    'name': name,
    'description': description,
    if (payloadSchema != null) 'payload_schema': payloadSchema,
  };
}

/// Validates [value] against every rule of `docs/PROTOCOL.md` section 5. Returns null when it
/// fails any of them. A key that is present must be valid, so an explicit `null` is invalid.
ToolDescriptor? parseToolDescriptor(Object? value) {
  final json = asObject(value);
  if (json == null) {
    return null;
  }

  final name = json['name'];
  final description = json['description'];
  if (name is! String || !_toolNamePattern.hasMatch(name)) {
    return null;
  }
  if (!isBoundedString(description, maxWireStringLength)) {
    return null;
  }

  final annotations = json['annotations'];
  final timeoutMs = json['timeout_ms'];
  final group = json['group'];

  if (!isAbsentOrValid(json, 'input_schema', _isObject)) {
    return null;
  }
  if (!isAbsentOrValid(json, 'output_schema', _isObject)) {
    return null;
  }
  if (!isAbsentOrValid(json, 'annotations', _isAnnotations)) {
    return null;
  }
  if (!isAbsentOrValid(json, 'timeout_ms', _isPositiveInteger)) {
    return null;
  }
  if (!isAbsentOrValid(
    json,
    'group',
    (v) => v is String && _toolGroupPattern.hasMatch(v),
  )) {
    return null;
  }

  return ToolDescriptor(
    name: name,
    description: description! as String,
    inputSchema: asObject(json['input_schema']),
    outputSchema: asObject(json['output_schema']),
    annotations: annotations == null
        ? null
        : asObject(annotations)!.cast<String, bool>(),
    timeoutMs: timeoutMs == null ? null : (timeoutMs as num).toInt(),
    group: group as String?,
  );
}

/// Validates [value] against `docs/PROTOCOL.md` section 5a; null when it fails.
EventDescriptor? parseEventDescriptor(Object? value) {
  final json = asObject(value);
  if (json == null) {
    return null;
  }

  if (!isBoundedString(json['name'], maxWireStringLength)) {
    return null;
  }
  if (!isBoundedString(json['description'], maxWireStringLength)) {
    return null;
  }
  if (!isAbsentOrValid(json, 'payload_schema', _isObject)) {
    return null;
  }
  return EventDescriptor(
    name: json['name']! as String,
    description: json['description']! as String,
    payloadSchema: asObject(json['payload_schema']),
  );
}

bool _isAnnotations(Object? value) {
  final json = asObject(value);
  return json != null &&
      json.entries.every(
        (e) => _annotationKeys.contains(e.key) && e.value is bool,
      );
}

/// A positive whole number, whether JSON delivered it as `int` or as `double` (`5000.0`).
bool _isPositiveInteger(Object? value) {
  return value is num &&
      value.isFinite &&
      value > 0 &&
      value == value.truncate();
}

bool _isObject(Object? value) => asObject(value) != null;
