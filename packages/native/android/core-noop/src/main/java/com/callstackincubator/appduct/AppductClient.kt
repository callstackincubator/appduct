package com.callstackincubator.appduct

import android.content.Context

/**
 * No-op mirror of `core`'s `AppductClient` (docs/tasks/16-android-session-logic.md, issue #48
 * decision 2): same public surface a consumer or the RN bridge calls, but `state` is always
 * `"closed"`, `registerTool`/`unregisterTool` store nothing and never touch the wire,
 * `handleUrl` always returns `false`, and no listener is ever invoked. No okhttp3, no
 * kotlinx.coroutines -- the real dependency graph is never on a release classpath that resolved
 * this module instead of `core`.
 */
internal class AppductClient(
    // Nullable so the test-only constructor below can delegate here without a real `Context` --
    // Kotlin erases `Context` and `Context?` identically, so a second, non-null overload of this
    // same constructor would be a JVM signature clash. Every real call site (matching `core`'s
    // public `constructor(context: Context, ...)`) passes a non-null `Context` regardless; nothing
    // in this no-op ever dereferences it.
    context: Context?,
    defaultToolTimeoutMs: Long = APPDUCT_DEFAULT_TOOL_TIMEOUT_MS,
) {
    /** Test-only entry point, matching `core`'s shape; every parameter is ignored. */
    internal constructor(
        transportFactory: (
            emitStateChange: (String) -> Unit,
            emitMessageRaw: (String) -> Unit,
            emitError: (AppductErrorDetails) -> Unit,
            emitClose: (Map<String, Any?>) -> Unit,
        ) -> AppductTransport,
        defaultToolTimeoutMs: Long = APPDUCT_DEFAULT_TOOL_TIMEOUT_MS,
        lifecycleObserverFactory: ((Boolean) -> Unit) -> Unit = {},
    ) : this(context = null, defaultToolTimeoutMs = defaultToolTimeoutMs)

    val state: AppductClientState = AppductClientState.closed

    val sessionId: String? = null

    val registeredTools: List<AppductToolDescriptor> = emptyList()

    val buildConfig: AppductBuildConfig =
        AppductBuildConfig(trust = "excluded", hasEmbeddedPins = false, allowPrivateLanOnly = true)

    fun addStateChangeListener(listener: AppductStateChangeListener): AppductSubscription = AppductSubscription {}

    fun addSessionChangeListener(listener: AppductSessionChangeListener): AppductSubscription = AppductSubscription {}

    fun addErrorListener(listener: AppductErrorListener): AppductSubscription = AppductSubscription {}

    fun registerTool(
        descriptor: AppductToolDescriptor,
        handler: AppductToolHandler,
    ) {
        // Stores nothing: a release build resolving this module never sends a tool registry.
    }

    fun unregisterTool(name: String) {}

    fun handleUrl(url: String): Boolean = false

    suspend fun connect(
        input: AppductConnectInput,
        supersede: Boolean = false,
    ) {
        throw IllegalStateException("Appduct is disabled in this build (the core-noop artifact is in use).")
    }

    suspend fun restoreSession(): Boolean = false

    suspend fun disconnect() {}

    suspend fun postEvent(
        name: String,
        payload: Any?,
    ) {}

    fun destroy() {}
}
