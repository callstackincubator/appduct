import AppductCore
import Foundation

/// The playground's one piece of shared, observable state: the call counter every counted tool
/// bumps, the connection/session snapshot `Appduct.addListener` feeds, and a short rolling log
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
  /// The current session's alias, `nil` while there is none.
  @Published private(set) var alias: String?
  /// `<type>` or `<type> (<reason>)` of the last session change, `nil` before the first.
  @Published private(set) var lastSessionEvent: String?
  /// The `at` of the last `playground_ping` this app sent.
  @Published private(set) var lastPing: Int?
  @Published var screen: Screen = .tools
  @Published private(set) var log: [String] = []

  enum Screen {
    case tools
    case status
  }

  private var subscription: Subscription?
  private let maxLogLines = 6

  private init() {}

  /// Called once from `AppductPlaygroundApp.init()`, so the alias of a session claimed before the
  /// Status screen is ever shown is not missed. Snapshots the facade's current state immediately
  /// (in case a session is already active by the time this view model is created -- e.g. after
  /// `restoreSession()` won a race with app launch), then subscribes for future changes.
  func start() {
    guard subscription == nil else { return }
    state = Appduct.shared.state
    sessionId = Appduct.shared.sessionId

    subscription = Appduct.shared.addListener { [weak self] event in
      Task { @MainActor in
        self?.apply(event)
      }
    }
  }

  private func apply(_ event: AppductEvent) {
    switch event {
    case .stateChange(let change):
      state = change.state
      appendLog("state -> \(change.state.rawValue)" + (change.reason.map { " (\($0))" } ?? ""))
    case .sessionChange(let change):
      sessionId = change.sessionId
      alias = change.type == .lost ? nil : change.alias
      lastSessionEvent = change.type.rawValue + (change.reason.map { " (\($0))" } ?? "")
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

  func recordPing(at: Int) {
    lastPing = at
  }

  func appendLog(_ line: String) {
    log.insert(line, at: 0)
    if log.count > maxLogLines {
      log.removeLast(log.count - maxLogLines)
    }
  }
}
