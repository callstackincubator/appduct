// Vendored into @appduct/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if APPDUCT_ENABLED

import Foundation
#if canImport(UIKit)
  import UIKit
#endif

// MARK: - Unified client state (ARCHITECTURE.md §11)

public enum AppductClientState: String, Sendable, Equatable {
  case idle
  case connecting
  case active
  case reconnecting
  case closed
}

public struct AppductStateChangeEvent: Sendable, Equatable {
  public let state: AppductClientState
  /// Set on transitions into `closed`/`reconnecting`: `revoked`, `grace_expired`, `closed_by_app`,
  /// `socket_error`, `connect_error`, `background`, `foreground`.
  public let reason: String?
  public init(state: AppductClientState, reason: String? = nil) {
    self.state = state
    self.reason = reason
  }
}

/// Matches `AppductSessionChangeEvent`/`AppductSessionChangeEventNative` (issue #48 review,
/// Decision 5 follow-up: restoring the `type`/`reason` the initial phase-2 port dropped).
/// `sessionId`/`alias` are both `nil` once the session is gone; `reason` is set only when `type`
/// is `.lost`.
public enum AppductSessionChangeKind: String, Sendable, Equatable {
  case claimed
  case resumed
  case lost
}

public struct AppductSessionChangeEvent: Sendable, Equatable {
  public let type: AppductSessionChangeKind
  public let sessionId: String?
  public let alias: String?
  public let reason: String?
  public init(type: AppductSessionChangeKind, sessionId: String?, alias: String?, reason: String? = nil) {
    self.type = type
    self.sessionId = sessionId
    self.alias = alias
    self.reason = reason
  }
}

// MARK: - Tool timeout bounds (packages/shared/src/domains/tool-descriptor.ts)
//
// Matches `DEFAULT_TOOL_TIMEOUT_MS`/`MIN_TOOL_TIMEOUT_MS`/`MAX_TOOL_TIMEOUT_MS` there exactly --
// `AppductToolRegistry.swift`'s `upsert` clamps every declared `timeout_ms` into this range
// before it is stored or sent on the wire, the same way the pre-port JS `normalizeToolTimeoutMs`
// did, so this app's own abort timer and the daemon's `tools.call` deadline never disagree.

/// The client-wide fallback timeout applied when a tool declares no `timeout_ms` of its own.
public let APPDUCT_DEFAULT_TOOL_TIMEOUT_MS = 10_000

public let APPDUCT_MIN_TOOL_TIMEOUT_MS = 1_000
public let APPDUCT_MAX_TOOL_TIMEOUT_MS = 600_000

/// Clamps an already-validated positive `timeout_ms` into
/// `[APPDUCT_MIN_TOOL_TIMEOUT_MS, APPDUCT_MAX_TOOL_TIMEOUT_MS]`.
public func clampAppductToolTimeoutMs(_ timeoutMs: Int) -> Int {
  min(max(timeoutMs, APPDUCT_MIN_TOOL_TIMEOUT_MS), APPDUCT_MAX_TOOL_TIMEOUT_MS)
}

/// One error channel for bootstrap parse/connect, socket, and tool-handler failures (§11).
public struct AppductUnifiedErrorEvent: Sendable, Equatable {
  public let phase: String  // "bootstrap" | "connect" | "socket" | "tool"
  public let message: String
  public let code: String?
  public let nativeCode: String?
  public let closeReason: String?
  public let isRetryable: Bool?
  public let hint: String?
  public let toolName: String?
  public let invocationId: String?

  public init(
    phase: String,
    message: String,
    code: String? = nil,
    nativeCode: String? = nil,
    closeReason: String? = nil,
    isRetryable: Bool? = nil,
    hint: String? = nil,
    toolName: String? = nil,
    invocationId: String? = nil
  ) {
    self.phase = phase
    self.message = message
    self.code = code
    self.nativeCode = nativeCode
    self.closeReason = closeReason
    self.isRetryable = isRetryable
    self.hint = hint
    self.toolName = toolName
    self.invocationId = invocationId
  }
}

// MARK: - Connect input

/// Mirrors `AppductConnectInput` (`Appduct.types.ts`): either explicit connect options or a
/// decoded v2 bootstrap payload, folded into one shape (`address` maps to `ip`, matching
/// `connect-helpers.ts`'s `toConnectOptions`).
public struct AppductConnectInput: Sendable, Equatable {
  public var ip: String
  public var port: Int
  public var sessionId: String
  public var token: String?
  public var resumeToken: String?
  public var expiresAt: Int
  public var linkPin: String?
  /// Optional `session_claim` device metadata overrides (mirrors the JS-level
  /// `AppductConnectOptions.deviceManufacturer`/`deviceModel`/`deviceOs`); native fills its own
  /// defaults when omitted.
  public var deviceManufacturer: String?
  public var deviceModel: String?
  public var deviceOs: String?

