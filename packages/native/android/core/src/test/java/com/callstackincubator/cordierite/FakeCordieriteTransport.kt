package com.callstackincubator.cordierite

import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A scripted [CordieriteTransport] driving [CordieriteClient] tests on the plain JVM -- no
 * `Context`, no OkHttp, no Robolectric. `connect()`/`send()`/`close()` succeed synchronously by
 * default (like a real socket that opens instantly); tests script failures via [nextConnectError]/
 * [nextSendError] and push server-driven events with [simulateAck]/[simulateMessage]/
 * [simulateClose]/[simulateError].
 */
internal class FakeCordieriteTransport(
    private val onMessage: (String) -> Unit,
    private val onError: (CordieriteErrorDetails) -> Unit,
    private val onClose: (Map<String, Any?>) -> Unit,
) : CordieriteTransport {
    @Volatile var rawState: String = "idle"

    val sentMessages = CopyOnWriteArrayList<String>()
    val connectCalls = CopyOnWriteArrayList<Map<String, Any?>>()

    @Volatile var nextConnectError: Throwable? = null

    @Volatile var nextSendError: Throwable? = null

    /** When `true`, [send] hands its `completion` to a fresh background thread (after a short real
     * sleep) instead of calling it inline. `rawSend`'s `suspendCancellableCoroutine` genuinely
     * suspends and is resumed via the dispatcher, exactly like a real socket write, so a caller
     * whose coroutine `Job` was cancelled in the meantime (`handleToolCancel`/`abortAllInFlight`)
     * observes that on resume -- the default synchronous completion below resumes inline, before
     * `suspendCancellableCoroutine` ever actually suspends, which cannot reproduce that class of
     * bug (see `CordieriteToolInvokerTest`/`CordieriteClientTest`'s cancellation-reaches-the-wire
     * tests). */
    @Volatile var deferSendCompletion = false

    @Volatile var resumeLeaseRecordValue: Map<String, Any?>? = null

    @Volatile var buildConfigValue: CordieriteBuildConfig = CordieriteBuildConfig(trust = "pin", hasEmbeddedPins = true, allowPrivateLanOnly = true)

    @Volatile var invalidated = false

    override fun connect(
        rawOptions: Map<String, Any?>,
        completion: (Throwable?) -> Unit,
    ) {
        connectCalls.add(rawOptions)
        val error = nextConnectError
        if (error != null) {
            rawState = "error"
            completion(error)
            return
        }
        rawState = "connecting"
        completion(null)
    }

    override fun send(
        message: String,
        completion: (Throwable?) -> Unit,
    ) {
        val error = nextSendError
        if (error == null) sentMessages.add(message)

        if (deferSendCompletion) {
            Thread {
                Thread.sleep(20)
                completion(error)
            }.start()
        } else {
            completion(error)
        }
    }

    override fun close(completion: () -> Unit) {
        rawState = "closed"
        completion()
    }

    override fun invalidate(completion: () -> Unit) {
        invalidated = true
        completion()
    }

    override fun getState(): String = rawState

    override fun getResumeLeaseRecord(): Map<String, Any?>? = resumeLeaseRecordValue

    override fun clearResumeLease(): Boolean {
        resumeLeaseRecordValue = null
        return true
    }

    override fun getBuildConfig(): CordieriteBuildConfig = buildConfigValue

    /** Delivers a `session_ack` for the most recent `connect()` -- moves the raw transport state to
     * `"active"`, matching what a real ack does. */
    fun simulateAck(
        sessionId: String,
        resumeToken: String = "resume-token-$sessionId",
        alias: String = "test-device",
        keepaliveIntervalS: Double = 15.0,
        graceS: Double = 600.0,
    ) {
        rawState = "active"
        onMessage(
            JSONObject()
                .put("type", "session_ack")
                .put("session_id", sessionId)
                .put("status", "ok")
                .put("alias", alias)
                .put("resume_token", resumeToken)
                .put("keepalive_interval_s", keepaliveIntervalS)
                .put("grace_s", graceS)
                .toString(),
        )
    }

    fun simulateMessage(json: JSONObject) = onMessage(json.toString())

    fun simulateClose(
        code: Int?,
        reason: String?,
    ) {
        rawState = "closed"
        onClose(mapOf("code" to code, "reason" to reason))
    }

    fun simulateError(details: CordieriteErrorDetails) = onError(details)
}

/** Polls [condition] on the calling thread until it is true or [timeoutMs] elapses. Used because
 * [CordieriteClient] confines its state to its own real-time dispatcher (not a virtual-time test
 * dispatcher), so waiting for an async transition needs a real, short poll rather than
 * `kotlinx-coroutines-test`'s virtual clock. */
internal fun waitUntil(
    timeoutMs: Long = 2000,
    intervalMs: Long = 5,
    condition: () -> Boolean,
) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!condition()) {
        if (System.currentTimeMillis() >= deadline) {
            throw AssertionError("Condition not met within ${timeoutMs}ms")
        }
        Thread.sleep(intervalMs)
    }
}
