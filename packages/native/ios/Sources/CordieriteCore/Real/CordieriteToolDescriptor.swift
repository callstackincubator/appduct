// Vendored into @cordierite/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if CORDIERITE_ENABLED

import Foundation

/// Mirrors `@cordierite/shared`'s `ToolAnnotations` (PROTOCOL.md §7): exactly these three optional
/// booleans, nothing else.
public struct ToolAnnotations: Sendable, Equatable {
  public var readOnlyHint: Bool?
  public var destructiveHint: Bool?
  public var idempotentHint: Bool?

  public init(readOnlyHint: Bool? = nil, destructiveHint: Bool? = nil, idempotentHint: Bool? = nil) {
    self.readOnlyHint = readOnlyHint
    self.destructiveHint = destructiveHint
    self.idempotentHint = idempotentHint
  }

  var jsonValue: JSONValue {
    var out: JSONObject = [:]
    if let readOnlyHint { out["readOnlyHint"] = .bool(readOnlyHint) }
    if let destructiveHint { out["destructiveHint"] = .bool(destructiveHint) }
    if let idempotentHint { out["idempotentHint"] = .bool(idempotentHint) }
    return .object(out)
  }
}

/// Mirrors `@cordierite/shared`'s `ToolDescriptor` (PROTOCOL.md §5/§7) one-to-one, including the
/// snake_case wire field names.
public struct ToolDescriptor: Sendable, Equatable {
  public var name: String
  public var description: String
  public var inputSchema: JSONObject?
  public var outputSchema: JSONObject?
  public var annotations: ToolAnnotations?
  /// Positive integer milliseconds; the app-declared per-call deadline (§5).
  public var timeoutMs: Int?

  public init(
    name: String,
    description: String,
    inputSchema: JSONObject? = nil,
    outputSchema: JSONObject? = nil,
    annotations: ToolAnnotations? = nil,
    timeoutMs: Int? = nil
  ) {
    self.name = name
    self.description = description
    self.inputSchema = inputSchema
    self.outputSchema = outputSchema
    self.annotations = annotations
    self.timeoutMs = timeoutMs
  }

  public var wireValue: JSONValue {
    var out: JSONObject = ["name": .string(name), "description": .string(description)]
    if let inputSchema { out["input_schema"] = .object(inputSchema) }
    if let outputSchema { out["output_schema"] = .object(outputSchema) }
    if let annotations { out["annotations"] = annotations.jsonValue }
    if let timeoutMs { out["timeout_ms"] = .number(Double(timeoutMs)) }
    return .object(out)
  }
}

public struct ToolDescriptorValidationError: Error, Sendable, CustomStringConvertible {
  public let message: String
  public init(_ message: String) {
    self.message = message
  }
  public var description: String { message }
}

private let toolNamePattern: NSRegularExpression = {
  // `^[a-zA-Z0-9_-]{1,64}$` -- mirrors `@cordierite/shared`'s `TOOL_NAME_PATTERN`.
  // swiftlint:disable:next force_try
  try! NSRegularExpression(pattern: "^[a-zA-Z0-9_-]{1,64}$")
}()

private func matchesToolNamePattern(_ name: String) -> Bool {
  let range = NSRange(name.startIndex..<name.endIndex, in: name)
  return toolNamePattern.firstMatch(in: name, range: range) != nil
}

private let toolAnnotationKeys: Set<String> = ["readOnlyHint", "destructiveHint", "idempotentHint"]
private let maxToolDescriptionLength = 4096