  public init(
    ip: String,
    port: Int,
    sessionId: String,
    token: String? = nil,
    resumeToken: String? = nil,
    expiresAt: Int,
    linkPin: String? = nil,
    deviceManufacturer: String? = nil,
    deviceModel: String? = nil,
    deviceOs: String? = nil
  ) {
    self.ip = ip
    self.port = port
    self.sessionId = sessionId
    self.token = token
    self.resumeToken = resumeToken
    self.expiresAt = expiresAt
    self.linkPin = linkPin
    self.deviceManufacturer = deviceManufacturer
    self.deviceModel = deviceModel
    self.deviceOs = deviceOs
  }
}

public struct AppductConnectInputError: Error, Sendable, CustomStringConvertible {
  public let message: String
  public init(_ message: String) { self.message = message }
  public var description: String { message }
}

/// Parses the bridge's `connect(inputJson:)` JSON payload. Duck-types the same way
/// `connect-helpers.ts`'s `toConnectOptions` does: an `address` key means a decoded bootstrap
/// payload (map to `ip`); otherwise an explicit `{ ip, port, sessionId, token, expiresAt }`.
public func parseAppductConnectInput(_ value: JSONValue) throws -> AppductConnectInput {
  guard case .object(let object) = value else {
    throw AppductConnectInputError("Appduct connect input must be a JSON object.")
  }

  let ip: String
  if let address = object["address"]?.stringValue {
    ip = address
  } else if let explicitIp = object["ip"]?.stringValue {
    ip = explicitIp
  } else {
    throw AppductConnectInputError("Appduct connect input is missing \"ip\"/\"address\".")
  }

  guard let portValue = object["port"]?.doubleValue else {
    throw AppductConnectInputError("Appduct connect input is missing a valid \"port\".")
  }
  guard let sessionId = object["sessionId"]?.stringValue, !sessionId.isEmpty else {
    throw AppductConnectInputError("Appduct connect input is missing a valid \"sessionId\".")
  }
  guard let expiresAtValue = object["expiresAt"]?.doubleValue else {
    throw AppductConnectInputError("Appduct connect input is missing a valid \"expiresAt\".")
  }

  return AppductConnectInput(
    ip: ip,
    port: Int(portValue),
    sessionId: sessionId,
    token: object["token"]?.stringValue,
    resumeToken: object["resumeToken"]?.stringValue,
    expiresAt: Int(expiresAtValue),
    linkPin: object["linkPin"]?.stringValue,
    deviceManufacturer: object["deviceManufacturer"]?.stringValue,
    deviceModel: object["deviceModel"]?.stringValue,
    deviceOs: object["deviceOs"]?.stringValue
  )
}

/// Client-side sanity check before invoking the transport's `connect` (distinct from the structural
/// bootstrap-decode validation already performed for a link-derived input). Ports
/// `connect-helpers.ts`'s `isConnectOptionsValid`.
public func isAppductConnectInputValid(_ input: AppductConnectInput, now: Int) -> Bool {
  let hasClaimToken = (input.token?.isEmpty == false)
  let hasResumeToken = (input.resumeToken?.isEmpty == false)

  return !input.ip.isEmpty
    && input.port >= 1 && input.port <= 65_535
    && !input.sessionId.isEmpty
    && (hasClaimToken || hasResumeToken)
    && !isAppductExpired(expiresAt: input.expiresAt, now: now)
}

// MARK: - Transport seam

/// The small surface `AppductClient` needs from a live session transport -- satisfied by
/// `AppductConnectionManager` in production, and by a scripted fake in tests, so
/// `AppductClient`'s reconnect/registry/tool-invocation logic is testable without a real
/// TLS/WebSocket stack.
public protocol AppductTransportSession: AnyObject, Sendable {
  var emitStateChange: (@Sendable (String) -> Void)? { get set }
  var emitMessageRaw: (@Sendable (String) -> Void)? { get set }
  var emitError: (@Sendable (AppductErrorDetails) -> Void)? { get set }
  var emitClose: (@Sendable (NSDictionary) -> Void)? { get set }

  func connect(options: AppductConnectOptions) async throws
  func send(message: String) async throws
  func close() async
  func invalidate() async

  nonisolated func currentStateSnapshot() -> String
  nonisolated func currentResumeLeaseRecord() -> NSDictionary?
  @discardableResult
  nonisolated func clearResumeLease() -> Bool
}

// `invalidate()` on the actor itself is a synchronous, actor-isolated method; that alone satisfies
// the protocol's `async` requirement (any call to an actor-isolated method from outside the actor
// is already a suspension point), so no wrapper is needed here.
extension AppductConnectionManager: AppductTransportSession {}

// MARK: - Foreground/background observation

