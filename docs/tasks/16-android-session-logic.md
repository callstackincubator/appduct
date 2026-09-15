# 16 — Move session logic into the Android core (Phase 2 of issue #48, Android half)

**Depends on:** `docs/tasks/14-native-core-extraction.md` (phase 1 layout: `packages/native/android`'s
`core`/`core-noop` split, `CordieriteConnectionManager`, the vendoring script). Runs in parallel with
the iOS/Swift half of phase 2 and the JS rewrite against the same frozen TurboModule spec
(`packages/react-native/src/NativeCordierite.ts`); this task covers only `packages/native/android`
and the Android half of `packages/react-native`.

## Goal

Port the TypeScript session-lifecycle/registry/tool-invocation logic (`client/index.ts`,
`backoff.ts`, `registry.ts`, `resume-lease.ts`, `terminal-close.ts`, `tool-invocation.ts`,
`bootstrap.ts`, `deep-link-core.ts`) into Kotlin, on top of the already-framework-free
`CordieriteConnectionManager`, so reconnect, grace, lease restore, registry snapshots/deltas,
timeouts, cancel, and progress live in `packages/native/android/core` once, shared by RN and (once
phase 3 publishes it) any plain Android app. Rewrite the Android bridge
(`packages/react-native/android`) to implement the frozen TurboModule spec on top of the new
`CordieriteClient` instead of talking to the transport directly.

## What's new in `packages/native/android/core`

| File | Owns |
| --- | --- |
| `CordieriteTransport.kt` | The seam `CordieriteClient` is built on -- extracted from `CordieriteConnectionManager`'s existing public surface with no signature changes. `CordieriteConnectionManager` now implements it. |
| `CordieriteClient.kt` | Everything the JS `createCordieriteClient` used to own: the claim/resume handshake, full-jitter reconnect, the grace timer, lease restore, registry snapshot/delta sync, foreground/background observation, and the public API below. |
| `CordieriteClientTypes.kt` | `CordieriteClientState`, `CordieriteToolDescriptor`, `CordieriteToolCallContext`, `CordieriteToolHandler`, `CordieriteUnifiedError`, `CordieriteConnectInput`, the three listener typealiases. |
| `CordieriteBootstrapCodec.kt` | Port of `@cordierite/shared`'s `decodeBootstrap` (PROTOCOL.md §2 binary layout) plus minimal, dependency-free query-string parsing for `hasCordieriteBootstrapQuery`/the deep link's `cordierite`+`pin` params -- no `android.net.Uri`, so it runs on the plain JVM without Robolectric. |
| `CordieriteBackoff.kt` | Exact port of `backoff.ts`'s full-jitter formula and constants (500 ms floor, 30 s cap). |
| `CordieriteTerminalClose.kt` | Port of `terminal-close.ts`: 1008 is the only terminal close code. |
| `CordieriteResumeLease.kt` | Port of `resume-lease.ts`'s `parseResumeLease`/`isResumeLeaseExpired`, applied to the `Map<String, Any?>` `CordieriteTransport.getResumeLeaseRecord()` already returns. |
| `CordieriteToolRegistry.kt` | Port of `registry.ts`'s validation (`isToolDescriptor`, PROTOCOL.md §5) and upsert-by-name/order-preserving table. |
| `CordieriteToolInvoker.kt` | Port of `tool-invocation.ts`'s per-call dispatch: timeout, cancel, progress, and the five wire error types the native SDK can produce without schema validation (`tool_not_found`, `tool_execution_error`, `tool_timeout`, `tool_cancelled`, `tool_serialization_error`). |
| `CordieriteJson.kt` | Converts a handler's return value into a JSON-ready `org.json` value, or throws for anything that cannot be represented (`tool_serialization_error`). |
| `CordieriteLifecycleObserver.kt` | `CordieriteProcessLifecycleObserver` (real, backed by `androidx.lifecycle:lifecycle-process`'s `ProcessLifecycleOwner`) and `CordieriteNoopLifecycleObserver` (tests). |

`core-noop` mirrors every new public declaration: `CordieriteClient` whose `state` is always
`"closed"`, `registerTool`/`unregisterTool` store nothing, `handleUrl` always returns `false`, no
listener ever fires, `connect()` rejects. No `okhttp3`, no `kotlinx.coroutines` -- the real
dependency graph is never on a release classpath that resolved `core-noop`.

## `CordieriteClient`'s public API

```kotlin
class CordieriteClient(context: Context, defaultToolTimeoutMs: Long = CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS)

fun registerTool(descriptor: CordieriteToolDescriptor, handler: CordieriteToolHandler)  // throws on an invalid descriptor
fun unregisterTool(name: String)
fun handleUrl(url: String): Boolean

suspend fun connect(input: CordieriteConnectInput, supersede: Boolean = false)
suspend fun restoreSession(): Boolean
suspend fun disconnect()
suspend fun postEvent(name: String, payload: Any?)

val state: CordieriteClientState        // idle | connecting | active | reconnecting | closed
val sessionId: String?
val registeredTools: List<CordieriteToolDescriptor>
val buildConfig: CordieriteBuildConfig  // trust / hasEmbeddedPins / allowPrivateLanOnly, from the transport

fun addStateChangeListener(listener: CordieriteStateChangeListener): CordieriteSubscription
fun addSessionChangeListener(listener: CordieriteSessionChangeListener): CordieriteSubscription
fun addErrorListener(listener: CordieriteErrorListener): CordieriteSubscription

fun destroy()  // idempotent; cancels in-flight work, invalidates the transport
```

`ToolHandler` is `suspend (args: JSONObject, context: CordieriteToolCallContext) -> Any?`.
`CordieriteToolCallContext` exposes `callId`, `toolName`, `sessionId`, and
`suspend fun reportProgress(progress: Double?, message: String?)`. There is no separate
cancellation token: cancellation is coroutine-native (see "Threading model" below) -- a handler
that calls further suspend functions observes the daemon's `tool_cancel` (or the session
suspending) as an ordinary `CancellationException`, exactly the way a JS handler observes
`context.signal` firing, except a Kotlin handler that ignores it and does no further suspending
work also just runs to completion, same as a JS handler ignoring `AbortSignal`.

