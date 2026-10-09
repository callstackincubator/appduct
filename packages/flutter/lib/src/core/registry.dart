import 'descriptors.dart';
import 'json.dart';

const _minToolTimeoutMs = 1000;
const _maxToolTimeoutMs = 600000;

/// Descriptors by name, in registration order; a re-registration keeps its place.
class Registry<T> {
  Registry._(this._parse, this._nameOf, this._kind);

  final T? Function(Object?) _parse;
  final String Function(T) _nameOf;
  final String _kind;
  final Map<String, T> _entries = {};

  /// Validates [json] and stores it. Throws [ArgumentError] when it is not a valid descriptor.
  /// Returns what goes on the wire.
  T upsert(JsonObject json) {
    final parsed = _parse(json);
    if (parsed == null) {
      final name = json['name'];
      throw ArgumentError.value(
        json,
        'descriptor',
        '$_kind${name is String ? ' "${name.length > 64 ? name.substring(0, 64) : name}"' : ''} is not a valid ${_kind.toLowerCase()} descriptor.',
      );
    }
    _entries[_nameOf(parsed)] = parsed;
    return parsed;
  }

  /// Whether [name] was registered.
  bool remove(String name) => _entries.remove(name) != null;

  T? get(String name) => _entries[name];

  List<T> list() => List.unmodifiable(_entries.values);
}

/// Only the fields `docs/PROTOCOL.md` section 5 defines are kept, and `timeout_ms` is clamped to
/// 1 s to 10 min, as the other cores do.
Registry<ToolDescriptor> createToolRegistry() => Registry._(
  (json) {
    final tool = parseToolDescriptor(json);
    if (tool == null || tool.timeoutMs == null) return tool;
    return ToolDescriptor(
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      timeoutMs: tool.timeoutMs!.clamp(_minToolTimeoutMs, _maxToolTimeoutMs),
      group: tool.group,
    );
  },
  (tool) => tool.name,
  'Tool',
);

Registry<EventDescriptor> createEventRegistry() =>
    Registry._(parseEventDescriptor, (event) => event.name, 'Event');