/// Structural seam mirroring the slice of `client/app-state.ts`'s `AppStateLike` the client needs,
/// backed by `UIApplication` notifications on Apple platforms (`#if canImport(UIKit)`) instead of
/// React Native's JS-level `AppState` -- see `docs/tasks/15-native-session-logic.md`.
public protocol AppductForegroundObserving: Sendable {
  /// `true` when the app is not in the foreground (background or inactive).
  func isBackgrounded() -> Bool
  /// Invoked on every transition; `background` is `true` entering background, `false` returning to
  /// foreground. Returns a disposable to stop observing.
  func onChange(_ handler: @escaping @Sendable (_ background: Bool) -> Void) -> any AppductDisposable
}

public protocol AppductDisposable: Sendable {
  func dispose()
}

#if canImport(UIKit)
  /// `UIApplication` notification-backed observer. `@unchecked Sendable`: `NotificationCenter`
  /// tokens and the `UIApplication.shared` reads all happen on the main thread/actor in practice;
  /// this type stores no other mutable state.
  public final class UIKitAppductForegroundObserver: AppductForegroundObserving, @unchecked Sendable {
    public init() {}

    public func isBackgrounded() -> Bool {
      var result = true
      let block = {
        result = UIApplication.shared.applicationState != .active
      }
      if Thread.isMainThread {
        block()
      } else {
        DispatchQueue.main.sync(execute: block)
      }
      return result
    }

    public func onChange(_ handler: @escaping @Sendable (Bool) -> Void) -> any AppductDisposable {
      let center = NotificationCenter.default
      let backgroundToken = center.addObserver(
        forName: UIApplication.didEnterBackgroundNotification,
        object: nil,
        queue: .main
      ) { _ in handler(true) }
      let foregroundToken = center.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { _ in handler(false) }
      return Disposable(tokens: [backgroundToken, foregroundToken])
    }

    private final class Disposable: AppductDisposable, @unchecked Sendable {
      private let tokens: [NSObjectProtocol]
      init(tokens: [NSObjectProtocol]) { self.tokens = tokens }
      func dispose() {
        let center = NotificationCenter.default
        for token in tokens { center.removeObserver(token) }
      }
    }
  }
#endif

/// Never backgrounds; used when no platform observer is available (tests, non-UIKit platforms).
public struct NeverBackgroundedObserver: AppductForegroundObserving {
  public init() {}
  public func isBackgrounded() -> Bool { false }
  public func onChange(_ handler: @escaping @Sendable (Bool) -> Void) -> any AppductDisposable {
    NoopDisposable()
  }
}

public struct NoopDisposable: AppductDisposable {
  public init() {}
  public func dispose() {}
}

// MARK: - Tool invocation

public typealias ToolHandler = @Sendable (JSONObject, ToolCallContext) async throws -> JSONValue

/// Passed to a `ToolHandler`. Cancellation is Swift's own cooperative `Task` cancellation: the
/// enclosing task is cancelled on a `tool_cancel` wire frame, a per-call timeout, or session
/// suspension, so a handler that wants to observe it calls `try Task.checkCancellation()` (or reads
/// `Task.isCancelled`) rather than a bespoke `AbortSignal` type.
public struct ToolCallContext: Sendable {
  public let callId: String
  public let toolName: String
  public let sessionId: String
  private let onProgress: @Sendable (Double?, String?) async -> Void
  private let cancelReasonProvider: @Sendable () async -> String?

  public init(
    callId: String,
    toolName: String,
    sessionId: String,
    onProgress: @escaping @Sendable (Double?, String?) async -> Void,
    cancelReasonProvider: @escaping @Sendable () async -> String? = { nil }
  ) {
    self.callId = callId
    self.toolName = toolName
    self.sessionId = sessionId
    self.onProgress = onProgress
    self.cancelReasonProvider = cancelReasonProvider
  }

  /// Reports incremental progress (`tool_call_progress`, PROTOCOL.md §7). Best-effort: send
  /// failures land on the unified `error` channel, never thrown back into the handler.
  public func reportProgress(progress: Double? = nil, message: String? = nil) async {
    await onProgress(progress, message)
  }

  /// Once cancellation has been requested (`Task.isCancelled`/`try Task.checkCancellation()`),
  /// the reason: `"client_cancelled"`/the wire `tool_cancel.reason`, `"timeout"`, or
  /// `"session_suspended"`. `nil` before cancellation or if this context did not come from a
  /// `AppductClient` (e.g. a unit test constructing one directly). The RN bridge surfaces this
  /// on its `onToolCancel` event so JS can abort the matching `AbortSignal`.
  public func cancelReason() async -> String? {
    await cancelReasonProvider()
  }
}

/// A typed tool error a handler may throw to control the exact wire `tool_error.error.type`
/// (PROTOCOL.md §4/§7) instead of falling back to a generic `tool_execution_error`. The RN bridge's
/// proxy handler throws this to relay a JS-side validation/serialization failure unchanged; a plain
/// native (Phase 3) handler may throw it too.
public struct AppductToolHandlerError: Error, Sendable {
  public let type: String
  public let message: String
  public let details: JSONValue?

  public init(type: String, message: String, details: JSONValue? = nil) {
    self.type = type
    self.message = message
    self.details = details
  }
}

#endif
