import Foundation

/// Bridges the phase-2 TurboModule spec (`NativeCordierite.ts`, `docs/tasks/15-native-session-logic.md`)
/// to Objective-C++ (`RCTNativeCordierite`). Every structured value crosses as a JSON string; the
/// core (`CordieriteClient`) owns session lifecycle, the tool registry, and per-call timeout/cancel/
/// progress. This file's only job is translation: JS tool calls become `onToolCall` events answered
/// by `respondToToolCall`, via a continuation-per-call (`PendingToolCallStore`).
///
/// `@unchecked Sendable`: `client` is an actor reference (`Sendable` by construction); the emitter
/// closures and `pendingToolCalls` below are written once at init/wireEventHandlers time and are
/// themselves thread-safe, so capturing `self` in the `Task {}` blocks throughout is sound.
@objc(CordieriteTurboBridge)
public final class CordieriteTurboBridge: NSObject, @unchecked Sendable {
  private let client = CordieriteClient()
  private let pendingToolCalls = PendingToolCallStore()

  /// Set once by `wireEventHandlers`, read by every per-tool handler installed afterwards.
  private var toolCallEmitter: (@Sendable (NSString, NSString, NSString) -> Void)?
  private var toolCancelEmitter: (@Sendable (NSString, NSString) -> Void)?

  @objc public override init() {
    super.init()
  }

  @objc public func wireEventHandlers(
    toolCall: @escaping @Sendable (NSString, NSString, NSString) -> Void,
    toolCancel: @escaping @Sendable (NSString, NSString) -> Void,
    stateChange: @escaping @Sendable (NSString, NSString?) -> Void,
    sessionChange: @escaping @Sendable (NSString?, NSString?) -> Void,
    error: @escaping @Sendable (NSDictionary) -> Void
  ) {
    toolCallEmitter = toolCall
    toolCancelEmitter = toolCancel

    Task {
      _ = await self.client.onStateChange { event in
        stateChange(event.state.rawValue as NSString, event.reason as NSString?)
      }
      _ = await self.client.onSessionChange { event in
        sessionChange(event.sessionId as NSString?, event.alias as NSString?)
      }
      _ = await self.client.onError { event in
        error(CordieriteTurboBridge.errorPayload(event))
      }
    }
  }

  private static func errorPayload(_ event: CordieriteUnifiedErrorEvent) -> NSDictionary {
    let payload = NSMutableDictionary()
    payload["phase"] = event.phase as NSString
    payload["message"] = event.message as NSString
    if let code = event.code { payload["code"] = code as NSString }
    if let nativeCode = event.nativeCode { payload["nativeCode"] = nativeCode as NSString }
    if let closeReason = event.closeReason { payload["closeReason"] = closeReason as NSString }
    if let isRetryable = event.isRetryable { payload["isRetryable"] = NSNumber(value: isRetryable) }
    if let hint = event.hint { payload["hint"] = hint as NSString }
    if let toolName = event.toolName { payload["toolName"] = toolName as NSString }
    if let invocationId = event.invocationId { payload["invocationId"] = invocationId as NSString }
    return payload
  }

  // MARK: registerTool / unregisterTool (sync, throwing -- no Promise in the frozen spec)

  @objc public func registerTool(descriptorJson: NSString) throws {
    let value = try JSONValue.parse(descriptorJson as String)
    let descriptor = try parseToolDescriptor(value)

    try client.registerTool(descriptor, handler: makeBridgeHandler())
  }

  @objc public func unregisterTool(name: NSString) {
    client.unregisterTool(name as String)
  }

