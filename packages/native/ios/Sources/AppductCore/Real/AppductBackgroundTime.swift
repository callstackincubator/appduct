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

#if canImport(UIKit)
  import UIKit

  /// `UIApplication.beginBackgroundTask` adapter -- the only caller of UIKit's background-task API.
  /// `@unchecked Sendable`: it holds no state; each grant keeps its own under a lock.
  public final class UIKitAppductBackgroundTime: AppductBackgroundTime, @unchecked Sendable {
    public init() {}

    public func begin(onExpire: @escaping @Sendable () -> Void) -> any AppductDisposable {
      let grant = Grant()
      let id = Self.onMain {
        UIApplication.shared.beginBackgroundTask(withName: "appduct.background-window") {
          onExpire()
          // iOS wants the task ended promptly after the handler runs. The client normally ends it
          // once the close event arrives; this caps the wait so a close that never completes
          // cannot get the app killed.
          DispatchQueue.main.asyncAfter(deadline: .now() + 2) { grant.end() }
        }
      }
      guard id != .invalid else {
        // iOS refused: report the window as already over.
        onExpire()
        return grant
      }
      grant.set(id)
      return grant
    }

    private static func onMain<T: Sendable>(_ body: @MainActor () -> T) -> T {
      Thread.isMainThread
        ? MainActor.assumeIsolated(body)
        : DispatchQueue.main.sync { MainActor.assumeIsolated(body) }
    }

    private final class Grant: AppductDisposable, @unchecked Sendable {
      private let lock = NSLock()
      private var id: UIBackgroundTaskIdentifier = .invalid
      private var ended = false

      func set(_ newId: UIBackgroundTaskIdentifier) {
        lock.lock()
        let alreadyEnded = ended
        if !alreadyEnded { id = newId }
        lock.unlock()
        if alreadyEnded { UIKitAppductBackgroundTime.onMain { UIApplication.shared.endBackgroundTask(newId) } }
      }

      func end() { dispose() }

      func dispose() {
        lock.lock()
        let taken = id
        id = .invalid
        ended = true
        lock.unlock()
        guard taken != .invalid else { return }
        UIKitAppductBackgroundTime.onMain { UIApplication.shared.endBackgroundTask(taken) }
      }
    }
  }
#endif

/// Grants nothing and never expires; used when the platform has no background-time API.
public struct NoBackgroundTime: AppductBackgroundTime {
  public init() {}
  public func begin(onExpire: @escaping @Sendable () -> Void) -> any AppductDisposable { NoopDisposable() }
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
