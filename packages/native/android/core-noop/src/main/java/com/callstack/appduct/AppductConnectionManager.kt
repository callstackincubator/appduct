package com.callstack.appduct

import android.content.Context

/**
 * No-op mirror of `packages/native/android/core`'s real `AppductConnectionManager`
 * (docs/tasks/14-native-core-extraction.md, Decision 2). Same public class/method names and
 * signatures the RN bridge (`NativeAppductModule.kt`, vendored `android/core`|`core-noop`) and
 * any other consumer calls -- so a release build's `releaseImplementation(core-noop)` dependency
 * resolves to something source-compatible with `debugImplementation(core)` -- but every method does
 * nothing, no `okhttp3` dependency, and deliberately no `AppductNativeMarker` class: the marker's
 * entire purpose is to prove the *real* implementation shipped, so a stub copy here would defeat
 * `appduct doctor`'s detection.
 *
 * `getState()` always reports `"idle"` (never `"connecting"`/`"active"`), matching the choice
 * documented for the SwiftPM `AppductCore` package's iOS stub and the JS `/noop` entry's
 * `getAppductState()` -- a stub build never attempts a connection at all, so "idle" is the
 * honest representation. `getResumeLeaseRecord()` always returns `null`. `getBuildConfig()` reports
 * `trust = "excluded"`, a value no real trust resolution (`"pin"`/`"link"`/an echoed invalid
 * config string) ever produces, so a caller can tell a stub build's build config apart from a real
 * one's at a glance.
 */
internal class AppductConnectionManager(
    context: Context,
    emitStateChange: (String) -> Unit,
    emitMessageRaw: (String) -> Unit,
    emitError: (AppductErrorDetails) -> Unit,
    emitClose: (Map<String, Any?>) -> Unit,
    ownerGeneration: Long = 0L,
) : AppductTransport {
    override fun connect(
        rawOptions: Map<String, Any?>,
        completion: (Throwable?) -> Unit,
    ) {
        completion(null)
    }

    override fun send(
        message: String,
        completion: (Throwable?) -> Unit,
    ) {
        completion(null)
    }

    override fun close(completion: () -> Unit) {
        completion()
    }

    override fun invalidate(completion: () -> Unit) {
        completion()
    }

    override fun getState(): String = "idle"

    override fun getResumeLeaseRecord(): Map<String, Any?>? = null

    override fun clearResumeLease(): Boolean = true

    override fun getBuildConfig(): AppductBuildConfig =
        AppductBuildConfig(trust = "excluded", hasEmbeddedPins = false, allowPrivateLanOnly = true)
}

internal data class AppductErrorDetails(
    val code: String,
    val message: String,
    val phase: String,
    val nativeCode: String? = null,
    val closeReason: String? = null,
    val isRetryable: Boolean? = null,
    val hint: String? = null,
)

internal data class AppductBuildConfig(
    val trust: String,
    val hasEmbeddedPins: Boolean,
    val allowPrivateLanOnly: Boolean,
)
