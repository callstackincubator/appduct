package com.callstackincubator.cordierite

import android.content.Context
import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Public entry point for a plain Android app that wants Cordierite without React Native
 * (docs/tasks/19-android-entry-points.md, issue #48 phase 3). A thin facade over the internal
 * [CordieriteClient] this module already ships (docs/tasks/16-android-session-logic.md) -- every
 * method here just converts to/from that class's own types, so session logic (reconnect, grace,
 * lease restore, registry sync, per-call timeout/cancel/progress) is never duplicated.
 *
 * Initialization needs an Android [Context], which this object gets for free, before any app code
 * runs, from [CordieriteInitProvider] (declared in this module's own `AndroidManifest.xml` --
 * *not* vendored into `@cordierite/react-native`, see that package's `scripts/sync-native-core.mjs`,
 * so this object is never auto-initialized inside the RN bridge, which talks to [CordieriteClient]
 * directly instead and has its own initialization path). By the time an app's own
 * `Application.onCreate()` runs, [CordieriteInitProvider.onCreate] has already captured the
 * application [Context] and constructed the real client -- see that class's own doc comment for
 * why that ordering is guaranteed by the platform.
 *
 * `core-noop` mirrors every declaration below as an inert no-op with no [CordieriteInitProvider]
 * and no `kotlinx.coroutines` import (docs/tasks/19-android-entry-points.md) -- a release build
 * that resolves `core-noop` instead of `core` never captures a `Context` and never touches the
 * network, matching issue #48 decision 2.
 */
object Cordierite {
    @Volatile
    private var backingClient: CordieriteClient? = null

    /** Owns the one background `restoreSession()` [attach] kicks off. Not used for anything else
     * -- every other suspend call an app makes runs in its own caller-supplied coroutine. */
    private val initScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Called once, by [CordieriteInitProvider.onCreate], before any app code runs. A second call
     * -- there should never be one, since a process gets exactly one `ContentProvider` instance
     * per declared authority -- is a no-op rather than replacing an already-constructed client. */
    internal fun attach(context: Context) {
        if (backingClient != null) return
        val client = CordieriteClient(context)
        backingClient = client
        initScope.launch {
            runCatching { client.restoreSession() }
        }
    }

    /** Test-only: substitutes a scripted client (typically one built over
     * `FakeCordieriteTransport`, `core/src/test`) and skips the automatic `restoreSession()`
     * kickoff, so a test controls timing explicitly instead of racing a background coroutine. */
    internal fun attachForTest(client: CordieriteClient) {
        backingClient = client
    }

    /** Test-only: undoes [attachForTest] so a later test starts from a clean slate. */
    internal fun detachForTest() {
        backingClient = null
    }

    private fun client(): CordieriteClient =
        backingClient
            ?: throw IllegalStateException(
                "Cordierite is not initialized. This means CordieriteInitProvider did not run -- " +
                    "check it was not removed with tools:node=\"remove\" from your app's merged " +
                    "manifest without a replacement Cordierite.attach() call " +
                    "(packages/native/android/README.md, \"Opting out of the init provider and " +
                    "trampoline\").",
            )

    // --- registration ---

    /**
     * Registers (or replaces, by [name]) a tool. Throws `IllegalArgumentException` synchronously
     * for an invalid [name]/[description]/[annotations]/[timeoutMs] (PROTOCOL.md §5). [handler]
     * runs on this client's own background dispatcher, never the main thread -- hop to
     * `Dispatchers.Main` yourself for UI work. Its return value is converted to JSON the same way
     * this module's `CordieriteClient` always has (`org.json` values, and plain Kotlin/Java
     * collections, maps, strings, numbers, booleans, and `null`); anything else fails the call
     * with `tool_serialization_error` instead of crashing the caller.
     */
    fun register(
        name: String,
        description: String,
        inputSchema: JSONObject? = null,
        outputSchema: JSONObject? = null,
        annotations: ToolAnnotations? = null,
        timeoutMs: Long? = null,
        handler: suspend (args: JSONObject, context: ToolCallContext) -> Any?,
    ): ToolRegistration {
        val descriptor =
            CordieriteToolDescriptor(
                name = name,
                description = description,
                inputSchema = inputSchema,
                outputSchema = outputSchema,
                annotations = annotations?.toWireJson(),
                timeoutMs = timeoutMs,
            )
        client().registerTool(descriptor) { args, context -> handler(args, ToolCallContext(context)) }
        return ToolRegistration(name) { client().unregisterTool(name) }
    }

    /** Convenience overload for a handler that doesn't need [ToolCallContext] (e.g. no progress
     * reporting). */
    fun register(
        name: String,
        description: String,
        inputSchema: JSONObject? = null,
        outputSchema: JSONObject? = null,
        annotations: ToolAnnotations? = null,
        timeoutMs: Long? = null,
        handler: suspend (args: JSONObject) -> Any?,
    ): ToolRegistration =
        register(name, description, inputSchema, outputSchema, annotations, timeoutMs) { args, _ -> handler(args) }

    // --- deep links ---

    /** Reads [intent]'s `data` URI and forwards to [handle]. Returns `false` for a `null` data URI
     * -- the same "not mine, route it yourself" signal [handle] gives for any other URI. */
    fun handle(intent: Intent): Boolean {
        val uri = intent.data ?: return false
        return handle(uri)
    }

    /**
     * Feeds a deep link to the client. Returns `true` iff [uri] carried a Cordierite bootstrap
     * payload -- whatever the parse outcome; a bad payload is reported on [addListener] (a
     * [CordieriteEvent.Error] with `phase == "bootstrap"`) asynchronously, never thrown here.
     * `false` for any other URI, so the caller (or [CordieriteLinkActivity], for a link the OS
     * routed there) knows to handle it itself.
     */
    fun handle(uri: Uri): Boolean = client().handleUrl(uri.toString())

