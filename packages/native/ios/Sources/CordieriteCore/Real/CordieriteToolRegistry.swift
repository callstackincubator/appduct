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
  /// iteration order on `set()` of an existing key). A declared `timeout_ms` is clamped to
  /// `[CORDIERITE_MIN_TOOL_TIMEOUT_MS, CORDIERITE_MAX_TOOL_TIMEOUT_MS]` before it is stored, so the
  /// clamped value is what both the local abort timer and the `tool_registry_snapshot`/`_delta`
  /// wire frames use. Returns the stored (possibly clamped) descriptor, so a caller sending a
  /// registry delta sends the same value that was actually stored.
  @discardableResult
  func upsert(_ descriptor: ToolDescriptor, handler: @escaping ToolHandler, defaultTimeoutMs: Int) throws -> ToolDescriptor {
    try validateToolDescriptor(descriptor)

    var effectiveDescriptor = descriptor
    if let declaredTimeoutMs = descriptor.timeoutMs {
      effectiveDescriptor.timeoutMs = clampCordieriteToolTimeoutMs(declaredTimeoutMs)
    }

    lock.lock()
    defer { lock.unlock() }

    let timeoutMs = effectiveDescriptor.timeoutMs ?? defaultTimeoutMs
    if entries[effectiveDescriptor.name] == nil {
      order.append(effectiveDescriptor.name)
    }
    entries[effectiveDescriptor.name] = CordieriteRegisteredTool(
      descriptor: effectiveDescriptor,
      handler: handler,
      timeoutMs: timeoutMs
    )
    return effectiveDescriptor
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
