// Vendored into @appduct/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if APPDUCT_ENABLED

import Foundation

/// Mirrors `@appduct/shared`'s `EventDescriptor` (PROTOCOL.md §5a): an event the app posts,
/// declared so an agent can list it before waiting on it.
public struct EventDescriptor: Sendable, Equatable {
  public var name: String
  public var description: String
  public var payloadSchema: JSONObject?

  public init(name: String, description: String, payloadSchema: JSONObject? = nil) {
    self.name = name
    self.description = description
    self.payloadSchema = payloadSchema
  }

  public var wireValue: JSONValue {
    var out: JSONObject = ["name": .string(name), "description": .string(description)]
    if let payloadSchema { out["payload_schema"] = .object(payloadSchema) }
    return .object(out)
  }
}

/// A handle returned by `AppductClient.registerEvent`. `remove()` withdraws the declaration;
/// letting this value go out of scope does **not**, matching `ToolRegistration`.
public struct EventRegistration: Sendable {
  private let unregister: @Sendable () -> Void

  init(_ unregister: @escaping @Sendable () -> Void) {
    self.unregister = unregister
  }

  public func remove() {
    unregister()
  }
}

private let maxEventNameLength = 4_096
private let maxEventDescriptionLength = 4_096

/// Ports `@appduct/shared`'s `isEventDescriptor` (PROTOCOL.md §5a): a name is any non-empty string
/// of at most 4096 UTF-16 code units (the posted-name rule, not the tool-name pattern) and a
/// description is 1 to 4096 UTF-16 code units. `payloadSchema`'s type already guarantees a JSON
/// object.
public func validateEventDescriptor(_ descriptor: EventDescriptor) throws {
  guard !descriptor.name.isEmpty, descriptor.name.utf16.count <= maxEventNameLength else {
    throw ToolDescriptorValidationError("Event name must be 1 to \(maxEventNameLength) characters.")
  }
  guard !descriptor.description.isEmpty, descriptor.description.utf16.count <= maxEventDescriptionLength else {
    throw ToolDescriptorValidationError(
      "Event \"\(descriptor.name)\" description must be 1 to \(maxEventDescriptionLength) characters."
    )
  }
}

/// Parses a raw wire `EventDescriptor` JSON object into the typed struct and validates it.
/// `payload_schema` must be a JSON object if present; an explicit `null` is rejected, as in TS.
public func parseEventDescriptor(_ value: JSONValue) throws -> EventDescriptor {
  guard case .object(let object) = value else {
    throw ToolDescriptorValidationError("Event descriptor must be a JSON object.")
  }
  guard let name = object["name"]?.stringValue, let description = object["description"]?.stringValue else {
    throw ToolDescriptorValidationError("Event descriptor needs a string \"name\" and \"description\".")
  }

  var payloadSchema: JSONObject?
  if let raw = object["payload_schema"] {
    guard let schema = raw.objectValue else {
      throw ToolDescriptorValidationError("Event \"\(name)\" payload_schema must be a JSON object.")
    }
    payloadSchema = schema
  }

  let descriptor = EventDescriptor(name: name, description: description, payloadSchema: payloadSchema)
  try validateEventDescriptor(descriptor)
  return descriptor
}

/// Declared events in declaration order (an update to an existing name keeps its position).
/// Lock-guarded rather than actor-isolated for the same reason as `AppductToolRegistryStore`:
/// `registerEvent` is synchronous and throwing.
final class AppductEventRegistryStore: @unchecked Sendable {
  private let lock = NSLock()
  private var order: [String] = []
  private var entries: [String: EventDescriptor] = [:]

  func upsert(_ descriptor: EventDescriptor) {
    lock.lock()
    defer { lock.unlock() }
    if entries[descriptor.name] == nil { order.append(descriptor.name) }
    entries[descriptor.name] = descriptor
  }

  @discardableResult
  func remove(_ name: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard entries.removeValue(forKey: name) != nil else { return false }
    order.removeAll { $0 == name }
    return true
  }

  func snapshot() -> [EventDescriptor] {
    lock.lock()
    defer { lock.unlock() }
    return order.compactMap { entries[$0] }
  }
}

#endif
