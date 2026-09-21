package com.callstack.appduct

import android.content.Intent
import android.net.Uri
import org.json.JSONObject

/**
 * No-op mirror of `core`'s [Appduct] facade (docs/tasks/19-android-entry-points.md, issue #48
 * decision 2): same public surface, but every method does nothing and [state] is always
 * [ClientState.closed]. No `AppductInitProvider` in this module at all -- there is no `Context`
 * to capture and nothing to restore, so this build never touches the network and never needs a
 * manifest entry either (matching `core-noop`'s already-empty `AndroidManifest.xml`). No
 * `kotlinx.coroutines` import: `suspend` is a Kotlin-language/stdlib feature, not a
 * `kotlinx-coroutines-core` one, so these stub `suspend fun`s cost this module nothing, matching
 * the "no coroutine dependency" rule the rest of `core-noop` already follows.
 */
object Appduct {
    fun register(
        name: String,
        description: String,
        inputSchema: JSONObject? = null,
        outputSchema: JSONObject? = null,
        annotations: ToolAnnotations? = null,
        timeoutMs: Long? = null,
        group: String? = null,
        handler: suspend (args: JSONObject, context: ToolCallContext) -> Any?,
    ): ToolRegistration = ToolRegistration(name) {}

    /** Convenience overload for a handler that doesn't need [ToolCallContext] -- never invoked in
     * this build either. */
    fun register(
        name: String,
        description: String,
        inputSchema: JSONObject? = null,
        outputSchema: JSONObject? = null,
        annotations: ToolAnnotations? = null,
        timeoutMs: Long? = null,
        group: String? = null,
        handler: suspend (args: JSONObject) -> Any?,
    ): ToolRegistration = ToolRegistration(name) {}

    fun handle(intent: Intent): Boolean = false

    fun handle(uri: Uri): Boolean = false

    suspend fun postEvent(
        name: String,
        payload: Any? = null,
    ) {}

    val state: ClientState = ClientState.closed

    val sessionId: String? = null

    val buildConfig: BuildConfig =
        BuildConfig(trust = "excluded", hasEmbeddedPins = false, allowPrivateLanOnly = true)

    suspend fun restoreSession(): Boolean = false

    suspend fun disconnect() {}

    fun addListener(listener: (AppductEvent) -> Unit): Subscription = Subscription {}
}

/** No-op mirror of `core`'s `ToolRegistration` -- same shape, [remove] just does nothing. */
class ToolRegistration internal constructor(
    val name: String,
    private val onRemove: () -> Unit,
) {
    fun remove() = onRemove()
}

/** No-op mirror of `core`'s `Subscription`. */
class Subscription internal constructor(private val onRemove: () -> Unit) {
    fun remove() = onRemove()
}

/** No-op mirror of `core`'s `ToolAnnotations` -- same shape, never converted to wire JSON here. */
data class ToolAnnotations(
    val readOnlyHint: Boolean? = null,
    val destructiveHint: Boolean? = null,
    val idempotentHint: Boolean? = null,
)

/** No-op mirror of `core`'s `ToolCallContext` -- this module never invokes a registered handler,
 * so this is never constructed, but the type still exists so `register`'s signature matches
 * `core`'s exactly. */
class ToolCallContext internal constructor() {
    val callId: String = ""
    val toolName: String = ""
    val sessionId: String = ""

    suspend fun reportProgress(
        progress: Double? = null,
        message: String? = null,
    ) {}
}

/** No-op mirror of `core`'s `ClientState`. */
enum class ClientState {
    idle,
    connecting,
    active,
    reconnecting,
    closed,
}

/** No-op mirror of `core`'s `SessionChangeType`. */
enum class SessionChangeType {
    claimed,
    resumed,
    lost,
}

/** No-op mirror of `core`'s `BuildConfig`. */
data class BuildConfig(
    val trust: String,
    val hasEmbeddedPins: Boolean,
    val allowPrivateLanOnly: Boolean,
)

/** No-op mirror of `core`'s `AppductEvent` -- never emitted here, since [Appduct.addListener]
 * returns a [Subscription] that nothing ever fires through. */
sealed class AppductEvent {
    data class StateChange(val state: ClientState, val reason: String?) : AppductEvent()

    data class SessionChange(
        val type: SessionChangeType,
        val sessionId: String?,
        val alias: String?,
        val reason: String? = null,
    ) : AppductEvent()

    data class Error(
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
    ) : AppductEvent()
}
