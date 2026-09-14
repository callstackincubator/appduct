package com.callstackincubator.cordierite

/** No-op mirror of `core`'s `CordieriteTransport` -- see that module for the real contract. */
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
