import 'ports.dart';

class MemorySessionStore implements SessionStore {
  MemorySessionStore([this._value]);

  String? _value;

  /// What is stored now, or null.
  String? get value => _value;

  @override
  String? read() => _value;

  @override
  void write(String value) => _value = value;

  @override
  void clear() => _value = null;
}