## Threading model

Every state mutation -- whether triggered by a public `suspend` call or by a `CordieriteTransport`
callback arriving on the transport's own executor thread -- is confined to one dispatcher:
`Dispatchers.Default.limitedParallelism(1)`, mirroring `CordieriteConnectionManager`'s own
single-thread `Executor`. Public suspend functions enter it with `withContext(dispatcher)`;
transport callbacks (`emitMessageRaw`, `emitError`, `emitClose`) hop onto it with
`scope.launch { ... }`. This makes two concurrent `connect()` calls, or a `connect()` racing an
in-flight socket callback, deterministic without explicit locks -- the same property
`CordieriteConnectionManager`'s executor already gives the transport layer.

Tool handlers run as children of the same `scope` (so `abortAllInFlight()` can cancel every
in-flight call when the session suspends, without waiting on a `tool_cancel` frame that can never
arrive), but each call is its own coroutine, so one slow/stuck handler never blocks another call or
the client's own state machine. `registerTool`/`unregisterTool` are ordinary (non-suspend) calls an
app may make from any thread, so `CordieriteToolRegistry`'s table is separately `synchronized`
rather than dispatcher-confined.

## Lifecycle observation: `ProcessLifecycleOwner`

Chosen over `Application.ActivityLifecycleCallbacks` because it collapses "every Activity has
stopped" into one process-wide `ON_STOP`/`ON_START` pair, matching what "backgrounded" means for
the reconnect-pause rule (`client/index.ts`'s `AppState` handling) -- an app with several Activities
rotating or handing off to each other must not look backgrounded on every transition, only when the
whole process leaves the foreground. Registration happens on the main thread (posted there if
constructed off it); `CordieriteNoopLifecycleObserver` backs every unit test, so none of them touch
a real `Lifecycle`.

## The transport seam and testability

`CordieriteTransport` is `CordieriteConnectionManager`'s existing public surface, extracted
unchanged into an interface so `CordieriteClient` can be constructed with a scripted
`FakeCordieriteTransport` (`core/src/test`) instead: no `Context`, no OkHttp, no Robolectric. The
fake accepts `connect`/`send`/`close` synchronously (like a socket that opens instantly) and exposes
`simulateAck`/`simulateMessage`/`simulateClose`/`simulateError` for tests to drive server-side
events. `CordieriteClient`'s test-only constructor takes the transport factory directly; the real
`CordieriteClient(context: Context)` constructor wires a real `CordieriteConnectionManager`.

## The Android bridge (`packages/react-native/android`)

`NativeCordieriteModule.kt` implements the frozen spec on top of `CordieriteClient`. Every
structured value crosses the bridge as a JSON string (the spec's own design, so Codegen sidesteps
nested/optional object-shape limits); `CordieriteClient` already speaks `org.json` internally, so
the bridge only (de)serializes at the two edges Codegen cares about -- tool descriptors and connect
input in, events and getters out.

`registerTool(descriptorJson)` registers a handler with `CordieriteClient` that:

1. Emits `onToolCall` with `{ id, name, argsJson }`.
2. Suspends on a `CompletableDeferred<Pair<String?, String?>>` keyed by call id.
3. Is completed by `respondToToolCall(id, resultJson, errorJson)` -- a no-op for an unknown or
   already-finished id, per the spec's own doc comment.
4. On success, parses `resultJson` back into an `org.json` value with `JSONTokener` and returns it
   (re-serialized by `CordieriteToolInvoker` into the eventual `tool_result` frame -- a redundant
   parse/re-stringify, traded for keeping `CordieriteClient`'s wire-error classification in one
   place instead of duplicating it bridge-side).
5. On an explicit `errorJson`, throws a new `CordieriteToolReplyError(errorType, message, details)`
   -- `CordieriteToolInvoker` special-cases this exception type (checked before the generic
   `Throwable` catch that would otherwise classify it as `tool_execution_error`) so a JS-chosen
   wire error type reaches the daemon verbatim.
6. On cancellation (a `CancellationException` from the suspended `await()` -- either an explicit
   `tool_cancel` frame or `abortAllInFlight()`), emits `onToolCancel` before rethrowing, exactly as
   coroutines require a `CancellationException` to always propagate.

`reportToolProgress(id, progress, message)` looks up the call's own `reportProgress` closure (kept
alongside its `CompletableDeferred` in a small `pendingToolCalls` map) and forwards to it on
`moduleScope`, fire-and-forget, since the spec declares it `void`, not `Promise<void>`.

