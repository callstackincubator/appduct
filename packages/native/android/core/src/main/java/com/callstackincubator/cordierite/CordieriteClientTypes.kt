package com.callstackincubator.cordierite

import org.json.JSONObject

/** Matches `CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS` in `Cordierite.types.ts`. */
internal const val CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS = 10_000L

/** Unified client state (ARCHITECTURE.md §11 / the JS `CordieriteClientState`). Distinct from the
 * raw transport-level state ([CordieriteConnectionManager]'s own idle/connecting/active/closed/error) --
 * this adds `reconnecting` for the resume/backoff loop that lives entirely in [CordieriteClient]. */
internal enum class CordieriteClientState {
    idle,
    connecting,
    active,
    reconnecting,
    closed,
}

/**
 * A tool descriptor per PROTOCOL.md §5. Schemas and annotations are raw JSON objects: per issue
 * #48 decision 4, the native SDK does no app-side schema validation (the daemon does none either).
 */
internal data class CordieriteToolDescriptor(
    val name: String,
    val description: String,
    val inputSchema: JSONObject? = null,
    val outputSchema: JSONObject? = null,
    val annotations: JSONObject? = null,
    val timeoutMs: Long? = null,
) {
    internal fun toWireJson(): JSONObject =
        JSONObject().apply {
            put("name", name)
            put("description", description)
            if (inputSchema != null) put("input_schema", inputSchema)
            if (outputSchema != null) put("output_schema", outputSchema)
            if (annotations != null) put("annotations", annotations)
            if (timeoutMs != null) put("timeout_ms", timeoutMs)
        }
}

/** Thrown by `registerTool`/`unregisterTool` when a descriptor fails PROTOCOL.md §5 validation. */
internal class CordieriteInvalidToolDescriptorException(message: String) : IllegalArgumentException(message)

/** Passed to a [CordieriteToolHandler]. Cancellation is coroutine-native: when the daemon sends
 * `tool_cancel` for [callId], or the session suspends mid-call, the handler's own coroutine is
 * cancelled -- a handler that calls further suspend functions observes that as a
 * `CancellationException` the normal kotlinx.coroutines way; one that does no further suspending
 * work simply runs to completion, exactly like an app that ignores JS's `AbortSignal`. */
internal data class CordieriteToolCallContext(
    val callId: String,
    val toolName: String,
    val sessionId: String,
    internal val reportProgressFn: suspend (progress: Double?, message: String?) -> Unit,
) {
    /** Best-effort: send failures are reported on the `error` listener (phase `"tool"`), never
     * thrown back into the handler. Call with no arguments to send a bare progress ping. */
    suspend fun reportProgress(
        progress: Double? = null,
        message: String? = null,
    ) {
        reportProgressFn(progress, message)
    }
}

internal typealias CordieriteToolHandler = suspend (args: JSONObject, context: CordieriteToolCallContext) -> Any?

internal data class CordieriteRegisteredTool(
    val descriptor: CordieriteToolDescriptor,
    val handler: CordieriteToolHandler,
)

/** Mirrors `CordieriteErrorEventNative` / the JS `CordieriteUnifiedErrorEvent` (`phase` is one of
 * "bootstrap" | "connect" | "socket" | "tool"). */
internal data class CordieriteUnifiedError(
    val phase: String,
    val message: String,
    val code: String? = null,
    val nativeCode: String? = null,
    val closeReason: String? = null,
    val isRetryable: Boolean? = null,
    val hint: String? = null,
    val toolName: String? = null,
    val invocationId: String? = null,
    val cause: Throwable? = null,
)

/** `connect()` input: either explicit connection options or a decoded v2 bootstrap payload
 * (`handleUrl`/`decodeBootstrap`, PROTOCOL.md §2). */
internal sealed class CordieriteConnectInput {
    data class Explicit(
        val ip: String,
        val port: Int,
        val sessionId: String,
        /** Claim token, base64url. Required unless [resumeToken] is given. */
        val token: String? = null,
        /** When present, sends `session_resume` instead of `session_claim`. */
        val resumeToken: String? = null,
        val expiresAt: Long,
        val deviceManufacturer: String? = null,
        val deviceModel: String? = null,
        val deviceOs: String? = null,
        val linkPin: String? = null,
    ) : CordieriteConnectInput()

    data class Bootstrap(
        val payload: CordieriteBootstrapPayload,
        /** The deep link's separate `pin` query param (`extractLinkPin` in `bootstrap.ts`). */
        val linkPin: String? = null,
    ) : CordieriteConnectInput()
}

/** `stateChange(state, reason?)`. `reason` is set on transitions into `closed`/`reconnecting`:
 * `revoked`, `grace_expired`, `closed_by_app`, `socket_error`, `connect_error`, `background`,
 * `foreground` (mirrors the JS `CordieriteUnifiedStateChangeEvent`). */
internal typealias CordieriteStateChangeListener = (state: CordieriteClientState, reason: String?) -> Unit

/** `sessionChange(sessionId?, alias?)`, matching `CordieriteSessionChangeEventNative` (the frozen
 * TurboModule spec carries no `type`/`reason` on this event -- both are `null` once the session is
 * gone). */
internal typealias CordieriteSessionChangeListener = (sessionId: String?, alias: String?) -> Unit

internal typealias CordieriteErrorListener = (error: CordieriteUnifiedError) -> Unit
