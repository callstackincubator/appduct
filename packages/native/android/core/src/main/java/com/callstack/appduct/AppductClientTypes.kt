package com.callstack.appduct

import org.json.JSONObject

// Tool timeout bounds (packages/shared/src/domains/tool-descriptor.ts): matches
// `DEFAULT_TOOL_TIMEOUT_MS`/`MIN_TOOL_TIMEOUT_MS`/`MAX_TOOL_TIMEOUT_MS` there exactly --
// `AppductToolRegistry.kt`'s `upsert` clamps every declared `timeoutMs` into this range before
// it is stored or sent on the wire, the same way the pre-port JS `normalizeToolTimeoutMs` did, so
// this app's own abort timer and the daemon's `tools.call` deadline never disagree.

/** The client-wide fallback timeout applied when a tool declares no `timeoutMs` of its own. */
internal const val APPDUCT_DEFAULT_TOOL_TIMEOUT_MS = 10_000L

internal const val APPDUCT_MIN_TOOL_TIMEOUT_MS = 1_000L
internal const val APPDUCT_MAX_TOOL_TIMEOUT_MS = 600_000L

/** Clamps an already-validated positive `timeoutMs` into
 * `[APPDUCT_MIN_TOOL_TIMEOUT_MS, APPDUCT_MAX_TOOL_TIMEOUT_MS]`. */
internal fun clampAppductToolTimeoutMs(timeoutMs: Long): Long =
    timeoutMs.coerceIn(APPDUCT_MIN_TOOL_TIMEOUT_MS, APPDUCT_MAX_TOOL_TIMEOUT_MS)

/** Unified client state (ARCHITECTURE.md §11 / the JS `AppductClientState`). Distinct from the
 * raw transport-level state ([AppductConnectionManager]'s own idle/connecting/active/closed/error) --
 * this adds `reconnecting` for the resume/backoff loop that lives entirely in [AppductClient]. */