`getConstants()`/`getTypedExportedConstants()` reads `CordieriteClient.buildConfig`, itself just
`transport.getBuildConfig()` -- the same manifest-reading path a real `connect()` uses, unchanged
from phase 1.

## Deviations from a strictly mechanical port

- **The seven JS `tool_error` types shrink to five on native.** Issue #48 decision 4: the native
  SDK does no app-side schema validation (the daemon does none either), so
  `tool_input_validation_error`/`tool_output_validation_error` never originate here -- they stay
  JS-only, produced by `validateToolSchema` against a Standard Schema the native core has no way to
  interpret. `respondToToolCall`'s `errorJson` can still carry either type string from the bridge if
  some future JS layer wants to report one through native, since `CordieriteToolReplyError` accepts
  any string; native itself just never produces one on its own.
- **`getSessionId`/`sessionChange` carry no `type`/`reason`.** The frozen spec's
  `CordieriteSessionChangeEventNative` is `{ sessionId, alias }` only -- both null once the session
  is gone, whether it was claimed-then-lost, revoked, or superseded. `CordieriteClient`'s own
  `CordieriteSessionChangeListener` matches that shape exactly rather than JS's richer
  `{ type, sessionId, alias, reason? }`, so nothing is silently dropped at the bridge.
- **No `AbortSignal` equivalent.** A Kotlin handler observes cancellation the coroutine-native way
  (see "Threading model"/API above) instead of an explicit token object -- the closest match to
  "coroutine cancellation" the task description asks for, and idiomatic for the platform.
