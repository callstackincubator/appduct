/// Field checks shared by the descriptor and message codecs. They mirror the guards in
/// `packages/shared/src/domains` and count string length in UTF-16 code units, as JavaScript does.
library;

typedef JsonObject = Map<String, Object?>;

/// Longest tool description, event description, error message or event name.
const maxWireStringLength = 4096;

/// Longest session id, call id or token.
const maxWireIdLength = 128;

JsonObject? asObject(Object? value) {
  return value is Map ? value.cast<String, Object?>() : null;
}

bool isBoundedString(Object? value, int maxLength) {
  return value is String && value.isNotEmpty && value.length <= maxLength;
}

/// JSON delivers a number as `int` or `double`; never assume which.
bool isFiniteNumber(Object? value) => value is num && value.isFinite;

/// True when [value] is an optional key that is absent, or present and accepted by [isValid].
/// A present `null` is not absent.
bool isAbsentOrValid(
  JsonObject json,
  String key,
  bool Function(Object?) isValid,
) {
  return !json.containsKey(key) || isValid(json[key]);
}
