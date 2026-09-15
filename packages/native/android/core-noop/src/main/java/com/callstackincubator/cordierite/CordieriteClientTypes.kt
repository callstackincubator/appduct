package com.callstackincubator.cordierite

import org.json.JSONObject

/** No-op mirror of `core`'s `CordieriteClientTypes.kt` -- same public shapes, so a bridge compiled
 * against `core` also compiles unchanged against this module (docs/tasks/16-android-session-logic.md). */
internal const val CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS = 10_000L

internal enum class CordieriteClientState {
    idle,
    connecting,
    active,
    reconnecting,
    closed,
}

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

    companion object {
        /** Same structural JSON parsing as `core`'s -- pure JSON, no Android/OkHttp dependency, so
         * there is no reason for this build to parse it any differently. Kept identical rather than
         * a stub so the bridge behaves the same way regardless of which core variant resolved. */
        fun fromJson(json: String): CordieriteToolDescriptor {
            val obj =
                try {
                    JSONObject(json)
                } catch (e: Exception) {
                    throw CordieriteInvalidToolDescriptorException("Tool descriptor must be a JSON object.")
                }

            fun requiredStringOrEmpty(key: String, errorSubject: String): String {
                val raw = obj.opt(key)
                return when {
                    raw == null || raw === JSONObject.NULL -> ""
                    raw is String -> raw
                    else -> throw CordieriteInvalidToolDescriptorException("$errorSubject \"$key\" must be a string.")
                }
            }

            val name = requiredStringOrEmpty("name", "Tool descriptor's")

            fun optionalObject(key: String): JSONObject? {
                if (!obj.has(key) || obj.isNull(key)) return null
                return obj.optJSONObject(key)
                    ?: throw CordieriteInvalidToolDescriptorException("Tool \"$name\" $key must be a JSON object.")
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
                                throw CordieriteInvalidToolDescriptorException("Tool \"$name\" timeout_ms must be a positive integer.")
                            }
                        }
                        else -> throw CordieriteInvalidToolDescriptorException("Tool \"$name\" timeout_ms must be a positive integer.")
                    }
                } else {
                    null
                }

            return CordieriteToolDescriptor(
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

/** No-op mirror of `core`'s `CordieriteToolReplyError` -- this module never invokes a registered
 * handler, so it is never thrown here, but the bridge (compiled against both `core` and
 * `core-noop`) references the type unconditionally. */
internal class CordieriteToolReplyError(
    val errorType: String,
    override val message: String,
    val details: Any? = null,
) : Exception(message)

internal class CordieriteInvalidToolDescriptorException(message: String) : IllegalArgumentException(message)

internal data class CordieriteToolCallContext(
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

internal typealias CordieriteToolHandler = suspend (args: JSONObject, context: CordieriteToolCallContext) -> Any?

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

/** No-op mirror of `core`'s decoded v2 bootstrap payload -- this module never decodes one
 * ([hasCordieriteBootstrapQuery]/`handleUrl` never get far enough to build one), but the type
 * still exists so [CordieriteConnectInput.Bootstrap] keeps the same shape. */
internal data class CordieriteBootstrapPayload(
    val family: Int,
    val address: String,
    val port: Int,
    val sessionId: String,
    val token: String,
    val expiresAt: Long,
)

internal sealed class CordieriteConnectInput {
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
    ) : CordieriteConnectInput()

    data class Bootstrap(
        val payload: CordieriteBootstrapPayload,
        val linkPin: String? = null,
    ) : CordieriteConnectInput()

    companion object {
        /** Same structural JSON parsing as `core`'s -- see `CordieriteToolDescriptor.fromJson`'s
         * doc comment above for why this build keeps a real parser rather than a stub. */
        fun fromJson(json: String): CordieriteConnectInput {
            val obj = JSONObject(json)

            return if (obj.has("family") && obj.has("address")) {
                Bootstrap(
                    payload =
                        CordieriteBootstrapPayload(
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

internal typealias CordieriteStateChangeListener = (state: CordieriteClientState, reason: String?) -> Unit
internal typealias CordieriteSessionChangeListener = (
    type: String,
    sessionId: String?,
    alias: String?,
    reason: String?,
) -> Unit
internal typealias CordieriteErrorListener = (error: CordieriteUnifiedError) -> Unit

/** Never fires and never needs removing in this build, but keeps the same call shape as `core`'s. */
internal class CordieriteSubscription internal constructor(private val onRemove: () -> Unit) {
    fun remove() = onRemove()
}

/** Always returns `false` -- this build never decodes a bootstrap payload at all. */
internal fun hasCordieriteBootstrapQuery(rawUrl: String?): Boolean = false
