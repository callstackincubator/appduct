# `packages/native` internals

This is the contributor-facing companion to [`packages/native/README.md`](../../packages/native/README.md).
It covers how the framework-free Swift/Kotlin core is built, vendored, and published — not how to
consume it. If you're integrating Appduct into an app, you want
[`packages/native/ios/README.md`](../../packages/native/ios/README.md) or
[`packages/native/android/README.md`](../../packages/native/android/README.md) instead.

## Not a workspace package

This directory has no `package.json`, so `pnpm-workspace.yaml`'s `packages/*` glob does not pick
it up (pnpm silently skips a directory with no `package.json`) and Turbo, which only ever operates
over resolved pnpm workspace packages, never sees it either.

## Three consumers, one core

| Consumer | How it gets the code | Where |
| --- | --- | --- |
| `@appduct/react-native` | **Vendored by copy**, not a dependency — `packages/react-native/scripts/sync-native-core.mjs` copies source files in at build/publish time (see below) | [`../../packages/react-native/README.md`](../../packages/react-native/README.md) |
| A plain iOS app | SwiftPM (`.package(url:)` against the repo-root `Package.swift`) or CocoaPods (the repo-root `AppductCore.podspec`) | [`../../packages/native/ios/README.md`](../../packages/native/ios/README.md) |
| A plain Android app | Maven (`com.callstack.appduct:core`/`:core-noop`) | [`../../packages/native/android/README.md`](../../packages/native/android/README.md) |

CocoaPods trunk and the SwiftPM tag are published by `deploy.yaml`'s `publish-cocoapods` job,
which runs after the npm publishes on every GitHub release; the SwiftPM "publish" is
the release's git tag itself, since `Package.swift` carries no version of its own. **Maven Central
is published by `deploy.yaml`'s `publish-maven` job**, which stages a signed bundle and uploads it
to the Central Portal for validation; the final Publish is a deliberate manual step in the Portal
UI.
`playground-native/android`'s `settings.gradle` and `playground-native/ios`'s `project.yml` both
build against this worktree's own sources directly (Gradle `includeBuild` substitution, a local
SwiftPM package path respectively) — no publish-then-consume round trip needed for local
development or CI.

## `AppductClient` (the session-logic core)

`ios/Sources/AppductCore/Real/AppductClient.swift` (plus its `+Session`/`+ToolInvocation`
extensions) and `android/core/src/main/java/.../AppductClient.kt` are, respectively, a
`public actor` and a plain class on top of `AppductConnectionManager`/`AppductTransport` that
own all of the session logic, so the React Native package's TypeScript has none of it: the
claim/resume handshake, full-jitter reconnect, grace-window recovery, lease restore, registry
snapshot/delta sync, per-call timeout/cancel/progress, and foreground/background observation. See
[`../tasks/15-native-session-logic.md`](../tasks/15-native-session-logic.md) (iOS + JS) and
[`../tasks/16-android-session-logic.md`](../tasks/16-android-session-logic.md) (Android) for the
full API, the RN bridge's continuation-per-call protocol on top of it, and every documented
deviation from issue #48's sketch.

## The `Appduct` facade (the plain-app entry point)

`Appduct.shared` (iOS, `AppductAPI.swift`) and the `Appduct` object (Android,
`Appduct.kt`) are thin, public wrappers over `AppductClient` that a plain app calls directly —
`register`/`handle`/`postEvent`/`addListener`, converting across the `[String: Any]`/`JSONObject`
boundary instead of exposing `AppductClient`'s own JSON-string-based, TurboModule-shaped API.
See [`../tasks/18-ios-entry-points.md`](../tasks/18-ios-entry-points.md) and
[`../tasks/19-android-entry-points.md`](../tasks/19-android-entry-points.md) for the design
decisions (why `Appduct.shared` starts `restoreSession()` on first access, the Android
`AppductInitProvider`/`AppductLinkActivity` init-and-deep-link story, and more).

