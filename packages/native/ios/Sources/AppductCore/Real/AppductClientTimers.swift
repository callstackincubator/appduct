// Vendored into @appduct/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if APPDUCT_ENABLED

import Foundation

/// Opaque timer handle: never inspected, only round-tripped to `cancelTimer`. Mirrors
/// `client/timers.ts`'s `ClientTimerHandle`.
public protocol AppductTimerHandle: Sendable {}

/// DI seam for the reconnect/backoff/grace state machine: real time in production, fully
/// controllable in tests (fake clock, deterministic jitter). Mirrors `client/timers.ts`'s
/// `ClientTimers` exactly, so the Swift reconnect/grace tests can assert against the same schedule
/// the JS tests did.
public protocol AppductClientTimers: Sendable {
  /// Unix milliseconds.
  func now() -> Double
  /// Jitter source for `AppductBackoff.fullJitterMs`.
  func random() -> Double
  @discardableResult
  func setTimeout(afterMs: Double, _ handler: @escaping @Sendable () -> Void) -> any AppductTimerHandle
  func clearTimeout(_ handle: any AppductTimerHandle)
}

/// Production timers: `Task.sleep` wrapped in a cancellable handle, wall-clock `now`, `Double.random`
/// jitter.
public struct SystemAppductClientTimers: AppductClientTimers {
  public init() {}

  public func now() -> Double {
    Date().timeIntervalSince1970 * 1_000
  }

  public func random() -> Double {
    Double.random(in: 0..<1)
  }

  public func setTimeout(afterMs: Double, _ handler: @escaping @Sendable () -> Void) -> any AppductTimerHandle {
    let nanoseconds = UInt64(max(0, afterMs) * 1_000_000)
    let task = Task {
      try? await Task.sleep(nanoseconds: nanoseconds)
      guard !Task.isCancelled else { return }
      handler()
    }
    return SystemTimerHandle(task: task)
  }

  public func clearTimeout(_ handle: any AppductTimerHandle) {
    (handle as? SystemTimerHandle)?.cancel()
  }

  private final class SystemTimerHandle: AppductTimerHandle, @unchecked Sendable {
    private let task: Task<Void, Never>
    init(task: Task<Void, Never>) { self.task = task }
    func cancel() { task.cancel() }
  }
}

#endif