- **`respondToToolCall`'s result round-trips through JSON text** rather than a shared in-memory
  value, because the bridge and `CordieriteClient` communicate only through the
  `CordieriteToolHandler` signature (`suspend (JSONObject, CordieriteToolCallContext) -> Any?`),
  and the bridge's own answer arrives as wire JSON from JS. Simpler than adding a second handler
  shape just for the bridge's benefit.

## Known gaps / not exercised by the test suite

- **Real reconnect/backoff/grace timing is not exercised end-to-end.** `CordieriteClient` creates
  its own `Dispatchers.Default`-based dispatcher rather than accepting an injectable one, so
  `kotlinx-coroutines-test`'s virtual-time `TestDispatcher` cannot fast-forward its internal
  `delay()` calls; a full reconnect-after-loss test would need real wall-clock seconds per case.
  The pure math and classification functions it is built from -- `computeCordieriteFullJitterBackoffMs`
  and `isCordieriteTerminalCloseCode` -- are covered directly instead
  (`CordieriteBackoffTest`/`CordieriteTerminalCloseTest`), and `CordieriteClientTest` covers the
  terminal-close (1000/1008) paths, which resolve synchronously. Making the dispatcher injectable is
  a reasonable follow-up if reconnect timing regresses in practice.
- **The end-to-end device check (`cordierite link --open android` against the debug APK) did not
  reach a claimed session.** The playground's current JS bundle is compiled from
  `packages/react-native/src`, which the sibling JS-rewrite agent has not yet updated to the frozen
  spec (expected -- see the task brief); on this worktree's dependency tree, the bundled JS crashes
  at startup before it reaches any Cordierite call at all (`ReactNativeJS: React Native version
  mismatch: JavaScript version 0.83.2, Native version 0.81.5`, then `[runtime not ready]: Error:
  Cannot find native module 'ExpoPushTokenManager'`) -- a pre-existing dependency-resolution issue
  in this worktree's `node_modules`, unrelated to anything in this task's diff. `adb install` and
  app launch on a booted `Pixel_8_API_35` emulator both succeeded; `assembleDebug`,
  `:core:testDebugUnitTest`, `:core:assembleRelease`, `:core-noop:assembleRelease`,
  `cordierite doctor --assert-present` (debug) and `--assert-absent` (release, default) all pass,
  which is what actually exercises the Kotlin core and the bridge's compile-time contract with
  Codegen. A genuine claimed-session proof needs the JS rewrite to land first.

## Verification run in this worktree

- `packages/native/android`: `./gradlew :core:testDebugUnitTest :core:assembleRelease
  :core-noop:assembleRelease` -- 113 tests, all green (46 pre-existing + 67 new); both `assembleRelease`
  tasks succeed.
- Playground: `expo prebuild --platform android --no-install`, then
  `./gradlew :cordierite_react-native:testDebugUnitTest assembleDebug --no-configuration-cache
  -PreactNativeArchitectures=arm64-v8a` (green; `[cordierite] native module INCLUDED` confirms
  inclusion; `testDebugUnitTest` is `NO-SOURCE`, matching phase 1's already-documented "empty
  `src/test`" note) -- this is also what proved the bridge's method signatures match what Codegen
  actually generates from the frozen spec, since nothing here hand-waves that shape.
  `cordierite doctor <debug apk> --assert-present` holds. `assembleRelease` (default,
  `CORDIERITE_ENABLED` unset, `core-noop` vendored) succeeds once `packages/cordierite` and
  `@cordierite/react-native` are built first (`tsc` emits JS despite the expected type errors in
  the old `CordieriteModule.ts` against the new `Spec`, since `noEmitOnError` is off) --
  `cordierite doctor <release apk> --assert-absent` holds.
