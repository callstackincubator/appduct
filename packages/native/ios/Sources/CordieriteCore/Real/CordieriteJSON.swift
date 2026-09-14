// Vendored into @cordierite/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if CORDIERITE_ENABLED

import Foundation

/// A JSON value with value semantics, used as the currency type for everything the core reads or
/// writes at the JSON boundary: tool descriptors, tool call args/results, event payloads. Distinct
/// from `Any`/`NSObject` so handler code, tests, and the wire (de)serializers all share one strict,
/// `Sendable`, `Equatable` representation instead of casting `Any` at every use site.
public enum JSONValue: Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])
}

public typealias JSONObject = [String: JSONValue]

public struct CordieriteJSONError: Error, Sendable, CustomStringConvertible {
  public let message: String
  public init(_ message: String) {
    self.message = message
  }
  public var description: String { message }
}

extension JSONValue {
  /// Converts a `JSONSerialization`-produced `Any` (the result of parsing wire JSON) into a
  /// `JSONValue`. Numbers arrive as `NSNumber`; booleans are `NSNumber` too (CFBoolean) and are
  /// distinguished from numeric `NSNumber` by `CFGetTypeID`, matching the shared package's own
  /// `positiveFiniteNumber` boolean-exclusion trick.
  public static func from(foundation value: Any) -> JSONValue {
    switch value {
    case is NSNull:
      return .null
    case let number as NSNumber:
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        return .bool(number.boolValue)
      }
      return .number(number.doubleValue)
    case let string as String:
      return .string(string)
    case let array as [Any]:
      return .array(array.map { JSONValue.from(foundation: $0) })
    case let dict as [String: Any]:
      var out: [String: JSONValue] = [:]
      out.reserveCapacity(dict.count)
      for (key, value) in dict {
        out[key] = JSONValue.from(foundation: value)
      }
      return .object(out)
    default:
      return .null
    }
  }

  /// Foundation representation suitable for `JSONSerialization.data(withJSONObject:)`.
  public var foundationValue: Any {
    switch self {
    case .null:
      return NSNull()
    case .bool(let value):
      return value
    case .number(let value):
      return value
    case .string(let value):
      return value
    case .array(let values):
      return values.map { $0.foundationValue }
    case .object(let values):
      var out: [String: Any] = [:]
      out.reserveCapacity(values.count)
      for (key, value) in values {
        out[key] = value.foundationValue
      }
      return out
    }
  }

  public var objectValue: JSONObject? {
    if case .object(let value) = self { return value }
    return nil
  }

  public var arrayValue: [JSONValue]? {
    if case .array(let value) = self { return value }
    return nil
  }

  public var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  public var doubleValue: Double? {
    if case .number(let value) = self { return value }
    return nil
  }

  public var boolValue: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }

  public var isNull: Bool {
    if case .null = self { return true }
    return false
  }

  /// Parses a UTF-8 JSON string into a `JSONValue`. Every recognized JSON shape round-trips,
  /// including top-level scalars (`JSONSerialization` requires `.fragmentsAllowed` for those).
  public static func parse(_ text: String) throws -> JSONValue {
    guard let data = text.data(using: .utf8) else {
      throw CordieriteJSONError("Not valid UTF-8 JSON text.")
    }
    let raw = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    return JSONValue.from(foundation: raw)
  }

  /// Serializes to a JSON string. Throws (rather than producing invalid JSON) on a non-finite
  /// `.number` (`NaN`/`Infinity`), matching `JSON.stringify`'s behavior of turning those into
  /// `null` being explicitly disallowed for Cordierite's own "must be JSON-serializable" checks --
  /// callers that want tool_serialization_error semantics should catch this.
  public func serialized() throws -> String {
    try assertFinite()
    let data = try JSONSerialization.data(withJSONObject: foundationValue, options: [.fragmentsAllowed])
    guard let text = String(data: data, encoding: .utf8) else {
      throw CordieriteJSONError("Failed to encode JSON as UTF-8.")
    }
    return text
  }

  private func assertFinite() throws {
    switch self {
    case .number(let value):
      guard value.isFinite else {
        throw CordieriteJSONError("JSON number must be finite (got \(value)).")
      }
    case .array(let values):
      for value in values { try value.assertFinite() }
    case .object(let values):
      for value in values.values { try value.assertFinite() }
    default:
      break
    }
  }
}

#endif
