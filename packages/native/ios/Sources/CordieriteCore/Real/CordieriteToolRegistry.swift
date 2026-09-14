// Vendored into @cordierite/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if CORDIERITE_ENABLED

import Foundation

public enum CordieriteRegistryDelta: Sendable, Equatable {
  case upsert(ToolDescriptor)
  case remove(String)
}

struct CordieriteRegisteredTool {
  let descriptor: ToolDescriptor
  let handler: ToolHandler
  let timeoutMs: Int
}

/// Tool registration table, ported from `client/registry.ts`. Deliberately **not** actor-isolated:
/// the TurboModule bridge's `registerTool`/`unregisterTool` are synchronous, throwing methods (no
/// `Promise`), so validation and the registry mutation itself must complete before the call returns
/// -- an actor hop cannot do that without blocking a thread. Guarded by a single `NSLock` instead,
/// the same pattern `CordieriteProcessResumeLeaseStore` already uses for the same reason. Sending
/// the resulting `tool_registry_delta` frame is genuinely async (network I/O) and is fired off
/// separately by `CordieriteClient`, exactly mirroring the original JS `registerTool`'s synchronous
/// return plus fire-and-forget delta send.
final class CordieriteToolRegistryStore: @unchecked Sendable {
  private let lock = NSLock()
  private var order: [String] = []
  private var entries: [String: CordieriteRegisteredTool] = [:]

  /// Validates and upserts `descriptor` (registration order preserved for a name seen for the first
  /// time -- an update to an existing name keeps its original position, matching a JS `Map`'s
  /// iteration order on `set()` of an existing key).
  func upsert(_ descriptor: ToolDescriptor, handler: @escaping ToolHandler, defaultTimeoutMs: Int) throws {
    try validateToolDescriptor(descriptor)

    lock.lock()
    defer { lock.unlock() }

    let timeoutMs = descriptor.timeoutMs ?? defaultTimeoutMs
    if entries[descriptor.name] == nil {
      order.append(descriptor.name)
    }
    entries[descriptor.name] = CordieriteRegisteredTool(descriptor: descriptor, handler: handler, timeoutMs: timeoutMs)
  }

  @discardableResult
  func remove(_ name: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }

    guard entries.removeValue(forKey: name) != nil else { return false }
    order.removeAll { $0 == name }
    return true
  }

  func lookup(_ name: String) -> CordieriteRegisteredTool? {
    lock.lock()
    defer { lock.unlock() }
    return entries[name]
  }

  func snapshot() -> [ToolDescriptor] {
    lock.lock()
    defer { lock.unlock() }
    return order.compactMap { entries[$0]?.descriptor }
  }
}

#endif
