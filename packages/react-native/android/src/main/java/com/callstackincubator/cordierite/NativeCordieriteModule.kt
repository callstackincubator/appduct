package com.callstackincubator.cordierite

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.ConcurrentHashMap

/**
 * Bridges the frozen phase-2 TurboModule spec (`NativeCordierite.ts`,
 * docs/tasks/16-android-session-logic.md) onto [CordieriteClient]. Every structured value crosses
 * the bridge as a JSON string -- [CordieriteClient] already speaks `org.json` internally, so this
 * class only (de)serializes at the two edges Codegen cares about: tool descriptors/connect input in,
 * events/getters out.
 *
 * `registerTool` hands [CordieriteClient] a handler that: emits `onToolCall`, suspends on a
 * [CompletableDeferred] keyed by call id, and is completed by [respondToToolCall]. Cancellation
 * (a `tool_cancel` wire frame, or the session suspending) reaches this handler as an ordinary
 * kotlinx.coroutines `CancellationException` on the suspended `await()` -- caught here just long
 * enough to emit `onToolCancel` before rethrowing (coroutines require a `CancellationException` to
 * always propagate).
 */
@ReactModule(name = NativeCordieriteSpec.NAME)
class NativeCordieriteModule(
    reactContext: ReactApplicationContext,
) : NativeCordieriteSpec(reactContext) {
    /** Everything here is fire-and-forget bridging between the TurboModule call and
     * [CordieriteClient]'s own suspend API -- [CordieriteClient] internally confines its real state
     * to a single dispatcher, so this scope only needs to host the coroutines, not synchronize them. */
    private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private data class PendingToolCall(
        val deferred: CompletableDeferred<Pair<String?, String?>>,
        val reportProgress: suspend (Double?, String?) -> Unit,
    )

    private val pendingToolCalls = ConcurrentHashMap<String, PendingToolCall>()

    private val client = CordieriteClient(reactContext)

    init {
        client.addStateChangeListener { state, reason ->
            emitOnStateChange(
                Arguments.createMap().apply {
                    putString("state", state.name)
                    if (reason != null) putString("reason", reason)
                },
            )
        }
        client.addSessionChangeListener { sessionId, alias ->
            emitOnSessionChange(
                Arguments.createMap().apply {
                    if (sessionId != null) putString("sessionId", sessionId) else putNull("sessionId")
                    if (alias != null) putString("alias", alias) else putNull("alias")
                },
            )
        }
        client.addErrorListener { error ->
            emitOnError(
                Arguments.createMap().apply {
                    putString("phase", error.phase)
                    putString("message", error.message)
                    if (error.code != null) putString("code", error.code)
                    if (error.nativeCode != null) putString("nativeCode", error.nativeCode)
                    if (error.closeReason != null) putString("closeReason", error.closeReason)
                    if (error.isRetryable != null) putBoolean("isRetryable", error.isRetryable)
                    if (error.hint != null) putString("hint", error.hint)
                    if (error.toolName != null) putString("toolName", error.toolName)
                    if (error.invocationId != null) putString("invocationId", error.invocationId)
                },
            )
        }
    }

    override fun registerTool(descriptorJson: String) {
        val descriptor = parseToolDescriptorJson(descriptorJson)
        // Throws CordieriteInvalidToolDescriptorException synchronously for an invalid descriptor,
        // matching the spec's doc comment ("native validates it ... and throws on an invalid one").
        client.registerTool(descriptor) { args, context ->
            val deferred = CompletableDeferred<Pair<String?, String?>>()
            pendingToolCalls[context.callId] =
                PendingToolCall(deferred) { progress, message -> context.reportProgress(progress, message) }

            emitOnToolCall(
                Arguments.createMap().apply {
                    putString("id", context.callId)
                    putString("name", context.toolName)
                    putString("argsJson", args.toString())
                },
            )

            try {
                val (resultJson, errorJson) = deferred.await()

                if (errorJson != null) {
                    val errorObj = JSONObject(errorJson)
                    throw CordieriteToolReplyError(
                        errorType = errorObj.optString("type", "tool_execution_error"),
                        message = errorObj.optString("message", "Cordierite tool execution failed."),
                        details = if (errorObj.has("details")) errorObj.opt("details") else null,
                    )
                }

                if (resultJson == null) {
                    null
                } else {
                    JSONTokener(resultJson).nextValue()
                }
            } catch (e: CancellationException) {
                // The frozen spec's `onToolCancel.reason`: the core's own timeout is a
                // `TimeoutCancellationException`; every other cancellation carries its reason as the
                // exception message (`client_cancelled`, `session_suspended`, or the wire
                // `tool_cancel.reason`).
                val reason = if (e is TimeoutCancellationException) "timeout" else e.message ?: "client_cancelled"
                emitOnToolCancel(
                    Arguments.createMap().apply {
                        putString("id", context.callId)
                        putString("reason", reason)
                    },
                )
                throw e
            } finally {
                pendingToolCalls.remove(context.callId)
            }
        }
    }

    override fun unregisterTool(name: String) {
        client.unregisterTool(name)
    }

    override fun handleUrl(url: String): Boolean = client.handleUrl(url)

    override fun connect(
        inputJson: String,
        supersede: Boolean,
        promise: Promise,
    ) {
        val input =
            try {
                parseConnectInputJson(inputJson)
            } catch (e: Exception) {
                promise.reject("E_CORDIERITE", e.message, e)
                return
            }

        moduleScope.launch {
            try {
                client.connect(input, supersede)
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.reject("E_CORDIERITE", e.message, e)
            }
        }
    }

    override fun restoreSession(promise: Promise) {
        moduleScope.launch {
            try {
                promise.resolve(client.restoreSession())
            } catch (e: Throwable) {
                promise.reject("E_CORDIERITE", e.message, e)
            }
        }
    }

    override fun disconnect(promise: Promise) {
        moduleScope.launch {
            try {
                client.disconnect()
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.reject("E_CORDIERITE", e.message, e)
            }
        }
    }

    override fun postEvent(
        name: String,
        payloadJson: String?,
        promise: Promise,
    ) {
        moduleScope.launch {
            // [CordieriteClient.postEvent] is itself best-effort (silently a no-op while no session
            // is active, for the benefit of a plain-app caller), but the RN bridge's JS contract
            // needs a distinguishable rejection here -- see client/index.ts's postEvent, which turns
            // this exact code into a dev-only warning instead of surfacing an `error` event, mirroring
            // the iOS bridge's `E_CORDIERITE_NOT_ACTIVE` (`CordieriteClient.CordieriteNotActiveError`).
            if (client.state.name != "active" || client.sessionId == null) {
                promise.reject(
                    "E_CORDIERITE_NOT_ACTIVE",
                    "Cordierite postEvent(\"$name\") dropped: no active Cordierite session.",
                )
                return@launch
            }

            try {
                val payload = payloadJson?.let { JSONTokener(it).nextValue() }
                client.postEvent(name, payload)
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.reject("E_CORDIERITE", e.message, e)
            }
        }
    }

    override fun respondToToolCall(
        id: String,
        resultJson: String?,
        errorJson: String?,
    ) {
        // A no-op for an unknown or already-finished id, matching the spec's doc comment.
        pendingToolCalls[id]?.deferred?.complete(resultJson to errorJson)
    }

    override fun reportToolProgress(
        id: String,
        progress: Double?,
        message: String?,
    ) {
        val pending = pendingToolCalls[id] ?: return
        moduleScope.launch { pending.reportProgress(progress, message) }
    }

    override fun getState(): String = client.state.name

    override fun getSessionId(): String? = client.sessionId

    override fun getRegisteredToolsJson(): String {
        val array = JSONArray()
        for (tool in client.registeredTools) array.put(tool.toWireJson())
        return array.toString()
    }

    // Codegen special-cases `getConstants()` (legacy bridge constants export) and generates a
    // `final` implementation on `NativeCordieriteSpec` that validates and forwards this method's
    // return value instead -- see the generated `NativeCordieriteSpec.getConstants()`.
    override fun getTypedExportedConstants(): MutableMap<String, Any> {
        val config = client.buildConfig
        return mutableMapOf(
            "trust" to config.trust,
            "hasEmbeddedPins" to config.hasEmbeddedPins,
            "allowPrivateLanOnly" to config.allowPrivateLanOnly,
        )
    }

    override fun invalidate() {
        client.destroy()
        super.invalidate()
    }
}

