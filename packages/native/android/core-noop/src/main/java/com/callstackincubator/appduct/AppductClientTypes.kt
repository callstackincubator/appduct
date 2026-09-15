package com.callstackincubator.appduct

import org.json.JSONObject

/** No-op mirror of `core`'s `AppductClientTypes.kt` -- same public shapes, so a bridge compiled
 * against `core` also compiles unchanged against this module (docs/tasks/16-android-session-logic.md). */
internal const val APPDUCT_DEFAULT_TOOL_TIMEOUT_MS = 10_000L

internal enum class AppductClientState {
    idle,
    connecting,
    active,
    reconnecting,
    closed,
}

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
        /** Same structural JSON parsing as `core`'s -- pure JSON, no Android/OkHttp dependency, so
         * there is no reason for this build to parse it any differently. Kept identical rather than
         * a stub so the bridge behaves the same way regardless of which core variant resolved. */
        fun fromJson(json: String): AppductToolDescriptor {
            val obj =
                try {
                    JSONObject(json)
                } catch (e: Exception) {
                    throw AppductInvalidToolDescriptorException("Tool descriptor must be a JSON object.")
                }

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

/** No-op mirror of `core`'s `AppductToolReplyError` -- this module never invokes a registered
 * handler, so it is never thrown here, but the bridge (compiled against both `core` and
 * `core-noop`) references the type unconditionally. */
internal class AppductToolReplyError(
    val errorType: String,
    override val message: String,
    val details: Any? = null,
) : Exception(message)

internal class AppductInvalidToolDescriptorException(message: String) : IllegalArgumentException(message)

internal data class AppductToolCallContext(
    val callId: String,
    val toolName: String,
    val sessionId: String,
    internal val reportProgressFn: suspend (progress: Double?, message: String?) -> Unit,
) {
    suspend fun reportProgress(
        progress: Double? = null,
        message: String? = null,
    ) {
        reportProgressFn(progress, message)
    }
}

internal typealias AppductToolHandler = suspend (args: JSONObject, context: AppductToolCallContext) -> Any?

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

/** No-op mirror of `core`'s decoded v2 bootstrap payload -- this module never decodes one
 * ([hasAppductBootstrapQuery]/`handleUrl` never get far enough to build one), but the type
 * still exists so [AppductConnectInput.Bootstrap] keeps the same shape. */
internal data class AppductBootstrapPayload(
    val family: Int,
    val address: String,
    val port: Int,
    val sessionId: String,
    val token: String,
    val expiresAt: Long,
)

internal sealed class AppductConnectInput {
    data class Explicit(
        val ip: String,
        val port: Int,
        val sessionId: String,
        val token: String? = null,
        val resumeToken: String? = null,
        val expiresAt: Long,
        val deviceManufacturer: String? = null,
        val deviceModel: String? = null,
        val deviceOs: String? = null,
        val linkPin: String? = null,
    ) : AppductConnectInput()

    data class Bootstrap(
        val payload: AppductBootstrapPayload,
        val linkPin: String? = null,
    ) : AppductConnectInput()

    companion object {
        /** Same structural JSON parsing as `core`'s -- see `AppductToolDescriptor.fromJson`'s
         * doc comment above for why this build keeps a real parser rather than a stub. */
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

internal typealias AppductStateChangeListener = (state: AppductClientState, reason: String?) -> Unit
internal typealias AppductSessionChangeListener = (
    type: String,
    sessionId: String?,
    alias: String?,
    reason: String?,
) -> Unit
internal typealias AppductErrorListener = (error: AppductUnifiedError) -> Unit

/** Never fires and never needs removing in this build, but keeps the same call shape as `core`'s. */
internal class AppductSubscription internal constructor(private val onRemove: () -> Unit) {
    fun remove() = onRemove()
}

/** Always returns `false` -- this build never decodes a bootstrap payload at all. */
internal fun hasAppductBootstrapQuery(rawUrl: String?): Boolean = false