/// Ports `@cordierite/shared`'s `isToolDescriptor` exactly (PROTOCOL.md §5): name pattern,
/// description length 1...4096, `input_schema`/`output_schema` must be JSON objects if present,
/// `annotations` must be a JSON object of only the three known boolean keys, and `timeout_ms` must
/// be a positive integer if present.
public func validateToolDescriptor(_ descriptor: ToolDescriptor) throws {
  guard matchesToolNamePattern(descriptor.name) else {
    throw ToolDescriptorValidationError(
      "Tool name \"\(descriptor.name)\" must match ^[a-zA-Z0-9_-]{1,64}$."
    )
  }

  guard !descriptor.description.isEmpty else {
    throw ToolDescriptorValidationError("Tool \"\(descriptor.name)\" description must not be empty.")
  }

  guard descriptor.description.utf16.count <= maxToolDescriptionLength else {
    throw ToolDescriptorValidationError(
      "Tool \"\(descriptor.name)\" description must be at most \(maxToolDescriptionLength) characters."
    )
  }

  if let annotations = descriptor.annotations {
    _ = annotations // JSON-object-of-known-keys is guaranteed by the typed `ToolAnnotations` struct.
  }

  if let timeoutMs = descriptor.timeoutMs, timeoutMs <= 0 {
    throw ToolDescriptorValidationError(
      "Tool \"\(descriptor.name)\" timeout_ms must be a positive integer."
    )
  }
}

/// Parses a raw wire `ToolDescriptor` JSON object (as `registerTool(descriptorJson:)` receives from
/// JS) into the typed struct, validating along the way. `input_schema`/`output_schema`/`annotations`
/// must be JSON objects if present; an `annotations` object may carry only the three known keys,
/// each boolean if present.
public func parseToolDescriptor(_ value: JSONValue) throws -> ToolDescriptor {
  guard case .object(let object) = value else {
    throw ToolDescriptorValidationError("Tool descriptor must be a JSON object.")
  }

  guard let name = object["name"]?.stringValue, !name.isEmpty else {
    throw ToolDescriptorValidationError("Tool descriptor is missing a valid \"name\".")
  }

  guard let description = object["description"]?.stringValue else {
    throw ToolDescriptorValidationError("Tool descriptor is missing a valid \"description\".")
  }

  var inputSchema: JSONObject?
  if let raw = object["input_schema"], !raw.isNull {
    guard let schema = raw.objectValue else {
      throw ToolDescriptorValidationError("Tool \"\(name)\" input_schema must be a JSON object.")
    }
    inputSchema = schema
  }

  var outputSchema: JSONObject?
  if let raw = object["output_schema"], !raw.isNull {
    guard let schema = raw.objectValue else {
      throw ToolDescriptorValidationError("Tool \"\(name)\" output_schema must be a JSON object.")
    }
    outputSchema = schema
  }

  var annotations: ToolAnnotations?
  if let raw = object["annotations"], !raw.isNull {
    guard let dict = raw.objectValue else {
      throw ToolDescriptorValidationError("Tool \"\(name)\" annotations must be a JSON object.")
    }
    for key in dict.keys {
      guard toolAnnotationKeys.contains(key) else {
        throw ToolDescriptorValidationError("Tool \"\(name)\" annotations has an unknown key \"\(key)\".")
      }
    }
    for key in dict.keys {
      guard dict[key]?.boolValue != nil || dict[key]?.isNull == true else {
        throw ToolDescriptorValidationError("Tool \"\(name)\" annotations.\(key) must be a boolean.")
      }
    }
    annotations = ToolAnnotations(
      readOnlyHint: dict["readOnlyHint"]?.boolValue,
      destructiveHint: dict["destructiveHint"]?.boolValue,
      idempotentHint: dict["idempotentHint"]?.boolValue
    )
  }

  var timeoutMs: Int?
  if let raw = object["timeout_ms"], !raw.isNull {
    guard let doubleValue = raw.doubleValue, doubleValue == doubleValue.rounded() else {
      throw ToolDescriptorValidationError("Tool \"\(name)\" timeout_ms must be an integer.")
    }
    timeoutMs = Int(doubleValue)
  }

  let descriptor = ToolDescriptor(
    name: name,
    description: description,
    inputSchema: inputSchema,
    outputSchema: outputSchema,
    annotations: annotations,
    timeoutMs: timeoutMs
  )

  try validateToolDescriptor(descriptor)
  return descriptor
}

#endif
