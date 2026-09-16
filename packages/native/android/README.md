# `packages/native/android`

The framework-free Android core behind Appduct, plus a public `Appduct` facade for plain
apps that want it with no React Native anywhere in the stack (GitHub issue #48 phase 3;
`docs/tasks/19-android-entry-points.md`). If you're building a React Native app, use
[`@appduct/react-native`](../../react-native/README.md) instead -- it vendors this module's
sources and gives you the same functionality behind a JS API. This README is for a plain
Kotlin/Java Android app.

## 1. Install

Two artifacts, same public API, one real, one inert:

```kotlin
dependencies {
  debugImplementation("com.callstack.appduct:core:<version>")
  releaseImplementation("com.callstack.appduct:core-noop:<version>")
}
```

`core` is the real implementation (TLS-pinned transport, session lifecycle, tool registry, the
`Appduct` facade). `core-noop` is the exact same public API with every method inert -- no
`okhttp`, no `kotlinx.coroutines` dependency, no network code at all. Pairing them this way means
the real implementation's bytecode is never on a release build's classpath by default, matching
issue #48 decision 2 (the same pairing `@appduct/react-native`'s own Android bridge uses
internally). Opt a release build back in by resolving `core` for it instead, the same way you'd
override any other dependency per variant.

### The `appductScheme` placeholder

`core`'s manifest declares a trampoline activity with an intent filter on a scheme your app names:

```kotlin
android {
  defaultConfig {
    manifestPlaceholders["appductScheme"] = "myapp"
  }
}
```

Forgetting this is a **manifest-merger error at build time**, not a silent no-op:

```
Attribute data@scheme at ... requires a placeholder substitution but no value for <appductScheme> is provided.
```

