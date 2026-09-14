# `packages/native`

The framework-free native core behind Cordierite: TLS-pinned session transport, SPKI pinning,
explicit trust-mode resolution, process-memory resume leases, and — since issue #48 phase 2 — the
entire app-side session lifecycle (claim/resume, reconnect backoff, grace-window recovery, the tool
registry and its wire deltas, per-call timeout/cancel/progress, and v2 bootstrap deep-link
handling), in plain Swift and Kotlin with no React Native dependency. Since issue #48 phase 3, it
also ships a small public facade (`Cordierite.shared` on iOS, the `Cordierite` object on Android)
that a plain native app calls directly, with no React Native or Expo anywhere in the stack.

This directory is **not an npm/pnpm workspace package** — it has no `package.json`, so
`pnpm-workspace.yaml`'s `packages/*` glob does not pick it up (pnpm silently skips a directory with
no `package.json`) and Turbo, which only ever operates over resolved pnpm workspace packages, never
sees it either.

## Three consumers, one core

| Consumer | How it gets the code | Where |
| --- | --- | --- |
| `@cordierite/react-native` | **Vendored by copy**, not a dependency — `packages/react-native/scripts/sync-native-core.mjs` copies source files in at build/publish time (see below) | [`../react-native/README.md`](../react-native/README.md) |
| A plain iOS app | SwiftPM (`.package(url:)` against the repo-root `Package.swift`) or CocoaPods (`CordieriteCore.podspec`) | [`ios/README.md`](ios/README.md) |
| A plain Android app | Maven (`com.callstackincubator.cordierite:core`/`:core-noop`) | [`android/README.md`](android/README.md) |

Publishing the iOS/Android artifacts the last two rows depend on (CocoaPods trunk, Maven Central, a
SwiftPM tag) is an ops task, not something any of this repo's automation does — see
[`docs/tasks/21-native-core-integration.md`](../../docs/tasks/21-native-core-integration.md).
`playground-native/android`'s `settings.gradle` and `playground-native/ios`'s `project.yml` both
build against this worktree's own sources directly (Gradle `includeBuild` substitution, a local
SwiftPM package path respectively) — no publish-then-consume round trip needed for local
development or CI.

## `CordieriteClient` (the session-logic core)

`ios/Sources/CordieriteCore/Real/CordieriteClient.swift` (plus its `+Session`/`+ToolInvocation`
extensions) and `android/core/src/main/java/.../CordieriteClient.kt` are, respectively, a
`public actor` and a plain class on top of `CordieriteConnectionManager`/`CordieriteTransport` that
own everything the TypeScript client (`packages/react-native/src/client/*`) used to own: the
claim/resume handshake, full-jitter reconnect, grace-window recovery, lease restore, registry
snapshot/delta sync, per-call timeout/cancel/progress, and foreground/background observation. See
[`docs/tasks/15-native-session-logic.md`](../../docs/tasks/15-native-session-logic.md) (iOS + JS)
and [`docs/tasks/16-android-session-logic.md`](../../docs/tasks/16-android-session-logic.md)
(Android) for the full API, the RN bridge's continuation-per-call protocol on top of it, and every
documented deviation from issue #48's sketch (the `sessionChange` event shrinking to
`{ sessionId, alias }`, `defaultToolTimeoutMs` no longer being app-configurable, and so on).

## The `Cordierite` facade (the plain-app entry point)

`Cordierite.shared` (iOS, `CordieriteAPI.swift`) and the `Cordierite` object (Android,
`Cordierite.kt`) are thin, public wrappers over `CordieriteClient` that a plain app calls directly —
`register`/`handle`/`postEvent`/`addListener`, converting across the `[String: Any]`/`JSONObject`
boundary instead of exposing `CordieriteClient`'s own JSON-string-based, TurboModule-shaped API.
See [`docs/tasks/18-ios-entry-points.md`](../../docs/tasks/18-ios-entry-points.md) and
[`docs/tasks/19-android-entry-points.md`](../../docs/tasks/19-android-entry-points.md) for the
design decisions (why `Cordierite.shared` starts `restoreSession()` on first access, the Android
`CordieriteInitProvider`/`CordieriteLinkActivity` init-and-deep-link story, and more), and
[`ios/README.md`](ios/README.md) / [`android/README.md`](android/README.md) for the
consumer-facing integration guide — installing the package, declaring a scheme, registering a
tool, hardened-build config, and troubleshooting.

**RN apps must not touch the facade.** `Cordierite.shared` / the `Cordierite` object own their own
`CordieriteClient` instance and the one process-memory resume lease that comes with it; the RN
bridge (`CordieriteTurboBridge.swift`/`NativeCordieriteModule.kt`) owns a *separate*
`CordieriteClient` of its own. A React Native app that imported `CordieriteCore`/
`com.callstackincubator.cordierite:core` directly and called the facade alongside the RN bridge
would end up with two independent clients racing for the same lease and the same deep link — which
is also why the facade files (`CordieriteAPI.swift` on iOS; `Cordierite.kt`,
`CordieriteInitProvider.kt`, `CordieriteLinkActivity.kt` on Android) are excluded from vendoring
(below): an RN app is not even meant to have them on its classpath, let alone call them. RN apps
keep using `@cordierite/react-native`'s own JS-facing entry points
(`registerTool`/`useCordieriteTool`/`handleUrl` via `Linking`); a plain native app uses the facade;
the two coexist in one repo but never in one app.

## Layout

