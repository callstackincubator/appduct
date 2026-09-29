// Vendored into @appduct/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if APPDUCT_ENABLED

import Foundation

/// The OS's grant of a few extra seconds of run time to an app that has just left the
/// foreground. Owned by `AppductClient`, which holds it for the whole background window so tool
/// calls keep working; this is the only place UIKit's background-task API is touched.
public protocol AppductBackgroundTime: Sendable {
  /// Asks for background time. `onExpire` runs when the OS is about to take it back (or refused
  /// to grant any). Disposing the result ends the time; it is idempotent.
  func begin(onExpire: @escaping @Sendable () -> Void) -> any AppductDisposable
}

/// In-memory stand-in for the OS grant: a test reads `held` and calls `expire()`.
final class FakeAppductBackgroundTime: AppductBackgroundTime, @unchecked Sendable {
  private let lock = NSLock()
  private var _beginCallCount = 0
  private var holds: [Int: @Sendable () -> Void] = [:]

  var beginCallCount: Int { lock.lock(); defer { lock.unlock() }; return _beginCallCount }
  /// Grants requested and not yet ended.
  var held: Int { lock.lock(); defer { lock.unlock() }; return holds.count }

  func begin(onExpire: @escaping @Sendable () -> Void) -> any AppductDisposable {
    lock.lock()
    _beginCallCount += 1
    let id = _beginCallCount
    holds[id] = onExpire
    lock.unlock()
    return ClosureDisposable { [weak self] in
      self?.lock.lock()
      self?.holds[id] = nil
      self?.lock.unlock()
    }
  }

  /// The OS announces the time is running out. The hold stays until the client disposes it.
  func expire() {
    lock.lock()
    let handlers = Array(holds.values)
    lock.unlock()
    for handler in handlers { handler() }
  }
}

#endif