private fun JSONObject.optStringOrNull(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null

private fun parseToolDescriptorJson(json: String): CordieriteToolDescriptor {
    val obj =
        try {
            JSONObject(json)
        } catch (e: Exception) {
            throw CordieriteInvalidToolDescriptorException("Tool descriptor must be a JSON object.")
        }

    val name = obj.optString("name", "")

    fun optionalObject(key: String): JSONObject? {
        if (!obj.has(key) || obj.isNull(key)) return null
        return obj.optJSONObject(key)
            ?: throw CordieriteInvalidToolDescriptorException("Tool \"$name\" $key must be a JSON object.")
    }

    // Same rule as `@cordierite/shared`'s `isToolDescriptor` and the Swift bridge: an integer only.
    // A fractional value is rejected here rather than truncated, so all three bridges agree with
    // packages/native/fixtures/tool-descriptors.json.
    val timeoutMs: Long? =
        if (obj.has("timeout_ms") && !obj.isNull("timeout_ms")) {
            when (val raw = obj.opt("timeout_ms")) {
                is Int -> raw.toLong()
                is Long -> raw
                is Number -> {
                    val asDouble = raw.toDouble()
                    if (asDouble.isFinite() && asDouble == Math.floor(asDouble)) {
                        asDouble.toLong()
                    } else {
                        throw CordieriteInvalidToolDescriptorException("Tool \"$name\" timeout_ms must be a positive integer.")
                    }
                }
                else -> throw CordieriteInvalidToolDescriptorException("Tool \"$name\" timeout_ms must be a positive integer.")
            }
        } else {
            null
        }

    return CordieriteToolDescriptor(
        name = name,
        description = obj.optString("description", ""),
        inputSchema = optionalObject("input_schema"),
        outputSchema = optionalObject("output_schema"),
        annotations = optionalObject("annotations"),
        timeoutMs = timeoutMs,
    )
}

/** `inputJson` is either a decoded v2 bootstrap payload (`family`/`address` present) or explicit
 * connect options (`ip` instead) -- see `NativeCordierite.ts`'s `connect` doc comment. */
private fun parseConnectInputJson(json: String): CordieriteConnectInput {
    val obj = JSONObject(json)

    return if (obj.has("family") && obj.has("address")) {
        CordieriteConnectInput.Bootstrap(
            payload =
                CordieriteBootstrapPayload(
                    family = obj.getInt("family"),
                    address = obj.getString("address"),
                    port = obj.getInt("port"),
                    sessionId = obj.getString("sessionId"),
                    token = obj.getString("token"),
                    expiresAt = obj.getLong("expiresAt"),
                ),
            linkPin = obj.optStringOrNull("linkPin"),
        )
    } else {
        CordieriteConnectInput.Explicit(
            ip = obj.getString("ip"),
            port = obj.getInt("port"),
            sessionId = obj.getString("sessionId"),
            token = obj.optStringOrNull("token"),
            resumeToken = obj.optStringOrNull("resumeToken"),
            expiresAt = obj.getLong("expiresAt"),
            deviceManufacturer = obj.optStringOrNull("deviceManufacturer"),
            deviceModel = obj.optStringOrNull("deviceModel"),
            deviceOs = obj.optStringOrNull("deviceOs"),
            linkPin = obj.optStringOrNull("linkPin"),
        )
    }
}
