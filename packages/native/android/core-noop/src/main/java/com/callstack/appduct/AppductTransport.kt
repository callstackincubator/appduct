package com.callstack.appduct

/** No-op mirror of `core`'s `AppductTransport` -- see that module for the real contract. */
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
