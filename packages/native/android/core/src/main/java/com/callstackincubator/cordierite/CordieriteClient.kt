package com.callstackincubator.cordierite

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A subscription returned by `CordieriteClient.addXListener`; call [remove] to unsubscribe. */
internal class CordieriteSubscription internal constructor(private val onRemove: () -> Unit) {
    fun remove() = onRemove()
}

/** The claim/resume handshake rejected the socket outright (PROTOCOL.md §7's close-code table) --
 * carries the close code/reason so a terminal daemon rejection (1008) can be told apart from a
 * retryable transport failure, mirroring JS's `CordieriteHandshakeClosedError`. */
private class CordieriteHandshakeClosedException(
    message: String,
    val code: Int?,
    val reason: String?,
) : Exception(message)

/** One resume-token/alias/grace tuple this client currently holds, plus the endpoint to resume
 * against. Mutable (`disconnectedAtMs`) because both the grace timer and the reconnect loop stamp
 * it the first time the socket is lost, mirroring `client/index.ts`'s `HeldSession`. */
private data class HeldSession(
    val sessionId: String,
    var resumeToken: String,
    val alias: String,
    val keepaliveIntervalS: Double,
    val graceS: Double,
    var disconnectedAtMs: Long?,
    val ip: String,
    val port: Int,
)

private data class ConnectOptionsInternal(
    val ip: String,
    val port: Int,
    val sessionId: String,
    val token: String?,
    val resumeToken: String?,
    val expiresAt: Long,
    val deviceManufacturer: String?,
    val deviceModel: String?,
    val deviceOs: String?,
    val linkPin: String?,
) {
    fun toWireMap(): Map<String, Any?> =
        buildMap {
            put("ip", ip)
            put("port", port)
            put("sessionId", sessionId)
            put("expiresAt", expiresAt.toInt())
            if (token != null) put("token", token)
            if (resumeToken != null) put("resumeToken", resumeToken)
            if (deviceManufacturer != null) put("deviceManufacturer", deviceManufacturer)
            if (deviceModel != null) put("deviceModel", deviceModel)
            if (deviceOs != null) put("deviceOs", deviceOs)
            if (linkPin != null) put("linkPin", linkPin)
        }
}

/**
 * Owns everything the JS `createCordieriteClient` (`packages/react-native/src/client/index.ts`)
 * used to own, on top of [CordieriteConnectionManager]/[CordieriteTransport]: the claim/resume
 * handshake, full-jitter reconnect, the grace timer, lease restore, the tool registry and its
 * snapshot/delta sync, and per-call tool invocation (timeout/cancel/progress/error classification).
 * See `docs/tasks/16-android-session-logic.md` for the threading model and design notes.
 *
 * Every state mutation -- whether triggered by a public suspend call or by a transport callback --
 * runs on [dispatcher], a single-threaded confinement (mirroring [CordieriteConnectionManager]'s
 * own single-thread executor), so there is never a data race between e.g. a `connect()` call and an
 * in-flight socket callback.
 */