  /// The handler every JS-registered tool runs: emit `onToolCall`, then await the JS answer
  /// delivered through `respondToToolCall`. Cancellation (explicit `tool_cancel`, a core timeout, or
  /// session suspension) surfaces to JS as `onToolCancel` before the underlying
  /// `CancellationError` propagates back into the core's own timeout/cancel bookkeeping.
  private func makeBridgeHandler() -> ToolHandler {
    { [weak self] args, context in
      guard let self else {
        throw CordieriteToolHandlerError(type: "tool_execution_error", message: "Cordierite bridge was deallocated.")
      }

      let argsJson = try JSONValue.object(args).serialized()
      self.toolCallEmitter?(context.callId as NSString, context.toolName as NSString, argsJson as NSString)

      do {
        return try await self.pendingToolCalls.awaitAnswer(id: context.callId)
      } catch is CancellationError {
        let reason = await context.cancelReason() ?? "client_cancelled"
        self.toolCancelEmitter?(context.callId as NSString, reason as NSString)
        throw CancellationError()
      }
    }
  }

  // MARK: respondToToolCall / reportToolProgress (sync, fire-and-forget)

  @objc public func respondToToolCall(id: NSString, resultJson: NSString?, errorJson: NSString?) {
    let callId = id as String

    if let errorJson {
      guard
        let value = try? JSONValue.parse(errorJson as String),
        let object = value.objectValue,
        let type = object["type"]?.stringValue,
        let message = object["message"]?.stringValue
      else {
        pendingToolCalls.reject(
          id: callId,
          error: CordieriteToolHandlerError(type: "tool_execution_error", message: "Malformed tool_error from JS.")
        )
        return
      }
      pendingToolCalls.reject(id: callId, error: CordieriteToolHandlerError(type: type, message: message, details: object["details"]))
      return
    }

    let resultValue: JSONValue
    do {
      resultValue = try (resultJson.map { try JSONValue.parse($0 as String) }) ?? .null
    } catch {
      pendingToolCalls.reject(
        id: callId,
        error: CordieriteToolHandlerError(type: "tool_serialization_error", message: "Malformed tool_result JSON from JS.")
      )
      return
    }
    pendingToolCalls.resolve(id: callId, result: resultValue)
  }

  @objc public func reportToolProgress(id: NSString, progress: NSNumber?, message: NSString?) {
    let callId = id as String
    let progressValue = progress?.doubleValue
    let messageValue = message as String?
    Task {
      await self.client.reportToolProgress(callId: callId, progress: progressValue, message: messageValue)
    }
  }

  // MARK: handleUrl (sync, boolean return)

  @objc public func handleUrl(_ url: NSString) -> Bool {
    client.handleUrl(url as String)
  }

  // MARK: connect / restoreSession / disconnect / postEvent (Promise-returning)

  @objc public func connect(
    inputJson: NSString,
    supersede: Bool,
    resolve: @escaping @Sendable (Any?) -> Void,
    reject: @escaping @Sendable (String, String, Error?) -> Void
  ) {
    Task {
      do {
        let value = try JSONValue.parse(inputJson as String)
        let input = try parseCordieriteConnectInput(value)
        try await self.client.connect(input, supersede: supersede)
        resolve(nil)
      } catch {
        reject("E_CORDIERITE", CordieriteTurboBridge.describe(error), error)
      }
    }
  }

  @objc public func restoreSession(
    resolve: @escaping @Sendable (Any?) -> Void,
    reject: @escaping @Sendable (String, String, Error?) -> Void
  ) {
    Task {
      let started = await self.client.restoreSession()
      resolve(NSNumber(value: started))
    }
  }

  @objc public func disconnect(
    resolve: @escaping @Sendable (Any?) -> Void,
    reject: @escaping @Sendable (String, String, Error?) -> Void
  ) {
    Task {
      await self.client.disconnect()
      resolve(nil)
    }
  }

  @objc public func postEvent(
    name: NSString,
    payloadJson: NSString?,
    resolve: @escaping @Sendable (Any?) -> Void,
    reject: @escaping @Sendable (String, String, Error?) -> Void
  ) {
    Task {
      do {
        let payload = try payloadJson.map { try JSONValue.parse($0 as String) }
        try await self.client.postEvent(name as String, payload: payload)
        resolve(nil)
      } catch {
        reject("E_CORDIERITE", CordieriteTurboBridge.describe(error), error)
      }
    }
  }

