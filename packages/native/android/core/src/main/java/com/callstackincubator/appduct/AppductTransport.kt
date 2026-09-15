package com.callstackincubator.appduct

/**
 * The transport seam `AppductClient` (docs/tasks/16-android-session-logic.md) is built on. The
 * real implementation is [AppductConnectionManager] (TLS + SPKI pinning + the wire handshake);
 * tests substitute a scripted fake that implements this same interface on the plain JVM, with no
 * `Context`, no OkHttp, and no Robolectric.
 *
 * Every method here already matched [AppductConnectionManager]'s public surface before this
 * interface existed -- extracting it required no signature changes to that class.
 */
internal interface AppductTransport {
    fun connect(
        rawOptions: Map<String, Any?>,
        completion: (Throwable?) -> Unit,
    )

    fun send(
        message: String,
        completion: (Throwable?) -> Unit,
    )

    fun close(completion: () -> Unit)

    fun invalidate(completion: () -> Unit)

    fun getState(): String

    fun getResumeLeaseRecord(): Map<String, Any?>?

    fun clearResumeLease(): Boolean

    fun getBuildConfig(): AppductBuildConfig
}
