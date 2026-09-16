# 19 — Android app-facing entry points, deep-link trampoline, and native playground (Phase 3 of issue #48, Android half)

**Depends on:** `docs/tasks/14-native-core-extraction.md` (phase 1: `packages/native/android`'s
`core`/`core-noop` split) and `docs/tasks/16-android-session-logic.md` (phase 2: `AppductClient`,
the internal client the facade below wraps). Ran in parallel with the iOS/Swift phase-3 half and
the RN/JS phase-3 half; this task covers only `packages/native/android`, `playground-native/android`,
`packages/native/android/README.md`, and this file.

## Goal

Finish issue #48's phase 3 for Android: a public `Appduct` facade a plain Android app calls
directly (no React Native), a no-UI deep-link trampoline, publishing config so `core`/`core-noop`
produce real Maven artifacts, and a native Jetpack Compose playground app exercising all of it.

## 1. The `Appduct` facade

`core/src/main/java/.../Appduct.kt` (mirrored inert in `core-noop`). An `object`, not a class --
one client per process, matching how the issue's own Android sketch calls it (`Appduct.register(...)`
directly, no instance to hold onto). Thin: every method converts to/from `AppductClient`'s
existing types and delegates immediately; no session logic is duplicated here.

**Public types are new, not the internal ones re-exported.** `AppductClient`,
`AppductClientState`, `AppductToolDescriptor`, `AppductToolCallContext`, etc. are all
`internal` (phase 2's own design, since `@appduct/react-native`'s bridge is the only other
consumer and lives in the same Gradle module once vendored). The facade defines its own public
mirrors -- `ClientState`, `ToolAnnotations`, `ToolCallContext`, `BuildConfig`, `ToolRegistration`,
`Subscription`, `AppductEvent` -- and converts between them at the boundary
(`AppductClientState.toPublic()`, etc.). This keeps the internal types free to change shape for
phase-2-style reasons without that being a public API break, and matches the issue's own sketch
literally (unqualified `ClientState`/`BuildConfig` names, not `Appduct.ClientState`).

**Two `register` overloads**, differing only in whether the handler takes a `ToolCallContext`:
```kotlin
fun register(..., handler: suspend (args: JSONObject, context: ToolCallContext) -> Any?): ToolRegistration
fun register(..., handler: suspend (args: JSONObject) -> Any?): ToolRegistration  // convenience
```
Kotlin resolves the trailing-lambda call correctly by parameter arity in both directions (a
one-param lambda picks the second overload, a two-param lambda the first) -- verified by
`AppductTest`'s calls using both shapes side by side with no explicit type annotations needed.

**`addListener` merges three internal listener channels into one `AppductEvent` sealed type**
(`StateChange`/`SessionChange`/`Error`), matching the issue's sketch
(`fun addListener(listener: (AppductEvent) -> Unit): Subscription`) rather than the internal
client's three separate `addXListener` methods. `Subscription.remove()` unsubscribes all three
underlying listeners together.

**Handler results and cancellation are unchanged from `AppductClient`** -- the facade adds no
new JSON-conversion or cancellation logic, just documents what already exists (`org.json`
values plus plain Kotlin/Java collections/primitives convert automatically;
`tool_serialization_error` for anything else; cancellation is coroutine-native, no separate
token). See `packages/native/android/README.md` for the consumer-facing version of this.

## 2. `AppductInitProvider`: initialization with no explicit `init()` call

The issue's Android sketch calls `Appduct.register(...)` straight from `Application.onCreate()`
with no prior setup step -- so something has to have a `Context` and a constructed
`AppductClient` ready *before* that. A dependency-free `ContentProvider`
(`android:authorities="${applicationId}.appduct-init"`, `android:exported="false"`) is the
standard Android idiom for exactly this: the platform constructs every manifest-declared
`ContentProvider` and calls `onCreate()` strictly before `Application.onCreate()`, during process
startup, with no ordering control needed from app code. `AppductInitProvider.onCreate()`
captures `context.applicationContext`, constructs the real `AppductClient`, and kicks off
`restoreSession()` in the background (fire-and-forget, `runCatching`-wrapped so a failed lease
restore never crashes provider init).

`Appduct`'s backing client is `@Volatile var backingClient: AppductClient?`, set once by
`attach(context)` (internal, called only by the provider) and read through a `client()` accessor
that throws a specific `IllegalStateException` naming the likely cause (the provider was removed
without a replacement) if it's still `null` -- fails loud rather than silently no-op'ing, matching
this repo's general "fail closed and say why" style (`docs/SECURITY.md`'s trust-mode error
messages, `appduct doctor`'s never-guess policy).