The scheme you pick is what `appduct link --scheme <s>` / `appduct init --scheme <s>` must
match on the CLI side. It can be a dedicated scheme distinct from your app's own primary
deep-link scheme -- see [Deep links](#3-deep-links) for why that matters if you already handle
your own scheme.

## 2. Registering a tool

Call `Appduct.register` once, wherever your app initializes -- `Application.onCreate()` is the
natural place, since [initialization](#4-initialization-the-init-provider) already happened by
the time it runs:

```kotlin
import com.callstack.appduct.Appduct
import org.json.JSONObject

class MyApp : Application() {
  override fun onCreate() {
    super.onCreate()

    Appduct.register(
      name = "seed_cart",
      description = "Fill the cart with test items.",
      inputSchema = JSONObject(
        """{"type":"object","properties":{"items":{"type":"number"}},"required":["items"]}""",
      ),
    ) { args ->
      JSONObject().put("added", args.optInt("items"))
    }
  }
}
```

`register` returns a `ToolRegistration`; call `.remove()` to unregister just that tool. A second
overload takes a `ToolCallContext` as well, for tools that need to report progress:

```kotlin
Appduct.register(name = "slow_task", description = "...") { args, context ->
  context.reportProgress(0.5, "halfway")
  JSONObject().put("done", true)
}
```

Schemas are raw JSON Schema (`org.json.JSONObject`), not `kotlinx.serialization` or any other
schema library -- per issue #48 decision 4, the native SDK does no app-side input/output
validation (the daemon does none either). `annotations` takes a `ToolAnnotations(readOnlyHint?,
destructiveHint?, idempotentHint?)` matching PROTOCOL.md §5.

A handler's return value is converted to JSON the same way the underlying client always has:
`org.json` values pass through, and plain Kotlin/Java `Map`/`List`/`String`/`Number`/`Boolean`/
`null` convert automatically. Anything else fails that one call with `tool_serialization_error`
rather than crashing the caller.

### Threading

Handlers run on this client's own background dispatcher -- never the main thread. Hop to
`Dispatchers.Main` yourself for any UI work a handler needs to do:

```kotlin
Appduct.register(name = "flash_screen", description = "...") { _ ->
  withContext(Dispatchers.Main) {
    // touch a View / Compose state here
  }
  JSONObject()
}
```

Cancellation is coroutine-native, not a separate token: when the daemon sends `tool_cancel` for a
call, or the session suspends entirely, the handler's own coroutine is cancelled. A handler that
calls further suspend functions observes that as an ordinary `CancellationException`; one that
does no further suspending work simply runs to completion, the same way a JS handler that ignores
`AbortSignal` still replies normally.

## 3. Deep links

Appduct ships a no-UI trampoline activity, `AppductLinkActivity`, declared in `core`'s own
manifest with an intent filter on `${appductScheme}`. Open a bootstrap link
(`appduct link --scheme myapp`) and it reaches your registered tools with **no code required**
on your side: the OS routes the link to the trampoline, which calls `Appduct.handle(intent)`
and finishes immediately.

If your app already handles its own deep links on the very same scheme, the trampoline can't tell
your links apart from Appduct's -- it isn't aware of your app's own navigation, so a link with
no Appduct payload is not forwarded anywhere; it's simply not consumed further. Pick one:

- Give Appduct a **dedicated scheme** (`manifestPlaceholders["appductScheme"]` can differ
  from `expo.scheme` / your primary deep-link scheme), so the two never collide, or
- **Remove the trampoline** (below) and call `Appduct.handle(intent)` yourself from your own
  activity's `onCreate`/`onNewIntent`, wherever your existing deep-link handling lives.

You can also call `Appduct.handle` directly with a `Uri` (`Appduct.handle(uri)`) -- both
overloads return `true` iff the input carried an Appduct bootstrap payload, `false` otherwise, so
your own code knows whether to keep handling it.

## 4. Initialization: the init provider

There is no explicit `Appduct.init(context)` call. A dependency-free `ContentProvider`,
`AppductInitProvider`, is declared in `core`'s manifest and captures your app's `Context`
before any app code runs -- the platform constructs every manifest-declared `ContentProvider`
strictly before `Application.onCreate()`, so by the time your own `onCreate()` calls
`Appduct.register(...)`, this has already happened, and a resume attempt for any lease left
from a previous process is already under way in the background.

### Opting out of the init provider and trampoline

Both the provider and the trampoline activity are declared only in `core`'s manifest (never in
`core-noop`'s, which has no manifest entries at all), so a release build that resolves `core-noop`
never gets either. To remove them from a **debug** build too -- for example, to drive
initialization or deep links entirely by hand -- add a `tools:node="remove"` override in your
app's own manifest, matching the component by its fully qualified name:

```xml
<manifest xmlns:tools="http://schemas.android.com/tools">
  <application>
    <provider
        android:name="com.callstack.appduct.AppductInitProvider"
        tools:node="remove" />
    <activity
        android:name="com.callstack.appduct.AppductLinkActivity"
        tools:node="remove" />
  </application>
</manifest>
```

Removing the provider without a replacement means nothing ever calls `Appduct.attach(...)`
(an internal function, not part of the public API today) -- every `Appduct` call after that
throws a clear `IllegalStateException` naming this exact situation, rather than silently doing
nothing. Removing the trampoline just means no deep link ever reaches `Appduct` automatically;
call `Appduct.handle` yourself instead (see [Deep links](#3-deep-links)).

## 5. Hardened builds

`Appduct.buildConfig` reports this build's effective trust configuration --
`BuildConfig(trust, hasEmbeddedPins, allowPrivateLanOnly)` -- read from the exact same
manifest `<meta-data>` values a real `connect()`/link claim uses. See
[`docs/SECURITY.md`](../../../docs/SECURITY.md#trust-modes) for the full trust-mode explanation;
the keys themselves, set as `<meta-data>` on your app's `<application>` tag:

| Name | Purpose |
| --- | ------- |
| `com.callstack.appduct.CLI_PINS` | JSON array string of `sha256/...` SPKI pins |
| `com.callstack.appduct.TRUST` | `"link"` \| `"pin"` -- any other value is a hard error at connect time |
| `com.callstack.appduct.ALLOW_PRIVATE_LAN_ONLY` | Boolean (a `"true"`/`"false"` string is also accepted); defaults to `true` (fail-closed) when absent |

With no keys set, `trust: "link"` is the default: the app trusts whichever SPKI pin a delivered
bootstrap link carries, for that one session only -- zero setup, appropriate for local
development, not for anything you'd hand to someone outside it. Set `CLI_PINS` (which makes
`trust: "pin"` the effective mode) to make a build trust only keys you embedded ahead of time;
`appduct keygen` prints the exact fingerprint string to use.

`ALLOW_PRIVATE_LAN_ONLY` (default `true`) restricts a bootstrap link's target address to a local
IPv4 address (RFC1918 ranges or `127.0.0.1`) -- a dev-hardening switch, not a claim that Appduct
only ever runs on a LAN.

## 6. Compiling Appduct out, and `doctor --assert-absent`

`debugImplementation(core)` / `releaseImplementation(core-noop)` already keeps the real
implementation off a release build's classpath by default -- that pairing alone is what "compiled
out of release" means here, no environment variable or extra config needed on the Android side.
Verify it against the artifact you actually shipped, not the Gradle config that was supposed to
produce it:

```bash
appduct doctor path/to/app-release.apk --assert-absent
appduct doctor path/to/app-debug.apk --assert-present
```

`doctor`'s Android detection trusts only a keep-rule-protected marker class
(`AppductNativeMarker`, compiled only into `core`, never `core-noop`) to decide presence --
not just "is the `com.callstack.appduct` package name anywhere in the dex", since
`core-noop`'s classes share that same Kotlin package and would otherwise look present to a naive
scan. See [`docs/BUILD-VARIANTS.md`](../../../docs/BUILD-VARIANTS.md) and
[`docs/CI.md`](../../../docs/CI.md#release-gate-appduct-doctor) for the full mechanism.

If you run `appduct` both globally installed and from this repo's workspace, `pnpm exec
appduct` can silently resolve the global one instead of the workspace build -- confirm with
`pnpm exec which appduct`, or invoke the workspace build directly
(`node packages/appduct/dist/bin.js doctor ...`) when the two might disagree. This bit the
verification for this very module during development; see
`../../../playground-native/android/README.md` for the concrete repro.

## Troubleshooting

**Manifest-merger error naming `appductScheme`.** You haven't set
`manifestPlaceholders["appductScheme"]` in your app's `build.gradle` -- see
[The `appductScheme` placeholder](#the-appduct-scheme-placeholder) above.

**`appduct link --open android` reports "unable to resolve Intent".** The scheme
`--scheme`/`appduct link` used doesn't match `manifestPlaceholders["appductScheme"]` on the
installed build, or the app was built before that placeholder was set (rebuild and reinstall --
placeholders are baked in at build time, not read at runtime).

**A bootstrap link reaches the trampoline but the app never claims the session, failing with an
EPERM-style connect error.** Your app's manifest is missing
`<uses-permission android:name="android.permission.INTERNET" />`. `core`'s own manifest cannot add
this for you: `<uses-permission>` is an app-level concern AGP does not let a library grant on a
consumer's behalf implicitly by declaring it in its own manifest for a *different* purpose (and
Appduct's library manifest intentionally declares no permissions of its own, so as never to
grant an app more than it asked for) -- add it to your own `AndroidManifest.xml`.

**"Appduct is not initialized" `IllegalStateException`.** `AppductInitProvider` never ran --
most likely you removed it (`tools:node="remove"`) without wiring up an alternative. See
[Opting out of the init provider and trampoline](#opting-out-of-the-init-provider-and-trampoline).

**A tool handler needs to touch a `View` or Compose state.** Handlers run off the main thread by
design (see [Threading](#threading)) -- wrap the UI-touching part in
`withContext(Dispatchers.Main) { ... }`.

## Related

- [`docs/tasks/19-android-entry-points.md`](../../../docs/tasks/19-android-entry-points.md) -- the
  design decisions behind this module's public API, the init-provider/trampoline rationale, and
  the live-check log.
- [`docs/tasks/16-android-session-logic.md`](../../../docs/tasks/16-android-session-logic.md) --
  `AppductClient`'s own API and threading model, which `Appduct` is a thin facade over.
- [`docs/SECURITY.md`](../../../docs/SECURITY.md) -- trust modes, pins, and the threat model.
- [`docs/BUILD-VARIANTS.md`](../../../docs/BUILD-VARIANTS.md) -- how inclusion is decided and
  verified across this whole repo.
- [`playground-native/android/README.md`](../../../playground-native/android/README.md) -- a
  runnable Compose app exercising everything above.
- [`@appduct/react-native` README](../../react-native/README.md) -- the React Native path,
  which vendors this module's sources instead of depending on the published artifact.