**RN apps must not touch the facade.** `Appduct.shared` / the `Appduct` object own their own
`AppductClient` instance and the one process-memory resume lease that comes with it; the RN
bridge (`AppductTurboBridge.swift`/`NativeAppductModule.kt`) owns a *separate*
`AppductClient` of its own. A React Native app that imported `AppductCore`/
`com.callstack.appduct:core` directly and called the facade alongside the RN bridge
would end up with two independent clients racing for the same lease and the same deep link — which
is also why the facade files (`AppductAPI.swift` on iOS; `Appduct.kt`,
`AppductInitProvider.kt`, `AppductLinkActivity.kt` on Android) are excluded from vendoring
(below): an RN app is not even meant to have them on its classpath, let alone call them. RN apps
keep using `@appduct/react-native`'s own JS-facing entry points
(`registerTool`/`useAppductTool`/`handleUrl` via `Linking`); a plain native app uses the facade;
the two coexist in one repo but never in one app.

## Layout

```
ios/
  Sources/AppductCore/
    Real/      the real implementation, every file wrapped in `#if APPDUCT_ENABLED`
               (includes AppductAPI.swift, the plain-app facade)
    Stub/      a same-API no-op mirror, every file wrapped in `#if !APPDUCT_ENABLED`
  Tests/AppductCoreTests/    XCTest suite
android/
  core/        the real implementation as a standalone Gradle module
               (includes Appduct.kt, AppductInitProvider.kt, AppductLinkActivity.kt --
               the plain-app facade, init, and deep-link trampoline)
  core-noop/   same public API, every method a no-op -- no okhttp, no marker class, no manifest
               entries at all
fixtures/      language-neutral JSON test vectors the TypeScript, Swift, and Kotlin suites all read
               (../tasks/17-conformance-fixtures.md)