`core-noop` has **no `AppductInitProvider` at all** -- nothing to capture a `Context` for, and
its `Appduct.register` et al. are all synchronous no-ops needing no client. This is also why
`core-noop`'s `AndroidManifest.xml` stays the empty file it already was (phase 1): no provider, no
trampoline, no entries of any kind.

### Test-only substitution

`Appduct.attachForTest(client: AppductClient)` / `detachForTest()` are `internal`, letting
`core/src/test`'s `AppductTest` substitute a client built over `FakeAppductTransport` instead
of the real `AppductInitProvider` path -- the same "test-only internal constructor" pattern
`AppductClientTest` already uses for the transport layer one level down. Kotlin's Gradle plugin
grants a module's `test` source set friend access to that module's own `internal` declarations
(already relied on by the pre-existing `AppductClientTest`), so this needed no visibility
changes beyond what phase 2 already had.

## 3. `AppductLinkActivity`: the trampoline

`android:theme="@android:style/Theme.NoDisplay"`, `exported="true"`, `excludeFromRecents="true"`,
`noHistory="true"`, an intent filter on `VIEW`/`DEFAULT`/`BROWSABLE` with
`<data android:scheme="${appductScheme}"/>`. `onCreate` calls `Appduct.handle(intent)` and
`finish()`es unconditionally, whatever `handle` returned.

