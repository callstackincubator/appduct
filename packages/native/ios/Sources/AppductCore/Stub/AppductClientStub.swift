#if !APPDUCT_ENABLED

import Foundation

// Not vendored into @appduct/react-native (see `AppductCoreStub.swift`'s header comment for
// why): this file exists purely so `AppductCore` compiles, with the same public API, in a
// configuration that does not define `APPDUCT_ENABLED` -- the exact declarations issue #48
// phase-3 native-app code (and, in principle, a future bridge) would call against the real
// `AppductClient`, all no-ops here.

// MARK: JSON currency type (mirrors Real/AppductJSON.swift's public surface)

public enum JSONValue: Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])
}

public typealias JSONObject = [String: JSONValue]

// MARK: Tool descriptor (mirrors Real/AppductToolDescriptor.swift's public surface)

public struct ToolAnnotations: Sendable, Equatable {
  public var readOnlyHint: Bool?
  public var destructiveHint: Bool?
  public var idempotentHint: Bool?
  public init(readOnlyHint: Bool? = nil, destructiveHint: Bool? = nil, idempotentHint: Bool? = nil) {
    self.readOnlyHint = readOnlyHint
    self.destructiveHint = destructiveHint
    self.idempotentHint = idempotentHint
  }
}

public struct ToolDescriptor: Sendable, Equatable {
  public var name: String
  public var description: String
  public var inputSchema: JSONObject?
  public var outputSchema: JSONObject?
  public var annotations: ToolAnnotations?
  public var timeoutMs: Int?

  public init(
    name: String,
    description: String,
    inputSchema: JSONObject? = nil,
    outputSchema: JSONObject? = nil,
    annotations: ToolAnnotations? = nil,
    timeoutMs: Int? = nil
  ) {
    self.name = name
    self.description = description
    self.inputSchema = inputSchema
    self.outputSchema = outputSchema
    self.annotations = annotations
    self.timeoutMs = timeoutMs
  }
}

// MARK: Tool invocation

public struct ToolCallContext: Sendable {
  public let callId: String
  public let toolName: String
  public let sessionId: String
  public init(callId: String, toolName: String, sessionId: String) {
    self.callId = callId
    self.toolName = toolName
    self.sessionId = sessionId
  }
  public func reportProgress(progress: Double? = nil, message: String? = nil) async {}
  public func cancelReason() async -> String? { nil }
}

public typealias ToolHandler = @Sendable (JSONObject, ToolCallContext) async throws -> JSONValue

// MARK: Unified client state

public enum AppductClientState: String, Sendable, Equatable {
  case idle
  case connecting
  case active
  case reconnecting
  case closed
}

public struct AppductStateChangeEvent: Sendable, Equatable {
  public let state: AppductClientState
  public let reason: String?
}

public struct AppductSessionChangeEvent: Sendable, Equatable {
  public let sessionId: String?
  public let alias: String?
}

public struct AppductUnifiedErrorEvent: Sendable, Equatable {
  public let phase: String
  public let message: String
  public let code: String?
  public let nativeCode: String?
  public let closeReason: String?
  public let isRetryable: Bool?
  public let hint: String?
  public let toolName: String?
  public let invocationId: String?
}

public struct AppductConnectInput: Sendable, Equatable {
  public var ip: String
  public var port: Int
  public var sessionId: String
  public var token: String?
  public var resumeToken: String?
  public var expiresAt: Int
  public var linkPin: String?
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

public protocol AppductDisposable: Sendable {
  func dispose()
}

public struct NoopDisposable: AppductDisposable {
  public init() {}
  public func dispose() {}
}

/// No-op mirror of the real `AppductClient`: every method matches the real actor's public
/// signature and does nothing (or resolves the documented inert value). `getState()` always reports
/// `"idle"`, `registeredTools` is always empty -- the same choices `AppductConnectionManager`'s
/// stub and the JS `/noop` entry make, for the same reason (a stub build never attempts a session).
public actor AppductClient {
  public init() {}

  public nonisolated func registerTool(_ descriptor: ToolDescriptor, handler: @escaping ToolHandler) throws {}
  public nonisolated func unregisterTool(_ name: String) {}
  public nonisolated var registeredTools: [ToolDescriptor] { [] }

  public nonisolated func handleUrl(_ url: String) -> Bool { false }
  public func connect(_ input: AppductConnectInput, supersede: Bool = false) async throws {}
  public func restoreSession() async -> Bool { false }
  public func disconnect() async {}
  public func postEvent(_ name: String, payload: JSONValue? = nil) async throws {}

  public var state: AppductClientState { .idle }
  public var sessionId: String? { nil }

  @discardableResult
  public func onStateChange(_ callback: @escaping @Sendable (AppductStateChangeEvent) -> Void) -> any AppductDisposable {
    NoopDisposable()
  }

  @discardableResult
  public func onSessionChange(_ callback: @escaping @Sendable (AppductSessionChangeEvent) -> Void) -> any AppductDisposable {
    NoopDisposable()
  }

  @discardableResult
  public func onError(_ callback: @escaping @Sendable (AppductUnifiedErrorEvent) -> Void) -> any AppductDisposable {
    NoopDisposable()
  }

  public nonisolated func currentStateSnapshot() -> String { AppductClientState.idle.rawValue }
  public nonisolated func currentSessionIdSnapshot() -> String? { nil }
  public nonisolated func currentRegisteredToolsSnapshot() -> [ToolDescriptor] { [] }
  public func reportToolProgress(callId: String, progress: Double?, message: String?) async {}
  public func destroy() async {}
}

#endif
