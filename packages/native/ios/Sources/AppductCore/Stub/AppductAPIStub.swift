#if !APPDUCT_ENABLED

import Foundation

// Not vendored into @appduct/react-native (see `AppductCoreStub.swift`'s header comment for
// why): this file exists purely so `AppductCore` compiles, with the exact same public API as
// `Real/AppductAPI.swift`, in a configuration that does not define `APPDUCT_ENABLED` -- a
// Release build of a native (issue #48 phase-3) app that links `AppductCore` without the
// `AlwaysEnabled` trait. Every method matches the real facade's signature and does nothing (or
// resolves the documented inert value), mirroring `Stub/AppductClientStub.swift`'s own choices:
// `state` reports the facade's own documented-absent value (`.closed`, not `.idle` -- see
// `Appduct.state`'s doc comment below for why this one differs), `sessionId` is always `nil`,
// `handle(_:)` always returns `false`, and `register` returns an inert `ToolRegistration` whose
// `remove()` does nothing.

/// No-op mirror of the real `Appduct` facade. See `Real/AppductAPI.swift` for the documented
/// behavior every method below stands in for.
public final class Appduct: Sendable {
  public static let shared = Appduct()

  private init() {}

  @discardableResult
  public func register(
    name: String,
    description: String,
    inputSchema: [String: Any]? = nil,
    outputSchema: [String: Any]? = nil,
    annotations: ToolAnnotations? = nil,
    timeoutMs: Int? = nil,
    group: String? = nil,
    handler: @escaping @Sendable ([String: Any], ToolCallContext) async throws -> Any?
  ) throws -> ToolRegistration {
    ToolRegistration {}
  }

  @discardableResult
  public func register(
    name: String,
    description: String,
    inputSchema: [String: Any]? = nil,
    outputSchema: [String: Any]? = nil,
    annotations: ToolAnnotations? = nil,
    timeoutMs: Int? = nil,
    group: String? = nil,
    handler: @escaping @Sendable ([String: Any]) async throws -> Any?
  ) throws -> ToolRegistration {
    ToolRegistration {}
  }

  public func handle(_ url: URL) -> Bool { false }

  public func postEvent(_ name: String, payload: Any? = nil) async throws {}

  /// Deliberately `.closed`, not the raw `AppductClient` stub's `.idle`: a stub build never has
  /// -- and never will have -- a session, and `.closed` is the state the real facade settles into
  /// once a session is definitely gone, so a caller that only branches on "is anything connected"
  /// gets the answer that generalizes correctly, whereas `.idle` could misleadingly suggest "not
  /// tried yet, but could still connect".
  public var state: ClientState { .closed }
  public var sessionId: String? { nil }

  /// `trust: "excluded"` -- no real trust resolution ever produces this value, so a caller can tell
  /// a stub build's config apart from a real one's at a glance, matching
  /// `Stub/AppductCoreStub.swift`'s `currentAppductBuildConfig()`.
  public var buildConfig: BuildConfig {
    BuildConfig(trust: "excluded", hasEmbeddedPins: false, allowPrivateLanOnly: true)
  }

  @discardableResult
  public func addListener(_ listener: @escaping @Sendable (AppductEvent) -> Void) -> Subscription {
    Subscription()
  }

  @discardableResult
  public func restoreSession() async -> Bool { false }

  public func disconnect() async {}
}

public typealias ClientState = AppductClientState

public struct BuildConfig: Sendable, Equatable {
  public let trust: String
  public let hasEmbeddedPins: Bool
  public let allowPrivateLanOnly: Bool
}

public enum AppductEvent: Sendable {
  case stateChange(AppductStateChangeEvent)
  case sessionChange(AppductSessionChangeEvent)
  case error(AppductUnifiedErrorEvent)
}

public struct ToolRegistration: Sendable {
  private let unregister: @Sendable () -> Void

  init(_ unregister: @escaping @Sendable () -> Void) {
    self.unregister = unregister
  }

  public func remove() {
    unregister()
  }
}

public struct Subscription: Sendable {
  init() {}
  public func cancel() {}
}

#endif