```

The repo-root [`Package.swift`](../../Package.swift) is the SwiftPM manifest for `ios/` — it has to
live at the repository root, not here, because SwiftPM only resolves remote package URL
dependencies (and therefore only lets another project depend on this repo via
`.package(url: ...)`) when the manifest sits at the repo root.

## How `@appduct/react-native` vendors this

The RN package does **not** depend on `AppductCore`/`com.callstack.appduct:core` as
a CocoaPods/Gradle dependency, even though both are published (see the table above). Vendoring
keeps an `@appduct/react-native` install free of a separate SwiftPM/Maven resolution step, and
keeps the RN package's npm release independent of the native registries (Maven Central's final
publish is a manual step). `packages/react-native/scripts/sync-native-core.mjs` copies source
files straight into the RN package at build/publish time:

- `ios/Sources/AppductCore/Real/*.swift` → `packages/react-native/ios/Core/` (only `Real/` — the
  RN pod always compiles with `-DAPPDUCT_ENABLED` set, so it never needs `Stub/`)
- `android/core/src/main/java/**` → `packages/react-native/android/core/`
- `android/core-noop/src/main/java/**` → `packages/react-native/android/core-noop/`

**The facade-exclusion rule.** Both copies above exclude the plain-app facade files —
`AppductAPI.swift` on iOS; `Appduct.kt`, `AppductInitProvider.kt`, `AppductLinkActivity.kt`
on Android — via an explicit filter in `sync-native-core.mjs`
(`IOS_FACADE_FILES`/`ANDROID_FACADE_FILES`). The RN bridge owns its own `AppductClient` and must
never end up with a second one behind a vendored `Appduct.shared`/`Appduct` object competing
for the same process-memory resume lease (see "RN apps must not touch the facade" above); Android's
init `ContentProvider` and deep-link trampoline `Activity` exist only for plain apps too (RN routes
links through `Linking` instead) and must never be declared in the RN module's own manifest, which
they would be if their sources were copied in — `sync-native-core.mjs` only copies `src/main/java`,
never `AndroidManifest.xml`, so even an accidentally-vendored provider/activity source file would
compile without registering, but excluding the files outright is the belt to that suspenders.

These vendored directories are gitignored in the RN package but included in its published npm
tarball (see `.npmignore`/`package.json#files`), so a consumer installing `@appduct/react-native`
from npm gets the vendored sources without ever needing this directory or a SwiftPM/Maven
dependency resolution step.

## Build variants: how each consumer excludes the real implementation

Inclusion never depends on a runtime build-type check. In every case below, an excluded
configuration's build does not contain the real implementation's code at all.

**iOS, SwiftPM.** Every file under `Sources/AppductCore/Real/` is wrapped in
`#if APPDUCT_ENABLED`, with a same-API no-op mirror under `Stub/` wrapped in
`#if !APPDUCT_ENABLED`. The `AppductCore` target's `swiftSettings` define `APPDUCT_ENABLED` for
the `Debug` configuration, plus for any configuration that opts into the `AlwaysEnabled`
package trait. It is a trait rather than a second product because a target's sources (and so
its active `#if` branches) are shared by every product built from it; a second "always-real"
product could not compile different content from the first. It is a compiler define rather
than a linking decision because a SwiftPM `TargetDependency` cannot be conditioned on build
configuration the way a CocoaPods dependency can.

**iOS, CocoaPods.** The repo-root `AppductCore.podspec` is linked with
`:configurations => ['Debug']` by the consuming app. `@appduct/react-native`'s own
`Appduct.podspec` vendors only `Real/` and always compiles it with `-DAPPDUCT_ENABLED`:
autolinking (its `react-native.config.js` sets `ios.configurations` from `APPDUCT_ENABLED`)
has already decided inclusion by the time those sources compile.

**Android, plain app.** `debugImplementation(core)` / `releaseImplementation(core-noop)`, a
real per-variant dependency decision. `core-noop` has the same public API, no `okhttp`
dependency, no marker class and no manifest entries.

**Android, vendored into `@appduct/react-native`.** The RN Gradle project cannot be restricted
per variant with autolinking's `buildTypes`: the package registers statically
(`packageInstance`), and React Native's generated `PackageList.java` is one file shared
unfiltered across every variant, so restricting linking would leave it referencing a class
missing from an unlisted variant's classpath (a compile error, not an inert build). So the RN
project links into every variant, `AppductPackage`/`NativeAppductModule`
(`android/src/main/java`) always compile and reference `AppductConnectionManager` and friends
by unqualified name, and `android/build.gradle` adds one vendored directory to each variant's
`java.srcDirs`: `debug` always gets `android/core`; `release` gets `android/core` when
`APPDUCT_ENABLED` is `1`/`true` and `android/core-noop` otherwise.

**Doctor markers.** Each real implementation carries a marker compiled only into it, never
into the stub or no-op: `AppductCoreMarker` (an `@objc` class, iOS) and `AppductNativeMarker`
(Android, protected by a keep rule). `appduct doctor` decides presence from that marker alone,
never from a package or class name or a manifest/plist key that a no-op build shares with the
real one. `@appduct/react-native`'s podspec and `android/build.gradle` also print `[appduct] native module INCLUDED in this
build` when the real implementation is linked, as an early warning; `doctor` against the signed
artifact is the authority.

## Fixtures and task notes

- [`../../packages/native/fixtures/README.md`](../../packages/native/fixtures/README.md) — the
  cross-language conformance vectors (bootstrap payloads and links, tool descriptors, event
  descriptors and event registry frames, close codes, the SPKI pin) that the TypeScript, Swift, and Kotlin test suites all read from one place, so a
  future change to one implementation's parsing/validation rules can't drift from the other two
  without a test failing ([`../tasks/17-conformance-fixtures.md`](../tasks/17-conformance-fixtures.md)).
- [`../tasks/14-native-core-extraction.md`](../tasks/14-native-core-extraction.md) — phase 1, the
  mechanical extraction and the vendoring/build-variant decisions.
- [`../tasks/15-native-session-logic.md`](../tasks/15-native-session-logic.md) /
  [`../tasks/16-android-session-logic.md`](../tasks/16-android-session-logic.md) — phase 2, porting
  the session lifecycle into Swift/Kotlin.
- [`../tasks/18-ios-entry-points.md`](../tasks/18-ios-entry-points.md) /
  [`../tasks/19-android-entry-points.md`](../tasks/19-android-entry-points.md) — phase 3, the
  plain-app facades and native playgrounds.
- [`../tasks/21-native-core-integration.md`](../tasks/21-native-core-integration.md) — where every
  decision and phase of issue #48 landed, end to end.

## Related

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §11 — the SDK entry points and client behavior this
  core implements.
- [`../BUILD-VARIANTS.md`](../BUILD-VARIANTS.md) — the user-facing inclusion rules and how to verify
  them with `appduct doctor`.
- [`../SECURITY.md`](../SECURITY.md#configuring-trust) — trust modes, pins, and the same keys a
  plain native app sets.
