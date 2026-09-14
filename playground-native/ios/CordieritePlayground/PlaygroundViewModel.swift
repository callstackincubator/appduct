import CordieriteCore
import Foundation

/// The playground's one piece of shared, observable state: the call counter every counted tool
/// bumps, the connection/session snapshot `Cordierite.addListener` feeds, and a short rolling log
/// shown on screen. `@MainActor`-isolated so `ContentView` can bind to it directly with `@Published`
/// properties; tool handlers (which run off the main actor, per
/// `packages/native/ios/README.md#threading`) reach it with a plain `await`, the same as any other
/// actor-isolated call.
@MainActor
final class PlaygroundViewModel: ObservableObject {
  static let shared = PlaygroundViewModel()

  @Published private(set) var callCount = 0
  @Published private(set) var state: ClientState = .idle
  @Published private(set) var sessionId: String?
  @Published private(set) var log: [String] = []

  private var subscription: Subscription?
  private let maxLogLines = 6

  private init() {}

  /// Called once from `CordieritePlaygroundApp.init()`. Snapshots the facade's current state
  /// immediately (in case a session is already active by the time this view model is created --
  /// e.g. after `restoreSession()` won a race with app launch), then subscribes for future changes.
  func start() {
    state = Cordierite.shared.state
    sessionId = Cordierite.shared.sessionId

    subscription = Cordierite.shared.addListener { [weak self] event in
      Task { @MainActor in
        self?.apply(event)
      }
    }
  }

  private func apply(_ event: CordieriteEvent) {
    switch event {
    case .stateChange(let change):
      state = change.state
      appendLog("state -> \(change.state.rawValue)" + (change.reason.map { " (\($0))" } ?? ""))
    case .sessionChange(let change):
      sessionId = change.sessionId
      appendLog(
        change.sessionId != nil
          ? "session -> \(change.sessionId ?? "") as \(change.alias ?? "?")"
          : "session -> none"
      )
    case .error(let error):
      appendLog("error [\(error.phase)]: \(error.message)")
    }
  }

  /// Bumped by `sum`/`slow_task`; `call_count` reads it back, `reset_counter` zeroes it -- mirrors
  /// `playground/app/(tabs)/index.tsx`'s counter tools exactly.
  @discardableResult
  func bumpCallCount() -> Int {
    callCount += 1
    return callCount
  }

  func resetCallCount() {
    callCount = 0
  }

  func appendLog(_ line: String) {
    log.insert(line, at: 0)
    if log.count > maxLogLines {
      log.removeLast(log.count - maxLogLines)
    }
  }
}