internal class CordieriteClient private constructor(
    private val defaultToolTimeoutMs: Long,
    private val transportFactory: (
        emitStateChange: (String) -> Unit,
        emitMessageRaw: (String) -> Unit,
        emitError: (CordieriteErrorDetails) -> Unit,
        emitClose: (Map<String, Any?>) -> Unit,
    ) -> CordieriteTransport,
    private val lifecycleObserverFactory: (onBackgroundedChanged: (Boolean) -> Unit) -> CordieriteAppLifecycleObserver,
) {
    /** Real entry point: the transport is a real [CordieriteConnectionManager] over [context], and
     * foreground/background is observed via [CordieriteProcessLifecycleObserver]. */
    constructor(context: Context, defaultToolTimeoutMs: Long = CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS) : this(
        defaultToolTimeoutMs,
        { onState: (String) -> Unit, onMessage: (String) -> Unit, onError: (CordieriteErrorDetails) -> Unit, onClose: (Map<String, Any?>) -> Unit ->
            CordieriteConnectionManager(context, onState, onMessage, onError, onClose)
        },
        { onChange: (Boolean) -> Unit -> CordieriteProcessLifecycleObserver(onChange) },
    )

    /** Test-only entry point: substitutes a scripted [CordieriteTransport] and, by default, a
     * [CordieriteAppLifecycleObserver] that never reports backgrounded, so the whole client is
     * exercisable on the plain JVM with no `Context`, no OkHttp, and no Robolectric. */
    internal constructor(
        transportFactory: (
            emitStateChange: (String) -> Unit,
            emitMessageRaw: (String) -> Unit,
            emitError: (CordieriteErrorDetails) -> Unit,
            emitClose: (Map<String, Any?>) -> Unit,
        ) -> CordieriteTransport,
        defaultToolTimeoutMs: Long = CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS,
        lifecycleObserverFactory: (onBackgroundedChanged: (Boolean) -> Unit) -> CordieriteAppLifecycleObserver =
            { CordieriteNoopLifecycleObserver() },
    ) : this(
        defaultToolTimeoutMs,
        transportFactory,
        lifecycleObserverFactory,
    )

    @OptIn(ExperimentalCoroutinesApi::class)
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val transport: CordieriteTransport =
        transportFactory(
            { /* raw transport-level stateChange is not surfaced; unified state below is authoritative */ },
            ::onTransportMessageRaw,
            ::onTransportErrorRaw,
            ::onTransportCloseRaw,
        )

    private val registry = CordieriteToolRegistry()
    private val toolInvoker =
        CordieriteToolInvoker(
            scope = scope,
            registry = registry,
            getSessionId = { heldSession?.sessionId },
            sendWire = { json -> rawSend(json) },
            onError = { error -> emitError(error) },
            defaultTimeoutMs = defaultToolTimeoutMs,
        )

    @Volatile private var clientState: CordieriteClientState = CordieriteClientState.idle

    @Volatile private var heldSession: HeldSession? = null

    /** The session an in-flight `connect()` is claiming, before any ack sets [heldSession]. */
    @Volatile private var connectingSessionId: String? = null

    private var epoch = 0
    private var pendingAttempt: CompletableDeferred<JSONObject>? = null
    private var reconnectAttempt = 0
    private var reconnectJob: Job? = null
    private var graceJob: Job? = null
    private var resumeInFlight = false
    private var destroyed = false

    private val lifecycleObserver: CordieriteAppLifecycleObserver =
        lifecycleObserverFactory { nowBackground -> scope.launch { onBackgroundedChanged(nowBackground) } }

    @Volatile private var backgrounded: Boolean = lifecycleObserver.currentlyBackgrounded()

    private val stateChangeListeners = CopyOnWriteArrayList<CordieriteStateChangeListener>()
    private val sessionChangeListeners = CopyOnWriteArrayList<CordieriteSessionChangeListener>()
    private val errorListeners = CopyOnWriteArrayList<CordieriteErrorListener>()

    // --- public surface ---

    /** `"idle" | "connecting" | "active" | "reconnecting" | "closed"`. */
    val state: CordieriteClientState get() = clientState

    /** The session currently held, or the one an in-flight `connect()` is claiming, or `null`. */
    val sessionId: String? get() = heldSession?.sessionId ?: connectingSessionId

    /** Registered tool descriptors, in registration order. */
    val registeredTools: List<CordieriteToolDescriptor> get() = registry.descriptors()

    /** Effective trust/pin configuration this build was compiled with -- see `getConstants()` on
     * the frozen TurboModule spec. */
    val buildConfig: CordieriteBuildConfig get() = transport.getBuildConfig()

    fun addStateChangeListener(listener: CordieriteStateChangeListener): CordieriteSubscription {
        stateChangeListeners.add(listener)
        return CordieriteSubscription { stateChangeListeners.remove(listener) }
    }

    fun addSessionChangeListener(listener: CordieriteSessionChangeListener): CordieriteSubscription {
        sessionChangeListeners.add(listener)
        return CordieriteSubscription { sessionChangeListeners.remove(listener) }
    }

    fun addErrorListener(listener: CordieriteErrorListener): CordieriteSubscription {
        errorListeners.add(listener)
        return CordieriteSubscription { errorListeners.remove(listener) }
    }

    /**
     * Registers (or replaces, by name) a tool -- validates per PROTOCOL.md §5, throwing
     * [CordieriteInvalidToolDescriptorException] on an invalid descriptor. Upsert by name;
     * registration order is preserved across a re-registration. Sends `tool_registry_delta` when
     * the session is active (best-effort, fire-and-forget, like the JS client).
     */
    fun registerTool(
        descriptor: CordieriteToolDescriptor,
        handler: CordieriteToolHandler,
    ) {
        val delta = registry.upsert(descriptor, handler)
        sendDeltaIfActive(delta)
    }

    /** No-op for an unregistered name. */
    fun unregisterTool(name: String) {
        val delta = registry.remove(name) ?: return
        sendDeltaIfActive(delta)
    }

    /**
     * Feeds a deep link to the core (`deep-link-core.ts`'s `handleCordieriteDeepLinkUrl`). Returns
     * `true` iff the URL carried a `cordierite` query param -- whatever the parse outcome; a bad
     * payload is reported on the `error` listener (phase `"bootstrap"`) asynchronously. `false` for
     * any other URL, so the caller can route it itself. A parsed, valid payload supersedes whatever
     * session is currently held or being claimed, except a re-delivery of the same session, which
     * is ignored (its claim token is single-use).
     */
    fun handleUrl(url: String): Boolean {
        if (!hasCordieriteBootstrapQuery(url)) {
            return false
        }
        scope.launch { handleUrlInternal(url) }
        return true
    }

    suspend fun connect(
        input: CordieriteConnectInput,
        supersede: Boolean = false,
    ) = withContext(dispatcher) {
        connectInternal(input, supersede)
    }

    /** Starts recovery from the transport's process-memory lease. Resolves `true` once a resume
     * attempt has been accepted and started -- it does not wait for the daemon's `session_ack`.
     * Resolves `false` when no valid, unexpired lease can be restored. */
    suspend fun restoreSession(): Boolean =
        withContext(dispatcher) {
            if (destroyed || heldSession != null ||
                (clientState != CordieriteClientState.idle && clientState != CordieriteClientState.closed)
            ) {
                return@withContext false
            }

            val record = transport.getResumeLeaseRecord()
            val lease = parseCordieriteResumeLease(record)
            if (lease == null) {
                if (record != null) transport.clearResumeLease()
                return@withContext false
            }

            val nowMs = System.currentTimeMillis()
            if (isCordieriteResumeLeaseExpired(lease, nowMs)) {
                transport.clearResumeLease()
                return@withContext false
            }

            val nativeState = transport.getState()
            if (nativeState == "connecting" || nativeState == "active") {
                return@withContext false
            }

            epoch += 1
            val myEpoch = epoch
            clearReconnectJob()
            clearGraceJob()
            reconnectAttempt = 0
            heldSession =
                HeldSession(
                    sessionId = lease.sessionId,
                    resumeToken = lease.resumeToken,
                    alias = lease.alias,
                    keepaliveIntervalS = lease.keepaliveIntervalS,
                    graceS = lease.graceS,
                    disconnectedAtMs = lease.disconnectedAtMs ?: nowMs,
                    ip = lease.ip,
                    port = lease.port,
                )
            setClientState(CordieriteClientState.reconnecting, null)
            scheduleGraceExpiry(myEpoch)
            scope.launch { attemptResume(myEpoch) }
            true
        }

    suspend fun disconnect() =
        withContext(dispatcher) {
            epoch += 1
            clearReconnectJob()
            clearGraceJob()

            val hadSession = heldSession != null
            heldSession = null
            connectingSessionId = null
            resumeInFlight = false
            transport.clearResumeLease()

            settlePendingAttempt(Result.failure(IllegalStateException("Cordierite client was closed.")))

            setClientState(CordieriteClientState.closed, "closed_by_app")
            if (hadSession) emitSessionChange("lost", null, null, "closed_by_app")

            closeTransport()
        }

    /** Best-effort: drops (never throws) while no session is active; send failures are reported on
     * the `error` listener (phase `"socket"`). */
    suspend fun postEvent(
        name: String,
        payload: Any?,
    ) = withContext(dispatcher) {
        val session = heldSession
        if (clientState != CordieriteClientState.active || session == null) {
            return@withContext
        }

        val message =
            JSONObject()
                .put("type", "event")
                .put("session_id", session.sessionId)
                .put("name", name)
        if (payload != null) {
            try {
                message.put("payload", cordieriteToJsonValue(payload))
            } catch (_: IllegalArgumentException) {
                // Unserializable payload: drop the key, matching `undefined` being omitted on the
                // JS side rather than failing the whole event.
            }
        }
        message.put("ts", System.currentTimeMillis())

        try {
            rawSend(message.toString())
        } catch (e: Throwable) {
            emitError(CordieriteUnifiedError(phase = "socket", message = "Failed to send event \"$name\".", cause = e))
        }
    }

    /** Removes every listener, cancels in-flight work, and releases the transport. Idempotent. */
    fun destroy() {
        if (destroyed) return
        destroyed = true
        reconnectJob?.cancel()
        reconnectJob = null
        graceJob?.cancel()
        graceJob = null
        pendingAttempt?.completeExceptionally(IllegalStateException("Cordierite client was destroyed."))
        pendingAttempt = null
        toolInvoker.abortAllInFlight()
        lifecycleObserver.dispose()
        transport.invalidate {}
        scope.cancel()
    }

    // --- connect/handshake ---

    private suspend fun connectInternal(
        input: CordieriteConnectInput,
        supersede: Boolean,
    ) {
        if (destroyed) throw IllegalStateException("Cordierite client was destroyed.")

        val options = toConnectOptionsInternal(input)
        val nowSeconds = System.currentTimeMillis() / 1000
        if (!isConnectOptionsValid(options, nowSeconds)) {
            throw IllegalArgumentException("Invalid or expired Cordierite bootstrap payload.")
        }

        val nativeState = transport.getState()
        val supersedingReconnect = clientState == CordieriteClientState.reconnecting || supersede
        if ((nativeState == "connecting" || nativeState == "active") && !supersedingReconnect) {
            throw IllegalStateException("A Cordierite session is already connecting or active.")
        }

        epoch += 1
        val myEpoch = epoch
        clearReconnectJob()
        clearGraceJob()
        reconnectAttempt = 0
        heldSession = null
        connectingSessionId = options.sessionId
        resumeInFlight = false
        transport.clearResumeLease()

        if (supersedingReconnect) {
            settlePendingAttempt(
                Result.failure(IllegalStateException("Cordierite recovery was superseded by a fresh connection.")),
            )
        }

        try {
            if (supersedingReconnect && (nativeState == "connecting" || nativeState == "active")) {
                closeTransport()
            }
            setClientState(CordieriteClientState.connecting, null)
            val ack = performHandshake(options)

            if (myEpoch != epoch) {
                // Superseded by a newer connect()/handleUrl() while awaiting the ack; abandon
                // silently -- the newer attempt owns `connectingSessionId` now.
                return
            }

            connectingSessionId = null
            onAckReceived(ack, "claimed", options.ip, options.port)
        } catch (e: Throwable) {
            if (myEpoch == epoch) {
                connectingSessionId = null
                setClientState(CordieriteClientState.closed, "connect_error")
                emitError(
                    CordieriteUnifiedError(
                        phase = "connect",
                        message = e.message ?: "Cordierite connect failed.",
                        cause = e,
                    ),
                )
            }
            throw e
        }
    }

    private suspend fun handleUrlInternal(url: String) {
        val nowSeconds = System.currentTimeMillis() / 1000
        val allowPrivateLanOnly =
            try {
                transport.getBuildConfig().allowPrivateLanOnly
            } catch (_: Throwable) {
                true
            }

        val parsed =
            try {
                parseCordieriteBootstrapUrl(url, nowSeconds, requirePrivateIp = allowPrivateLanOnly)
            } catch (e: Throwable) {
                emitError(CordieriteUnifiedError(phase = "bootstrap", message = e.message ?: "Cordierite bootstrap error.", cause = e))
                return
            }

        withContext(dispatcher) {
            val holdsSession = clientState == CordieriteClientState.connecting || clientState == CordieriteClientState.active
            val heldSessionIdNow = heldSession?.sessionId ?: connectingSessionId

            if (holdsSession && heldSessionIdNow == parsed.payload.sessionId) {
                // A link for the session already held is ignored, not re-claimed: its token is
                // single-use, and re-claiming would trade a healthy session for a terminal
                // `already_claimed` rejection.
                return@withContext
            }

            try {
                connectInternal(CordieriteConnectInput.Bootstrap(parsed.payload, parsed.linkPin), supersede = holdsSession)
            } catch (e: Throwable) {
                emitError(CordieriteUnifiedError(phase = "bootstrap", message = e.message ?: "Cordierite bootstrap error.", cause = e))
            }
        }
    }

    private fun toConnectOptionsInternal(input: CordieriteConnectInput): ConnectOptionsInternal =
        when (input) {
            is CordieriteConnectInput.Explicit ->
                ConnectOptionsInternal(
                    ip = input.ip,
                    port = input.port,
                    sessionId = input.sessionId,
                    token = input.token,
                    resumeToken = input.resumeToken,
                    expiresAt = input.expiresAt,
                    deviceManufacturer = input.deviceManufacturer,
                    deviceModel = input.deviceModel,
                    deviceOs = input.deviceOs,
                    linkPin = input.linkPin,
                )
            is CordieriteConnectInput.Bootstrap ->
                ConnectOptionsInternal(
                    ip = input.payload.address,
                    port = input.payload.port,
                    sessionId = input.payload.sessionId,
                    token = input.payload.token,
                    resumeToken = null,
                    expiresAt = input.payload.expiresAt,
                    deviceManufacturer = null,
                    deviceModel = null,
                    deviceOs = null,
                    linkPin = input.linkPin,
                )
        }

    private fun isConnectOptionsValid(
        options: ConnectOptionsInternal,
        nowSeconds: Long,
    ): Boolean {
        val hasClaimToken = !options.token.isNullOrEmpty()
        val hasResumeToken = !options.resumeToken.isNullOrEmpty()
        return options.ip.isNotEmpty() &&
            options.port in 1..65535 &&
            options.sessionId.isNotEmpty() &&
            (hasClaimToken || hasResumeToken) &&
            !isCordieriteBootstrapExpired(options.expiresAt, nowSeconds)
    }

    private suspend fun performHandshake(options: ConnectOptionsInternal): JSONObject {
        val deferred = CompletableDeferred<JSONObject>()
        pendingAttempt = deferred
        try {
            connectTransport(options.toWireMap())
        } catch (e: Throwable) {
            settlePendingAttempt(Result.failure(e))
        }
        return deferred.await()
    }

    private fun settlePendingAttempt(result: Result<JSONObject>): Boolean {
        val attempt = pendingAttempt ?: return false
        pendingAttempt = null
        if (result.isSuccess) {
            attempt.complete(result.getOrThrow())
        } else {
            attempt.completeExceptionally(result.exceptionOrNull()!!)
        }
        return true
    }

    private fun onAckReceived(
        ack: JSONObject,
        kind: String,
        endpointIp: String,
        endpointPort: Int,
    ) {
        clearReconnectJob()
        clearGraceJob()
        reconnectAttempt = 0
        resumeInFlight = false

        val sessionId = ack.getString("session_id")
        val alias = ack.getString("alias")
        heldSession =
            HeldSession(
                sessionId = sessionId,
                resumeToken = ack.getString("resume_token"),
                alias = alias,
                keepaliveIntervalS = ack.getDouble("keepalive_interval_s"),
                graceS = ack.getDouble("grace_s"),
                disconnectedAtMs = null,
                ip = endpointIp,
                port = endpointPort,
            )

        setClientState(CordieriteClientState.active, null)
        emitSessionChange(kind, sessionId, alias)

        scope.launch { sendSnapshotSafely() }
    }

    // --- reconnect / grace / lease restore ---

    private suspend fun attemptResume(myEpoch: Int) {
        if (resumeInFlight || destroyed || myEpoch != epoch) return
        val session = heldSession ?: return

        val nowMs = System.currentTimeMillis()
        val disconnectedAtMs = session.disconnectedAtMs ?: nowMs
        session.disconnectedAtMs = disconnectedAtMs
        if (nowMs - disconnectedAtMs >= (session.graceS * 1000).toLong()) {
            finalizeSessionLost("grace_expired")
            return
        }

        resumeInFlight = true
        val nowSeconds = nowMs / 1000
        val options =
            ConnectOptionsInternal(
                ip = session.ip,
                port = session.port,
                sessionId = session.sessionId,
                token = null,
                resumeToken = session.resumeToken,
                // Comfortably past native's own expiry guard, independent of the original claim.
                expiresAt = nowSeconds + maxOf(session.graceS.toLong(), 60L) + 60L,
                deviceManufacturer = null,
                deviceModel = null,
                deviceOs = null,
                linkPin = null,
            )

        val ack: JSONObject
        try {
            ack = performHandshake(options)
        } catch (e: Throwable) {
            resumeInFlight = false
            if (myEpoch != epoch || destroyed) return

            emitError(CordieriteUnifiedError(phase = "socket", message = "Cordierite resume attempt failed.", cause = e))

            if (e is CordieriteHandshakeClosedException && isCordieriteTerminalCloseCode(e.code)) {
                // The daemon rejected the resume itself. Retrying the identical frame until the
                // grace window elapses would leave the app "reconnecting" for up to `grace_s` --
                // minutes -- before ever reporting the session lost. Finalize now instead.
                finalizeSessionLost(cordieriteTerminalCloseReason(e.reason))
                return
            }

            scheduleReconnectAttempt(myEpoch)
            return
        }

        resumeInFlight = false
        if (myEpoch != epoch || destroyed) return
        onAckReceived(ack, "resumed", session.ip, session.port)
    }

    private fun scheduleReconnectAttempt(myEpoch: Int) {
        if (myEpoch != epoch || destroyed || heldSession == null) return

        setClientState(CordieriteClientState.reconnecting, null)

        if (backgrounded) {
            // No timer while backgrounded: the socket stays as the OS left it, and returning to
            // the foreground triggers an immediate attempt (see `onBackgroundedChanged`).
            return
        }

        val delayMs = computeCordieriteFullJitterBackoffMs(reconnectAttempt)
        reconnectAttempt += 1

        reconnectJob =
            scope.launch {
                delay(delayMs)
                reconnectJob = null
                attemptResume(myEpoch)
            }
    }

    private fun scheduleGraceExpiry(myEpoch: Int) {
        if (graceJob != null) return
        val session = heldSession ?: return

        val nowMs = System.currentTimeMillis()
        val disconnectedAtMs = session.disconnectedAtMs ?: nowMs
        session.disconnectedAtMs = disconnectedAtMs
        val remainingGraceMs = (session.graceS * 1000).toLong() - (nowMs - disconnectedAtMs)

        graceJob =
            scope.launch {
                delay(maxOf(remainingGraceMs, 0L))
                graceJob = null
                if (myEpoch == epoch && heldSession != null) {
                    finalizeSessionLost("grace_expired")
                }
            }
    }

    private fun finalizeSessionLost(reason: String) {
        val sessionId = heldSession?.sessionId

        epoch += 1
        clearReconnectJob()
        clearGraceJob()
        heldSession = null
        resumeInFlight = false
        transport.clearResumeLease()

        settlePendingAttempt(Result.failure(IllegalStateException("Cordierite session was lost: $reason.")))

        setClientState(CordieriteClientState.closed, reason)
        if (sessionId != null) emitSessionChange("lost", null, null, reason)
    }

    private suspend fun onBackgroundedChanged(nowBackground: Boolean) {
        if (nowBackground == backgrounded) return
        backgrounded = nowBackground

        if (nowBackground) {
            clearReconnectJob()
            return
        }

        if (heldSession != null && clientState == CordieriteClientState.reconnecting && !resumeInFlight) {
            clearReconnectJob()
            attemptResume(epoch)
        }
    }

    // --- transport callback routing ---

    private fun onTransportMessageRaw(text: String) {
        scope.launch { onTransportMessage(text) }
    }

    private fun onTransportMessage(text: String) {
        val json =
            try {
                JSONObject(text)
            } catch (_: Throwable) {
                return
            }

        if (isSessionAckJson(json)) {
            settlePendingAttempt(Result.success(json))
            return
        }

        when (json.optString("type")) {
            "tool_call" -> {
                val id = json.optString("id")
                val name = json.optString("name")
                val args = json.optJSONObject("args") ?: JSONObject()
                if (id.isNotEmpty() && name.isNotEmpty()) {
                    toolInvoker.handleToolCall(id, name, args)
                }
            }
            "tool_cancel" -> {
                val id = json.optString("id")
                if (id.isNotEmpty()) toolInvoker.handleToolCancel(id)
            }
            else -> Unit
        }
    }

    private fun isSessionAckJson(json: JSONObject): Boolean {
        if (json.optString("type") != "session_ack" || json.optString("status") != "ok") return false
        val sessionId = json.opt("session_id") as? String
        val alias = json.opt("alias") as? String
        val resumeToken = json.opt("resume_token") as? String
        val keepalive = json.opt("keepalive_interval_s")
        val grace = json.opt("grace_s")
        return !sessionId.isNullOrEmpty() && !alias.isNullOrEmpty() && !resumeToken.isNullOrEmpty() &&
            keepalive is Number && grace is Number
    }

    @Volatile private var lastErrorEvent: CordieriteErrorDetails? = null

    private fun onTransportErrorRaw(details: CordieriteErrorDetails) {
        scope.launch { lastErrorEvent = details }
    }

    private fun onTransportCloseRaw(payload: Map<String, Any?>) {
        scope.launch { onTransportClose(payload) }
    }

    private suspend fun onTransportClose(payload: Map<String, Any?>) {
        val code = payload["code"] as? Int
        val reason = payload["reason"] as? String
        val errorEvent = lastErrorEvent
        lastErrorEvent = null

        val settled =
            settlePendingAttempt(
                Result.failure(
                    CordieriteHandshakeClosedException(
                        reason ?: errorEvent?.message ?: "Cordierite connection closed.",
                        code,
                        reason,
                    ),
                ),
            )
        if (settled) return

        onSocketLost(code, reason, errorEvent)
    }

    private fun onSocketLost(
        code: Int?,
        reason: String?,
        lastError: CordieriteErrorDetails?,
    ) {
        if (destroyed) return

        // The socket is gone, so no `tool_cancel` frame could ever be delivered for whatever was
        // still in flight -- abort it directly rather than leaving handlers running with no owner.
        toolInvoker.abortAllInFlight()

        val myEpoch = epoch
        val session = heldSession

        if (session == null) {
            setClientState(CordieriteClientState.closed, "socket_closed")
            return
        }

        if (code == 1000) {
            finalizeSessionLost("revoked")
            return
        }

        emitError(
            CordieriteUnifiedError(
                phase = "socket",
                message = reason ?: lastError?.message ?: "Cordierite connection lost.",
                code = lastError?.code,
                nativeCode = lastError?.nativeCode,
                closeReason = reason,
                isRetryable = lastError?.isRetryable,
                hint = lastError?.hint,
            ),
        )

        if (isCordieriteTerminalCloseCode(code)) {
            // A policy-violation close mid-session is as unresumable as one during the handshake.
            finalizeSessionLost(cordieriteTerminalCloseReason(reason))
            return
        }

        val nowMs = System.currentTimeMillis()
        val disconnectedAtMs = session.disconnectedAtMs ?: nowMs
        session.disconnectedAtMs = disconnectedAtMs
        if (nowMs - disconnectedAtMs >= (session.graceS * 1000).toLong()) {
            finalizeSessionLost("grace_expired")
            return
        }

        scheduleGraceExpiry(myEpoch)
        scheduleReconnectAttempt(myEpoch)
    }

    // --- wire helpers ---

    private suspend fun sendSnapshotSafely() {
        if (clientState != CordieriteClientState.active) return
        val session = heldSession ?: return

        val tools = JSONArray()
        for (tool in registry.snapshotWireJson()) tools.put(tool)

        val message =
            JSONObject()
                .put("type", "tool_registry_snapshot")
                .put("session_id", session.sessionId)
                .put("tools", tools)

        try {
            rawSend(message.toString())
        } catch (e: Throwable) {
            emitError(CordieriteUnifiedError(phase = "tool", message = "Failed to send the tool registry snapshot.", cause = e))
        }
    }

    private fun sendDeltaIfActive(delta: CordieriteRegistryDelta) {
        scope.launch {
            if (clientState != CordieriteClientState.active) return@launch
            val session = heldSession ?: return@launch

            val json =
                JSONObject()
                    .put("type", "tool_registry_delta")
                    .put("session_id", session.sessionId)

            when (delta) {
                is CordieriteRegistryDelta.Upsert -> json.put("operation", "upsert").put("tool", delta.descriptor.toWireJson())
                is CordieriteRegistryDelta.Remove -> json.put("operation", "remove").put("name", delta.name)
            }

            try {
                rawSend(json.toString())
            } catch (e: Throwable) {
                emitError(CordieriteUnifiedError(phase = "tool", message = "Failed to sync the tool registry.", cause = e))
            }
        }
    }

    private suspend fun rawSend(json: String) =
        suspendCancellableCoroutine<Unit> { cont ->
            transport.send(json) { error ->
                if (error != null) cont.resumeWithException(error) else cont.resume(Unit)
            }
        }

    private suspend fun connectTransport(map: Map<String, Any?>) =
        suspendCancellableCoroutine<Unit> { cont ->
            transport.connect(map) { error ->
                if (error != null) cont.resumeWithException(error) else cont.resume(Unit)
            }
        }

    private suspend fun closeTransport() =
        suspendCancellableCoroutine<Unit> { cont ->
            transport.close { cont.resume(Unit) }
        }

    // --- listener emission / state ---

    private fun setClientState(
        next: CordieriteClientState,
        reason: String?,
    ) {
        if (clientState == next && reason == null) return
        clientState = next
        for (listener in stateChangeListeners) listener(next, reason)
    }

    private fun emitSessionChange(
        type: String,
        sessionId: String?,
        alias: String?,
        reason: String? = null,
    ) {
        for (listener in sessionChangeListeners) listener(type, sessionId, alias, reason)
    }

    private fun emitError(error: CordieriteUnifiedError) {
        for (listener in errorListeners) listener(error)
    }

    private fun clearReconnectJob() {
        reconnectJob?.cancel()
        reconnectJob = null
    }

    private fun clearGraceJob() {
        graceJob?.cancel()
        graceJob = null
    }
}