  private static func describe(_ error: Error) -> String {
    if let handlerError = error as? CordieriteToolHandlerError { return handlerError.message }
    if let jsonError = error as? CordieriteJSONError { return jsonError.message }
    return "\(error)"
  }

  // MARK: Synchronous getters

  @objc public func getState() -> NSString {
    client.currentStateSnapshot() as NSString
  }

  @objc public func getSessionId() -> NSString? {
    client.currentSessionIdSnapshot() as NSString?
  }

  @objc public func getRegisteredToolsJson() -> NSString {
    let tools = client.currentRegisteredToolsSnapshot()
    let json = JSONValue.array(tools.map { $0.wireValue })
    return ((try? json.serialized()) ?? "[]") as NSString
  }

  /// Purely a `Bundle.main` read (`currentCordieriteBuildConfig()`), so no actor hop is needed.
  @objc public func getConstants() -> NSDictionary {
    let config = currentCordieriteBuildConfig()
    return [
      "trust": config.trust,
      "hasEmbeddedPins": config.hasEmbeddedPins,
      "allowPrivateLanOnly": config.allowPrivateLanOnly,
    ]
  }

  // MARK: TurboModule invalidation

  /// Called by React Native when the bridge is torn down (e.g. a Metro reload). Tears down the
  /// client (cancels in-flight calls, invalidates the transport) asynchronously, the same
  /// deliberately-not-blocking tradeoff `CordieriteConnectionManager.invalidate()` documents.
  @objc public func invalidate() {
    Task {
      await self.client.destroy()
    }
  }
}

/// Answers each in-flight JS-backed tool call exactly once, keyed by call id. Not actor-isolated:
/// `respondToToolCall` is a synchronous, fire-and-forget TurboModule method, so completing the
/// waiting continuation must not require an actor hop. `@unchecked Sendable` is justified by the
/// single `NSLock` guarding all mutable state.
final class PendingToolCallStore: @unchecked Sendable {
  private let lock = NSLock()
  private var continuations: [String: CheckedContinuation<JSONValue, Error>] = [:]

  /// Suspends until `resolve`/`reject` is called for `id`, or the enclosing `Task` is cancelled (in
  /// which case this throws `CancellationError` -- `withCheckedContinuation`, unlike the checked
  /// *throwing* continuation alone, would otherwise never observe cancellation).
  func awaitAnswer(id: String) async throws -> JSONValue {
    try await withTaskCancellationHandler(
      operation: {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<JSONValue, Error>) in
          lock.lock()
          continuations[id] = continuation
          lock.unlock()
          // `onCancel` fires immediately when the task is *already* cancelled on entry -- i.e. before
          // this continuation existed to be resumed -- so re-check here, or a cancel that races the
          // registration would leave the call suspended forever.
          if Task.isCancelled {
            complete(id: id) { $0.resume(throwing: CancellationError()) }
          }
        }
      },
      onCancel: { [self] in
        complete(id: id) { $0.resume(throwing: CancellationError()) }
      }
    )
  }

  func resolve(id: String, result: JSONValue) {
    complete(id: id) { $0.resume(returning: result) }
  }

  func reject(id: String, error: CordieriteToolHandlerError) {
    complete(id: id) { $0.resume(throwing: error) }
  }

  /// A no-op for an unknown or already-finished id (per the TurboModule spec's `respondToToolCall`
  /// doc comment), and for a cancellation that lands after JS already answered.
  private func complete(id: String, _ body: (CheckedContinuation<JSONValue, Error>) -> Void) {
    lock.lock()
    let continuation = continuations.removeValue(forKey: id)
    lock.unlock()
    guard let continuation else { return }
    body(continuation)
  }
}
