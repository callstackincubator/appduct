package com.callstackincubator.cordierite

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Thrown by a [CordieriteToolHandler] that already knows the exact PROTOCOL.md §4 `tool_error.error`
 * shape to report -- the Android bridge's `respondToToolCall(id, resultJson, errorJson)` throws this
 * instead of a plain exception so the JS-chosen `errorJson.type` reaches the wire verbatim, rather
 * than being classified generically as `tool_execution_error` like any other thrown error.
 */
internal class CordieriteToolReplyError(
    val errorType: String,
    override val message: String,
    val details: Any? = null,
) : Exception(message)

/**
 * Dispatches incoming `tool_call`/`tool_cancel` wire messages (PROTOCOL.md §4) against a
 * [CordieriteToolRegistry] and reports outcomes back over [sendWire]. One instance per
 * [CordieriteClient]; every call runs as a child of [scope] so [abortAllInFlight] (session
 * suspension -- nothing could ever deliver a `tool_cancel` frame once the socket is gone) can
 * cancel every in-flight handler at once without waiting on the wire.
 *
 * Cancellation is coroutine-native: [TimeoutCancellationException] (this invoker's own
 * `withTimeout`) is reported as `tool_timeout`; any other `CancellationException` (an explicit
 * `tool_cancel` frame, or [abortAllInFlight]) is reported as `tool_cancelled`. Per issue #48
 * decision 4 the native SDK does no app-side schema validation, so the only wire error types this
 * emits are `tool_not_found`, `tool_execution_error`, `tool_timeout`, `tool_cancelled`, and
 * `tool_serialization_error` -- `tool_input_validation_error`/`tool_output_validation_error` stay
 * JS-only, where Standard Schema validation lives.
 */
internal class CordieriteToolInvoker(
    private val scope: CoroutineScope,
    private val registry: CordieriteToolRegistry,
    private val getSessionId: () -> String?,
    private val sendWire: suspend (String) -> Unit,
    private val onError: (CordieriteUnifiedError) -> Unit,
    private val defaultTimeoutMs: Long,
) {
    private val inFlight = ConcurrentHashMap<String, Job>()

    private suspend fun sendSafely(json: JSONObject) {
        try {
            sendWire(json.toString())
        } catch (e: Throwable) {
            onError(CordieriteUnifiedError(phase = "tool", message = "Failed to send a tool response frame.", cause = e))
        }
    }

    private suspend fun sendToolError(
        sessionId: String,
        callId: String,
        type: String,
        message: String,
        details: Any? = null,
    ) {
        val error = JSONObject().put("type", type).put("message", message)
        if (details != null) error.put("details", details)
        sendSafely(
            JSONObject()
                .put("type", "tool_error")
                .put("session_id", sessionId)
                .put("id", callId)
                .put("error", error),
        )
    }

    fun handleToolCall(
        callId: String,
        name: String,
        args: JSONObject,
    ) {
        val sessionId = getSessionId() ?: return
        val entry = registry.get(name)

        if (entry == null) {
            scope.launch {
                sendToolError(sessionId, callId, "tool_not_found", "Tool \"$name\" is not registered in the app.")
            }
            return
        }

        val job =
            scope.launch {
                val context =
                    CordieriteToolCallContext(callId, name, sessionId) { progress, message ->
                        sendSafely(
                            JSONObject()
                                .put("type", "tool_call_progress")
                                .put("session_id", sessionId)
                                .put("id", callId)
                                .apply {
                                    if (progress != null) put("progress", progress)
                                    if (message != null) put("message", message)
                                },
                        )
                    }

                val timeoutMs = entry.descriptor.timeoutMs ?: defaultTimeoutMs

                try {
                    val result = withTimeout(timeoutMs) { entry.handler(args, context) }
                    val jsonResult =
                        try {
                            cordieriteToJsonValue(result)
                        } catch (e: IllegalArgumentException) {
                            sendToolError(
                                sessionId,
                                callId,
                                "tool_serialization_error",
                                "Cordierite tool result is not JSON-serializable.",
                            )
                            return@launch
                        }
                    sendSafely(
                        JSONObject()
                            .put("type", "tool_result")
                            .put("session_id", sessionId)
                            .put("id", callId)
                            .put("result", jsonResult),
                    )
                } catch (e: TimeoutCancellationException) {
                    sendToolError(sessionId, callId, "tool_timeout", "Tool \"$name\" did not respond within ${timeoutMs}ms.")
                } catch (e: CancellationException) {
                    sendToolError(sessionId, callId, "tool_cancelled", "Tool \"$name\" was cancelled.")
                } catch (e: CordieriteToolReplyError) {
                    // A caller (the Android bridge, on behalf of `respondToToolCall`) already knows
                    // the exact wire error shape to report -- use it verbatim instead of the generic
                    // `tool_execution_error` classification below.
                    sendToolError(sessionId, callId, e.errorType, e.message, e.details)
                } catch (e: Throwable) {
                    onError(
                        CordieriteUnifiedError(
                            phase = "tool",
                            message = "Tool \"$name\" handler threw.",
                            cause = e,
                            toolName = name,
                            invocationId = callId,
                        ),
                    )
                    sendToolError(sessionId, callId, "tool_execution_error", e.message ?: "Cordierite tool execution failed.")
                } finally {
                    inFlight.remove(callId)
                }
            }

        inFlight[callId] = job
    }

    /** An explicit `tool_cancel` frame (PROTOCOL.md §4). A cancel for an unknown or
     * already-finished `id` is a no-op. */
    fun handleToolCancel(callId: String) {
        inFlight[callId]?.cancel(CancellationException("client_cancelled"))
    }

    /** Aborts every in-flight handler without waiting for a `tool_cancel` frame -- used when the
     * transport itself is gone (session suspended), so nothing could ever deliver one. */
    fun abortAllInFlight() {
        for (job in inFlight.values) {
            job.cancel(CancellationException("session_suspended"))
        }
    }
}