```
ios/
  Sources/CordieriteCore/
    Real/      the real implementation, every file wrapped in `#if CORDIERITE_ENABLED`
               (includes CordieriteAPI.swift, the plain-app facade)
    Stub/      a same-API no-op mirror, every file wrapped in `#if !CORDIERITE_ENABLED`
  Tests/CordieriteCoreTests/    XCTest suite (moved from packages/react-native/ios/CordieriteTests)
  CordieriteCore.podspec        CocoaPods consumption
android/
  core/        the real implementation as a standalone Gradle module
               (includes Cordierite.kt, CordieriteInitProvider.kt, CordieriteLinkActivity.kt --
               the plain-app facade, init, and deep-link trampoline)
  core-noop/   same public API, every method a no-op -- no okhttp, no marker class, no manifest
               entries at all
fixtures/      language-neutral JSON test vectors the TypeScript, Swift, and Kotlin suites all read
               (docs/tasks/17-conformance-fixtures.md)
```

The repo-root [`Package.swift`](../../Package.swift) is the SwiftPM manifest for `ios/` — it has to
live at the repository root, not here, because SwiftPM only resolves remote package URL
dependencies (and therefore only lets another project depend on this repo via
`.package(url: ...)`) when the manifest sits at the repo root.

## How `@cordierite/react-native` vendors this

The RN package does **not** depend on `CordieriteCore`/`com.callstackincubator.cordierite:core` as
a CocoaPods/Gradle dependency. Publishing this core independently to CocoaPods trunk and Maven
Central is deferred (see the table above); until then the RN package's own releases would be
blocked on unrelated native-core publishing infrastructure if it depended on published core
artifacts. Instead, `packages/react-native/scripts/sync-native-core.mjs` copies source files
straight into the RN package at build/publish time:

- `ios/Sources/CordieriteCore/Real/*.swift` → `packages/react-native/ios/Core/` (only `Real/` — the
  RN pod always compiles with `-DCORDIERITE_ENABLED` set, so it never needs `Stub/`)
- `android/core/src/main/java/**` → `packages/react-native/android/core/`
- `android/core-noop/src/main/java/**` → `packages/react-native/android/core-noop/`

**The facade-exclusion rule.** Both copies above exclude the plain-app facade files —
`CordieriteAPI.swift` on iOS; `Cordierite.kt`, `CordieriteInitProvider.kt`, `CordieriteLinkActivity.kt`
on Android — via an explicit filter in `sync-native-core.mjs`
(`IOS_FACADE_FILES`/`ANDROID_FACADE_FILES`). The RN bridge owns its own `CordieriteClient` and must
never end up with a second one behind a vendored `Cordierite.shared`/`Cordierite` object competing
for the same process-memory resume lease (see "RN apps must not touch the facade" above); Android's
init `ContentProvider` and deep-link trampoline `Activity` exist only for plain apps too (RN routes
links through `Linking` instead) and must never be declared in the RN module's own manifest, which
they would be if their sources were copied in — `sync-native-core.mjs` only copies `src/main/java`,
never `AndroidManifest.xml`, so even an accidentally-vendored provider/activity source file would
compile without registering, but excluding the files outright is the belt to that suspenders.

These vendored directories are gitignored in the RN package but included in its published npm
tarball (see `.npmignore`/`package.json#files`), so a consumer installing `@cordierite/react-native`
from npm gets the vendored sources without ever needing this directory or a SwiftPM/Maven
dependency resolution step.

## How a plain native app consumes this

Built (issue #48 phase 3). See [`ios/README.md`](ios/README.md) and
[`android/README.md`](android/README.md) for the full integration guide, and
[`../../playground-native/ios`](../../playground-native/ios) /
[`../../playground-native/android`](../../playground-native/android) for a complete, runnable
example of each — a plain SwiftUI and a plain Jetpack Compose app registering the same five tools
the Expo playground (`playground/`) does, so `cordierite tools` reports an equivalent surface no
matter which one answered the link.

## Fixtures and task notes

- [`fixtures/README.md`](fixtures/README.md) — the cross-language conformance vectors (bootstrap
  payloads and links, tool descriptors, close codes, the SPKI pin) that the TypeScript, Swift, and
  Kotlin test suites all read from one place, so a future change to one implementation's
  parsing/validation rules can't drift from the other two without a test failing
  ([`docs/tasks/17-conformance-fixtures.md`](../../docs/tasks/17-conformance-fixtures.md)).
- [`docs/tasks/14-native-core-extraction.md`](../../docs/tasks/14-native-core-extraction.md) — phase
  1, the mechanical extraction and the vendoring/build-variant decisions.
- [`docs/tasks/15-native-session-logic.md`](../../docs/tasks/15-native-session-logic.md) /
  [`docs/tasks/16-android-session-logic.md`](../../docs/tasks/16-android-session-logic.md) — phase
  2, porting the session lifecycle into Swift/Kotlin.
- [`docs/tasks/18-ios-entry-points.md`](../../docs/tasks/18-ios-entry-points.md) /
  [`docs/tasks/19-android-entry-points.md`](../../docs/tasks/19-android-entry-points.md) — phase 3,
  the plain-app facades and native playgrounds.
- [`docs/tasks/21-native-core-integration.md`](../../docs/tasks/21-native-core-integration.md) —
  where every decision and phase of issue #48 landed, end to end.

## Related

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §11 — the SDK entry points and client
  behavior this core implements.
- [`docs/BUILD-VARIANTS.md`](../../docs/BUILD-VARIANTS.md#native-core) — how inclusion is decided
  and verified on every platform.
- [`docs/SECURITY.md`](../../docs/SECURITY.md#configuring-trust) — trust modes, pins, and the same
  keys a plain native app sets.
- [`@cordierite/react-native` README](../react-native/README.md) — the React Native path.