internal enum class AppductClientState {
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
internal data class AppductToolDescriptor(
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

    companion object {
        /** Parses the bridge's `registerTool(descriptorJson)` wire-shaped JSON (mirrors iOS's
         * `parseToolDescriptor`). Structural parsing only -- PROTOCOL.md §5 validation (name
         * pattern, description length, ...) happens separately in
         * [validateAppductToolDescriptor], run by [AppductToolRegistry.upsert]. */
        fun fromJson(json: String): AppductToolDescriptor {
            val obj =
                try {
                    JSONObject(json)
                } catch (e: Exception) {
                    throw AppductInvalidToolDescriptorException("Tool descriptor must be a JSON object.")
                }

            // `optString` would silently coerce a non-string value (e.g. a number) to its
            // `toString()` instead of rejecting it -- strict here so a wire violation is caught
            // by validateAppductToolDescriptor's later checks instead of accepted as a
            // stringified accident (packages/native/fixtures/tool-descriptors.json's
            // "description-non-string" case).
            fun requiredStringOrEmpty(key: String, errorSubject: String): String {
                val raw = obj.opt(key)
                return when {
                    raw == null || raw === JSONObject.NULL -> ""
                    raw is String -> raw
                    else -> throw AppductInvalidToolDescriptorException("$errorSubject \"$key\" must be a string.")
                }
            }

            val name = requiredStringOrEmpty("name", "Tool descriptor's")

            fun optionalObject(key: String): JSONObject? {
                if (!obj.has(key) || obj.isNull(key)) return null
                return obj.optJSONObject(key)
                    ?: throw AppductInvalidToolDescriptorException("Tool \"$name\" $key must be a JSON object.")
            }

            // Same rule as `@appduct/shared`'s `isToolDescriptor` and the Swift bridge: an
            // integer only. A fractional value is rejected here rather than truncated, so all three
            // bridges agree with packages/native/fixtures/tool-descriptors.json.
            val timeoutMs: Long? =
                if (obj.has("timeout_ms") && !obj.isNull("timeout_ms")) {
                    when (val raw = obj.opt("timeout_ms")) {
                        is Int -> raw.toLong()
                        is Long -> raw
                        is Number -> {
                            val asDouble = raw.toDouble()
                            if (asDouble.isFinite() && asDouble == Math.floor(asDouble)) {
                                asDouble.toLong()
                            } else {
                                throw AppductInvalidToolDescriptorException("Tool \"$name\" timeout_ms must be a positive integer.")
                            }
                        }
                        else -> throw AppductInvalidToolDescriptorException("Tool \"$name\" timeout_ms must be a positive integer.")
                    }
                } else {
                    null
                }

            return AppductToolDescriptor(
                name = name,
                description = requiredStringOrEmpty("description", "Tool \"$name\""),
                inputSchema = optionalObject("input_schema"),
                outputSchema = optionalObject("output_schema"),
                annotations = optionalObject("annotations"),
                timeoutMs = timeoutMs,
            )
        }
    }
}

/** Thrown by `registerTool`/`unregisterTool` when a descriptor fails PROTOCOL.md §5 validation. */
internal class AppductInvalidToolDescriptorException(message: String) : IllegalArgumentException(message)

/** Passed to a [AppductToolHandler]. Cancellation is coroutine-native: when the daemon sends
 * `tool_cancel` for [callId], or the session suspends mid-call, the handler's own coroutine is
 * cancelled -- a handler that calls further suspend functions observes that as a
 * `CancellationException` the normal kotlinx.coroutines way; one that does no further suspending
 * work simply runs to completion, exactly like an app that ignores JS's `AbortSignal`. */
internal data class AppductToolCallContext(
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

internal typealias AppductToolHandler = suspend (args: JSONObject, context: AppductToolCallContext) -> Any?

internal data class AppductRegisteredTool(
    val descriptor: AppductToolDescriptor,
    val handler: AppductToolHandler,
)

/** Mirrors `AppductErrorEventNative` / the JS `AppductUnifiedErrorEvent` (`phase` is one of
 * "bootstrap" | "connect" | "socket" | "tool"). */
internal data class AppductUnifiedError(
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
internal sealed class AppductConnectInput {
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
    ) : AppductConnectInput()

    data class Bootstrap(
        val payload: AppductBootstrapPayload,
        /** The deep link's separate `pin` query param (`extractLinkPin` in `bootstrap.ts`). */
        val linkPin: String? = null,
    ) : AppductConnectInput()

    companion object {
        /** Parses the bridge's `connect(inputJson)` payload: either a decoded v2 bootstrap payload
         * (`family`/`address` present) or explicit connect options (`ip` instead) -- see
         * `NativeAppduct.ts`'s `connect` doc comment. */
        fun fromJson(json: String): AppductConnectInput {
            val obj = JSONObject(json)

            return if (obj.has("family") && obj.has("address")) {
                Bootstrap(
                    payload =
                        AppductBootstrapPayload(
                            family = obj.getInt("family"),
                            address = obj.getString("address"),
                            port = obj.getInt("port"),
                            sessionId = obj.getString("sessionId"),
                            token = obj.getString("token"),
                            expiresAt = obj.getLong("expiresAt"),
                        ),
                    linkPin = obj.optStringOrNull("linkPin"),
                )
            } else {
                Explicit(
                    ip = obj.getString("ip"),
                    port = obj.getInt("port"),
                    sessionId = obj.getString("sessionId"),
                    token = obj.optStringOrNull("token"),
                    resumeToken = obj.optStringOrNull("resumeToken"),
                    expiresAt = obj.getLong("expiresAt"),
                    deviceManufacturer = obj.optStringOrNull("deviceManufacturer"),
                    deviceModel = obj.optStringOrNull("deviceModel"),
                    deviceOs = obj.optStringOrNull("deviceOs"),
                    linkPin = obj.optStringOrNull("linkPin"),
                )
            }
        }
    }
}

private fun JSONObject.optStringOrNull(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null

/** `stateChange(state, reason?)`. `reason` is set on transitions into `closed`/`reconnecting`:
 * `revoked`, `grace_expired`, `closed_by_app`, `socket_error`, `connect_error`, `background`,
 * `foreground` (mirrors the JS `AppductUnifiedStateChangeEvent`). */
internal typealias AppductStateChangeListener = (state: AppductClientState, reason: String?) -> Unit

/** `sessionChange(type, sessionId?, alias?, reason?)`, matching `AppductSessionChangeEventNative`
 * (issue #48 review, Decision 5 follow-up: restoring the `type`/`reason` the initial phase-2 port
 * dropped). `type` is `"claimed"` | `"resumed"` | `"lost"`; `sessionId`/`alias` are both `null` once
 * the session is gone; `reason` is set only when `type` is `"lost"`. */
internal typealias AppductSessionChangeListener = (
    type: String,
    sessionId: String?,
    alias: String?,
    reason: String?,
) -> Unit

internal typealias AppductErrorListener = (error: AppductUnifiedError) -> Unit
