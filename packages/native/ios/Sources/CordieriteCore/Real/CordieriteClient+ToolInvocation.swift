// Vendored into @cordierite/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if CORDIERITE_ENABLED

import Foundation

/// Per-call dispatch: timeout, cancellation, progress, and the seven `tool_error` types. Ports
/// `client/tool-invocation.ts`. Cancellation uses Swift's own cooperative `Task` cancellation
/// instead of a bespoke `AbortSignal` (see `ToolCallContext`'s doc comment).
extension CordieriteClient {
  func dispatchIncomingToolMessage(_ object: JSONObject) async {
    guard let sessionId = heldSession?.sessionId else { return }

    switch object["type"]?.stringValue {
    case "tool_cancel":
      guard let id = object["id"]?.stringValue, let call = inFlightCalls[id] else { return }
      call.cancelled = true
      call.cancelReason = object["reason"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "client_cancelled"
      call.task.cancel()

    case "tool_call":
      guard
        let id = object["id"]?.stringValue,
        let name = object["name"]?.stringValue,
        let argsValue = object["args"],
        let args = argsValue.objectValue
      else {
        return
      }
      await handleToolCall(id: id, name: name, args: args, sessionId: sessionId)

    default:
      break
    }
  }

  private func handleToolCall(id: String, name: String, args: JSONObject, sessionId: String) async {
    guard let tool = registryStore.lookup(name) else {
      await sendToolError(
        id: id,
        sessionId: sessionId,
        type: "tool_not_found",
        message: "Tool \"\(name)\" is not registered in the app."
      )
      return
    }

    let task = Task { [self] in
      await self.executeToolCall(id: id, name: name, args: args, sessionId: sessionId, tool: tool)
    }
    inFlightCalls[id] = InFlightToolCall(task: task)
  }

  private func executeToolCall(
    id: String,
    name: String,
    args: JSONObject,
    sessionId: String,
    tool: CordieriteRegisteredTool
  ) async {
    defer { inFlightCalls.removeValue(forKey: id) }

    let timeoutHandle = timers.setTimeout(afterMs: Double(tool.timeoutMs)) { [weak self] in
      Task { await self?.handleToolTimeout(id: id, name: name, sessionId: sessionId, timeoutMs: tool.timeoutMs) }
    }

    let context = ToolCallContext(
      callId: id,
      toolName: name,
      sessionId: sessionId,
      onProgress: { [weak self] progress, message in
        await self?.sendToolCallProgress(id: id, sessionId: sessionId, progress: progress, message: message)
      },
      cancelReasonProvider: { [weak self] in
        await self?.inFlightCallCancelReason(id: id)
      }
    )

    let outcome: Result<JSONValue, Error>
    do {
      outcome = .success(try await tool.handler(args, context))
    } catch {
      outcome = .failure(error)
    }

    timers.clearTimeout(timeoutHandle)

    // If the call already finished (removed from `inFlightCalls`), a timeout already answered it
    // and this is a late result/throw -- ignore it, matching the JS client's dev-warning-and-drop.
    guard let call = inFlightCalls[id] else { return }

    if call.timedOut {
      return
    }

    switch outcome {
    case .success(let value):
      await respondSuccess(id: id, sessionId: sessionId, name: name, value: value)
    case .failure(let error):
      if call.cancelled {
        await sendToolError(id: id, sessionId: sessionId, type: "tool_cancelled", message: "Tool \"\(name)\" was cancelled.")
        return
      }
      await respondFailure(id: id, sessionId: sessionId, name: name, error: error)
    }
  }

  private func respondSuccess(id: String, sessionId: String, name: String, value: JSONValue) async {
    do {
      _ = try value.serialized()
    } catch {
      await sendToolError(
        id: id,
        sessionId: sessionId,
        type: "tool_serialization_error",
        message: "Cordierite tool result is not JSON-serializable."
      )
      return
    }

    do {
      try await sendWire(
        .object([
          "type": .string("tool_result"),
          "session_id": .string(sessionId),
          "id": .string(id),
          "result": value,
        ])
      )
    } catch {
      emitError(
        CordieriteUnifiedErrorEvent(phase: "tool", message: "Failed to send a tool response frame.")
      )
    }
  }

  private func respondFailure(id: String, sessionId: String, name: String, error: Error) async {
    if let typed = error as? CordieriteToolHandlerError {
      await sendToolError(id: id, sessionId: sessionId, type: typed.type, message: typed.message, details: typed.details)
      emitError(
        CordieriteUnifiedErrorEvent(
          phase: "tool",
          message: "Tool \"\(name)\" handler threw.",
          toolName: name,
          invocationId: id
        )
      )
      return
    }

    let message: String
    if let localized = error as? LocalizedError, let description = localized.errorDescription {
      message = description
    } else {
      message = String(describing: error)
    }
    await sendToolError(id: id, sessionId: sessionId, type: "tool_execution_error", message: message)
    emitError(
      CordieriteUnifiedErrorEvent(
        phase: "tool",
        message: "Tool \"\(name)\" handler threw.",
        toolName: name,
        invocationId: id
      )
    )
  }

  private func handleToolTimeout(id: String, name: String, sessionId: String, timeoutMs: Int) async {
    guard let call = inFlightCalls[id], !call.timedOut else { return }
    call.timedOut = true
    call.cancelReason = "timeout"
    call.task.cancel()
    await sendToolError(
      id: id,
      sessionId: sessionId,
      type: "tool_timeout",
      message: "Tool \"\(name)\" did not respond within \(timeoutMs)ms."
    )
  }

  /// Fire-and-forget progress report; routed here from either `ToolCallContext.reportProgress`
  /// (native handlers) or the bridge's `reportToolProgress` TurboModule method (JS handlers).
  func sendToolCallProgress(id: String, sessionId: String, progress: Double?, message: String?) async {
    var object: JSONObject = ["type": .string("tool_call_progress"), "session_id": .string(sessionId), "id": .string(id)]
    if let progress { object["progress"] = .number(progress) }
    if let message { object["message"] = .string(message) }
    do {
      try await sendWire(.object(object))
    } catch {
      emitError(CordieriteUnifiedErrorEvent(phase: "tool", message: "Failed to send a tool response frame."))
    }
  }

  private func sendToolError(
    id: String,
    sessionId: String,
    type: String,
    message: String,
    details: JSONValue? = nil
  ) async {
    var errorObject: JSONObject = ["type": .string(type), "message": .string(message)]
    if let details { errorObject["details"] = details }

    do {
      try await sendWire(
        .object([
          "type": .string("tool_error"),
          "session_id": .string(sessionId),
          "id": .string(id),
          "error": .object(errorObject),
        ])
      )
    } catch {
      emitError(CordieriteUnifiedErrorEvent(phase: "tool", message: "Failed to send a tool response frame."))
    }
  }

  /// Aborts every in-flight handler's task without waiting for a `tool_cancel` frame -- used when
  /// the transport itself is gone (session suspended), so nothing could deliver one.
  func abortAllInFlight() {
    for call in inFlightCalls.values {
      call.cancelled = true
      call.cancelReason = call.cancelReason ?? "session_suspended"
      call.task.cancel()
    }
  }

  /// Backs `ToolCallContext.reportProgress` for native (non-bridge) handlers, and the bridge's
  /// `reportToolProgress` TurboModule method.
  public func reportToolProgress(callId: String, progress: Double?, message: String?) async {
    guard inFlightCalls[callId] != nil, let sessionId = heldSession?.sessionId else { return }
    await sendToolCallProgress(id: callId, sessionId: sessionId, progress: progress, message: message)
  }

  /// Backs `ToolCallContext.cancelReason()` and the RN bridge's `onToolCancel` event.
  func inFlightCallCancelReason(id: String) async -> String? {
    inFlightCalls[id]?.cancelReason
  }
}

#endif
