package com.callstackincubator.cordierite

/**
 * The transport seam `CordieriteClient` (docs/tasks/16-android-session-logic.md) is built on. The
 * real implementation is [CordieriteConnectionManager] (TLS + SPKI pinning + the wire handshake);
 * tests substitute a scripted fake that implements this same interface on the plain JVM, with no
 * `Context`, no OkHttp, and no Robolectric.
 *
 * Every method here already matched [CordieriteConnectionManager]'s public surface before this
 * interface existed -- extracting it required no signature changes to that class.
 */
internal interface CordieriteTransport {
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

    fun getBuildConfig(): CordieriteBuildConfig
}