**Declared only in `core`'s own `AndroidManifest.xml`.** `@appduct/react-native`'s
`scripts/sync-native-core.mjs` vendors only the `src/main/java` tree, never `AndroidManifest.xml`
(confirmed by reading the script before adding anything, per this task's brief) -- so although
`AppductInitProvider`/`AppductLinkActivity`'s *source files* do get copied into the RN
bridge's compiled sources (nothing excludes them from that directory-wide copy), neither component
is ever actually registered there, and the RN bridge needs no dependency or manifest entry it
doesn't already have to keep compiling. Verified directly: `node scripts/sync-native-core.mjs`
copies both new files alongside the rest of `core`'s sources, and
`packages/react-native/android`'s own manifest is untouched and still has no such entries.

**"A link with no Appduct payload is not swallowed" is a documented limitation, not a feature
this activity implements.** Once `AppductLinkActivity` is the exported entry point for a given
scheme, *any* link on that scheme lands here first -- there is no way for a no-UI trampoline with
no knowledge of the app's own navigation graph to "forward" a non-Appduct link anywhere
meaningful; the only two real choices for an app that also wants to handle links on the same
scheme are (a) give Appduct a dedicated scheme, or (b) remove this activity
(`tools:node="remove"`) and call `Appduct.handle(intent)` from the app's own activity instead.
Both are documented in `packages/native/android/README.md`'s "Deep links" section, and the
manifest's own doc comment points there.

**Robolectric test** (`AppductLinkActivityTest`) launches the activity directly via
`Robolectric.buildActivity(AppductLinkActivity::class.java, intent).create()` with a bootstrap
intent, and asserts the URL reached `Appduct`/the underlying client (surfaced as a `"bootstrap"`
phase error on `addListener`, since the test payload isn't a real encoded v2 blob -- reaching
`handleUrl` at all is what the test is for, matching the task brief's "an intent with a bootstrap
URL reaches the client").

## 4. A bug this task's own build config almost shipped: manifest placeholders leak downstream

`core`'s own unit tests need `${appductScheme}` resolved to *something* for Robolectric's test
manifest merge to succeed at all. The first fix tried was `defaultConfig.manifestPlaceholders =
[appductScheme: "appduct-core-test"]` -- which compiles and makes `:core:testDebugUnitTest`
pass, but is wrong: AGP resolves a *library's own* manifest placeholders once, at that library's
own manifest-merge step (`processDebugManifest`), baking a literal value into the AAR's merged
manifest. A downstream consumer -- whether via a real Maven dependency or, as in this task's own
`playground-native`, a `includeBuild` project substitution -- inherits that already-resolved
literal verbatim and never gets a chance to apply its own placeholder value for the same key,
since by the time the consumer's own manifest merge runs, there is no more `${appductScheme}`
token left to substitute.

This was caught, not theorized: `playground-native`'s installed debug APK's merged manifest showed
`android:scheme="appduct-core-test"` (the test default) instead of `"appduct-native"` (what
`app/build.gradle` actually set), and `appduct link --open android --scheme appduct-native`
failed with `unable to resolve Intent` as a direct, reproducible consequence.

**Fix:** scope the test-only default to the `unitTest` *component* via the Variant API instead of
`defaultConfig`/any build type:
```groovy
androidComponents {
  onVariants(selector().withBuildType("debug")) { variant ->
    variant.unitTest?.manifestPlaceholders?.put("appductScheme", "appduct-core-test")
  }
}
```
`variant.unitTest` is a distinct `Component` with its own `manifestPlaceholders` property, entirely
separate from the main `debug` variant's -- setting it here has no effect on `processDebugManifest`
(confirmed: its merged-manifest intermediate still shows the literal, unresolved
`${appductScheme}` token afterward) and therefore no effect on anything that depends on `core`
as a real library, only on `core`'s own Robolectric run. Re-verified end-to-end after the fix:
`:core:testDebugUnitTest` still green, and `playground-native`'s rebuilt debug APK's manifest
correctly shows `"appduct-native"`.

## 5. `android.permission.INTERNET`

Not part of `core`'s own manifest (a library declaring app permissions on a consumer's behalf,
for a purpose the consumer didn't ask for, would be its own hazard) -- but its absence from
`playground-native`'s manifest surfaced immediately in the live check below as an EPERM-shaped
connect failure the moment a delivered link tried to open the pinned socket. Added to
`playground-native/android/app/src/main/AndroidManifest.xml` and documented as the first
troubleshooting entry in `packages/native/android/README.md`, since any real consumer app will hit
this if they don't already have the permission for other reasons (most apps that talk to a network
at all already do).

## 6. Publishing

`core`/`core-noop`'s `build.gradle` already had a `maven-publish` sketch from phase 1
(`publishing { singleVariant('release') { ... } }` plus an `afterEvaluate` publication block).
Finished it with `withSourcesJar()` (AGP 7.1+, generated from the release variant's own
Kotlin/Java sources, no hand-wired `Jar` task needed):

```bash
./gradlew :core:publishToMavenLocal :core-noop:publishToMavenLocal
```

Verified against `~/.m2/repository/com/callstack/appduct/`: both `core/0.8.0/` and
`core-noop/0.8.0/` contain `.aar`, `-sources.jar`, `.module`, and `.pom`. No signing, no Central
upload -- deferred as an ops task per the brief.

## 7. Native playground (`playground-native/android`)

A single-module Compose app, `com.callstack.appduct.playground`. `settings.gradle`
uses `includeBuild("../../packages/native/android")` with dependency substitution for
`com.callstack.appduct:core`/`:core-noop`, so the playground always builds against
this worktree's `packages/native/android`, never a published artifact, with no publish-then-consume
round trip during development. `app/build.gradle` pairs `debugImplementation(core)` /
`releaseImplementation(core-noop)`, matching the issue's sketch exactly, and sets
`manifestPlaceholders["appductScheme"] = "appduct-native"`.

**Tools mirror the Expo playground's** (`playground/app/(tabs)/index.tsx`) one-for-one: `sum`,
`call_count`, `reset_counter` (destructive), `slow_task` (progress + `timeoutMs`), `throwing_tool`.
Registered in `PlaygroundApplication.onCreate()`. `PlaygroundState` (a plain Kotlin `object` using
Compose's `mutableStateOf`/`mutableStateListOf` directly, no `ViewModel`) mirrors connection
state/session id/call count and a capped recent-events log, updated by one
`Appduct.addListener` subscription registered once for the whole process; `MainActivity`'s one
Compose screen just reads it. A "Post event" button calls `Appduct.postEvent`.

Verified:
```bash
./gradlew :app:assembleDebug :app:assembleRelease   # both succeed
node packages/appduct/dist/bin.js doctor app/build/outputs/apk/debug/app-debug.apk --assert-present   # holds
node packages/appduct/dist/bin.js doctor app/build/outputs/apk/release/app-release-unsigned.apk --assert-absent  # holds
```

**A `pnpm exec` gotcha found during this verification, not a bug in this task's own code:**
`pnpm exec appduct doctor ...` initially reported the release APK as `present: true` with no
`android-keep-rule-marker` signal -- self-contradictory given `artifact-inspect.ts`'s own `present`
formula (`android` case: `signals.includes("android-keep-rule-marker")`, nothing else can flip it).
Root cause: this machine has `appduct` installed globally (via an `fnm` shim), and `pnpm exec`
fell back to that stale global `PATH` binary instead of resolving the workspace's own build, since
no local bin symlink exists for `appduct` at the workspace root. `node
packages/appduct/dist/bin.js doctor ...` (bypassing `pnpm exec`'s resolution entirely) gave the
correct, expected result both directions. Documented in
`playground-native/android/README.md`; not a code change anywhere in this repo.

## 8. Live check (`Pixel_8_API_35`, `emulator-5554`)

An AVD was already booted (shared with sibling agents' concurrent work on this issue; not
restarted, per this task's "never kill a process you didn't start" constraint). Commands and
key output, run from the repo root unless noted:

```bash
export APPDUCT_STATE_DIR=/tmp/appduct-3b-state   # config.json: {"wssPort": 8456}
adb -s emulator-5554 install -r playground-native/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell am start -n com.callstack.appduct.playground/.MainActivity

node packages/appduct/dist/bin.js link --open android --scheme appduct-native --device emulator-5554
# -> Link Created, Delivered yes (android)
```

First attempt at this point failed twice, for the two bugs sections 4 and 5 above document -- both
fixed and re-verified before the sequence below, which is the post-fix run:

```
Session    f7Z6w6yPAmKxV5UI
Endpoint   wss://127.0.0.1:8456
Delivered  yes (android)
```

On-device: `State: active`, `Session: f7Z6w6yPAmKxV5UI` (screenshot captured via
`adb shell screencap`).

```bash
node packages/appduct/dist/bin.js tools
```
Lists all five registered tools with their descriptions.

```bash
node packages/appduct/dist/bin.js invoke sum --input '{"a":2,"b":3}'          # {"total":5}
node packages/appduct/dist/bin.js invoke call_count --input '{}'              # {"count":1}
node packages/appduct/dist/bin.js invoke throwing_tool --input '{}'           # tool_execution_error: "throwing_tool always fails on purpose."
node packages/appduct/dist/bin.js invoke slow_task --input '{}'               # {"done":true}, ~1.5s
node packages/appduct/dist/bin.js invoke reset_counter --input '{}'           # {"count":0}
```

Tapped "Post event" via `adb shell input tap`; `node packages/appduct/dist/bin.js events`
(streaming) showed:
```
app_event  android-sdk-built-for-arm64  { "name": "button_tapped", "payload": { "at": 1789399486681 }, ... }
```

Backgrounded (`adb shell input keyevent HOME`) and re-checked immediately: `appduct ls` still
showed the session `active` (within the grace window). Relaunched
(`adb shell am start -n .../.MainActivity`, which Android reported as "brought to the front" since
the task was still alive) and invoked once more:
```bash
node packages/appduct/dist/bin.js invoke sum --input '{"a":10,"b":15}'   # {"total":25}
```
Same session id throughout (`f7Z6w6yPAmKxV5UI`); on-device event log accumulated every call in
order, oldest-message-first display (newest at top), matching `PlaygroundState.logEvent`'s
prepend behavior. `node packages/appduct/dist/bin.js daemon stop` at the end to clean up the
private daemon this check spawned.

Everything in the task brief's live-check script completed successfully; nothing was skipped.

## Deviations from a strictly mechanical reading of issue #48

- **Public type names are new, not re-exports of the internal ones** (section 1) -- the issue's
  own sketch already implies this (`ClientState`/`BuildConfig` unqualified, distinct from
  `AppductClientState`/`AppductBuildConfig`), but it's worth stating explicitly: nothing
  internal was made public to satisfy the facade.
- **`android.permission.INTERNET` is not declared anywhere in `packages/native/android`** -- an
  app-level concern by design (see section 5); this is a deviation from "just make it work
  out of the box" but the right one, since a library silently granting a consumer app a permission
  it didn't ask to declare is a bigger hazard than one documented troubleshooting entry.
- **The manifest-placeholder leak (section 4) was found and fixed within this task**, not left as
  a known gap -- the brief's live-check step is exactly what surfaced it, which is itself evidence
  the live check was worth doing in full rather than treating it as optional polish.

## Out of scope / left as-is

- Publishing `core`/`core-noop` to Maven Central itself (signing, credentials, CI wiring) -- an
  ops task per the brief; `publishToMavenLocal` is what's verified here.
- Any change to `packages/react-native/**`, `packages/native/ios/**`, `Package.swift`,
  `packages/appduct/**`, `docs/*.md` other than this file, or the root README -- explicitly out
  of this task's owned surface; the RN vendoring *behavior* was read and relied on (section 3) but
  no RN file was modified.
- Schema derivation from `kotlinx.serialization`/`Codable` -- out of scope for issue #48 entirely
  (decision 4).