    // --- session ---

    /** Best-effort: dropped while no session is active; failures are reported on [addListener]
     * (phase `"socket"`), never thrown. */
    suspend fun postEvent(
        name: String,
        payload: Any? = null,
    ) = client().postEvent(name, payload)

    /** `idle | connecting | active | reconnecting | closed`. */
    val state: ClientState
        get() = client().state.toPublic()

    /** The session currently held, or the one an in-flight claim/resume is attempting, or
     * `null`. */
    val sessionId: String?
        get() = client().sessionId

    /** This build's effective trust/pin configuration, read from the same manifest meta-data a
     * real `connect()` uses (`docs/SECURITY.md`'s trust modes). */
    val buildConfig: BuildConfig
        get() = client().buildConfig.let { BuildConfig(it.trust, it.hasEmbeddedPins, it.allowPrivateLanOnly) }

    /**
     * Recovers the process-memory resume lease left by a previous session, if any. Resolves
     * `true` once a resume attempt has been accepted and started -- it does not wait for the
     * daemon's ack. [CordieriteInitProvider] already calls this once, in the background, right
     * after capturing the application `Context`; call it again yourself only if you disconnected
     * and want to retry, or you removed the provider and are driving initialization by hand.
     */
    suspend fun restoreSession(): Boolean = client().restoreSession()

    suspend fun disconnect() = client().disconnect()

    // --- listeners ---

    /**
     * Subscribes to every [CordieriteEvent] this client emits -- state changes, session changes,
     * and errors, in one channel. [Subscription.remove] removes only this one subscription.
     */
    fun addListener(listener: (CordieriteEvent) -> Unit): Subscription {
        val stateSub =
            client().addStateChangeListener { state, reason ->
                listener(CordieriteEvent.StateChange(state.toPublic(), reason))
            }
        val sessionSub =
            client().addSessionChangeListener { sessionId, alias ->
                listener(CordieriteEvent.SessionChange(sessionId, alias))
            }
        val errorSub =
            client().addErrorListener { error ->
                listener(
                    CordieriteEvent.Error(
                        phase = error.phase,
                        message = error.message,
                        code = error.code,
                        nativeCode = error.nativeCode,
                        closeReason = error.closeReason,
                        isRetryable = error.isRetryable,
                        hint = error.hint,
                        toolName = error.toolName,
                        invocationId = error.invocationId,
                        cause = error.cause,
                    ),
                )
            }
        return Subscription {
            stateSub.remove()
            sessionSub.remove()
            errorSub.remove()
        }
    }
}

private fun CordieriteClientState.toPublic(): ClientState = ClientState.valueOf(name)

/** A live tool registration returned by [Cordierite.register]. [remove] unregisters only this
 * tool; a no-op if called more than once, or after [name] was already replaced by a later
 * [Cordierite.register] call. */
class ToolRegistration internal constructor(
    val name: String,
    private val onRemove: () -> Unit,
) {
    fun remove() = onRemove()
}

/** A live [Cordierite.addListener] subscription. [remove] unsubscribes only this listener. */
class Subscription internal constructor(private val onRemove: () -> Unit) {
    fun remove() = onRemove()
}

/** PROTOCOL.md §5's three tool annotation hints. */
data class ToolAnnotations(
    val readOnlyHint: Boolean? = null,
    val destructiveHint: Boolean? = null,
    val idempotentHint: Boolean? = null,
) {
    internal fun toWireJson(): JSONObject =
        JSONObject().apply {
            if (readOnlyHint != null) put("readOnlyHint", readOnlyHint)
            if (destructiveHint != null) put("destructiveHint", destructiveHint)
            if (idempotentHint != null) put("idempotentHint", idempotentHint)
        }
}

/** Passed to a [Cordierite.register] handler. Cancellation is coroutine-native -- see
 * `CordieriteToolCallContext`'s doc comment (docs/tasks/16-android-session-logic.md): a handler
 * that calls further suspend functions observes a `tool_cancel` frame or session suspension as an
 * ordinary `CancellationException`; one that does no further suspending work just runs to
 * completion. */
class ToolCallContext internal constructor(private val inner: CordieriteToolCallContext) {
    val callId: String get() = inner.callId
    val toolName: String get() = inner.toolName
    val sessionId: String get() = inner.sessionId

    /** Best-effort: send failures are reported on [Cordierite.addListener] (phase `"tool"`), never
     * thrown back into the handler. Call with no arguments to send a bare progress ping. */
    suspend fun reportProgress(
        progress: Double? = null,
        message: String? = null,
    ) = inner.reportProgress(progress, message)
}

/** [Cordierite.state]. Distinct from the raw transport-level state -- `reconnecting` covers the
 * resume/backoff loop that lives entirely inside `CordieriteClient`. */
enum class ClientState {
    idle,
    connecting,
    active,
    reconnecting,
    closed,
}

/** [Cordierite.buildConfig]: this build's effective trust configuration. */
data class BuildConfig(
    val trust: String,
    val hasEmbeddedPins: Boolean,
    val allowPrivateLanOnly: Boolean,
)

/** Everything [Cordierite.addListener] emits, in one sealed type. */
sealed class CordieriteEvent {
    data class StateChange(val state: ClientState, val reason: String?) : CordieriteEvent()

    data class SessionChange(val sessionId: String?, val alias: String?) : CordieriteEvent()

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
    ) : CordieriteEvent()
}
