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
)

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
}

internal typealias CordieriteStateChangeListener = (state: CordieriteClientState, reason: String?) -> Unit
internal typealias CordieriteSessionChangeListener = (sessionId: String?, alias: String?) -> Unit
internal typealias CordieriteErrorListener = (error: CordieriteUnifiedError) -> Unit

/** Never fires and never needs removing in this build, but keeps the same call shape as `core`'s. */
internal class CordieriteSubscription internal constructor(private val onRemove: () -> Unit) {
    fun remove() = onRemove()
}

/** Always returns `false` -- this build never decodes a bootstrap payload at all. */
internal fun hasCordieriteBootstrapQuery(rawUrl: String?): Boolean = false
