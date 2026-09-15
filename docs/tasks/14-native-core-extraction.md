# 14 — Extract a framework-free native core (Phase 0 + Phase 1 of issue #48)

**Depends on nothing in this directory. No parallel siblings — it touches almost every native
file in the repo.**

## Goal

Finish the split GitHub issue #48 describes: move the Swift and Kotlin connection code that
was already RN-free in spirit (TLS, SPKI pinning, trust-mode resolution, the private-LAN
check, keepalive, process-memory resume leases) out of `@cordierite/react-native` into a
canonical, framework-free location — `packages/native` — that plain iOS/Android apps will be
able to consume directly once Phase 3 publishes it. `@cordierite/react-native` becomes a thin
bridge that *vendors* those sources at build/publish time instead of owning them. Nothing
observable changes for RN consumers: same npm packages, same build variants, same
`cordierite doctor` contract (modulo the iOS signal addition below).

Also, first and separately: `packages/react-native/react-native.config.js` fell open (linked
into *every* build) on a malformed `CORDIERITE_ENABLED` value instead of falling closed —
fixed and committed before any of the rest of this work, since it's a one-line, independently
shippable bug fix.

## Layout

```
packages/native/                      # not an npm/pnpm workspace package -- no package.json
  README.md
  ios/
    Sources/CordieriteCore/
      Real/      *.swift              # #if CORDIERITE_ENABLED ... #endif
      Stub/      *.swift              # #if !CORDIERITE_ENABLED ... #endif, same API, no-ops
    Tests/CordieriteCoreTests/        # moved from packages/react-native/ios/CordieriteTests
    CordieriteCore.podspec
  android/
    settings.gradle, build.gradle, gradle.properties, gradlew(.bat), gradle/wrapper/*
    core/        build.gradle + src/main/java/... + src/main/AndroidManifest.xml
                 + consumer-rules.pro + src/test/**
    core-noop/   build.gradle + src/main/java/...  (same API, every method a no-op)
Package.swift                          # repo root -- SwiftPM requires it there for URL deps
```

## What moved (git mv, history preserved)

- iOS: `CordieriteConnectionManager.swift`, `CordieriteProcessResumeLeaseStore.swift`, and the
  XCTest suite → `packages/native/ios/Sources/CordieriteCore/Real` /
  `Tests/CordieriteCoreTests`.
- Android: `CordieriteConnectionManager.kt`, `CordieriteProcessResumeLeaseStore.kt`,
  `CordieriteNativeMarker.kt`, and the two Kotlin test classes → `packages/native/android/core`.
  `consumer-rules.pro` moved with them.
- Stayed in `packages/react-native` (the bridge): `CordieriteTurboBridge.swift`,
  `RCTNativeCordierite.mm`, `CordieritePackage.kt`, `NativeCordieriteModule.kt` — the last two
  also moved from `src/debug/java` to `src/main/java` in the same pass, since they now always
  compile (see "Android vendoring" below).

## Decisions and why

**Vendoring, not a dependency.** `@cordierite/react-native` does not depend on
`CordieriteCore`/`com.callstackincubator.cordierite:core` as a CocoaPods/Gradle dependency.
`packages/react-native/scripts/sync-native-core.mjs`, wired into this package's `build` and
`prepack` scripts, copies the sources in instead. Publishing `packages/native` independently
to CocoaPods trunk and Maven Central is deferred to Phase 3 of issue #48 — until that exists,
depending on it would block every RN package release on unrelated native-core publishing
infrastructure. The three vendored directories (`ios/Core`, `android/core`,
`android/core-noop`) are gitignored inside `packages/react-native` but deliberately **not**
excluded from the npm tarball (`.npmignore`), so an installed consumer gets them without ever
touching `packages/native`.

**SwiftPM manifest at the repo root, not in `packages/native`.** SwiftPM only resolves a
package as a `.package(url:)` dependency when `Package.swift` sits at the repository root —
there is no `path:` override for where the manifest itself lives, only for where the
manifest's targets read their sources from. `path: "packages/native/ios/Sources/CordieriteCore"`
in the target declaration keeps the actual files colocated with the rest of the native core;
only the one manifest file lives elsewhere.

**A trait instead of a second SwiftPM product.** The issue's Decision 2 asks for a
`Debug`-only define by default plus an opt-in "always real" build. The natural SwiftPM
expression of "two variants of the same library" is two products — but a target's *sources*
(and therefore which `#if` branch is active in them) are shared by every product built from
that target; SwiftPM has no notion of "the same files, compiled twice with different defines,
exposed as two products." A second product pointed at the same target would still get exactly
one set of compiler defines, decided once, the same as the first. So the two "editions" differ
only in which build settings apply to the one target/product, not in which files compile — a
`swiftSettings` condition (`.when(configuration: .debug)` plus `.when(traits: ["AlwaysEnabled"])`)
is the right level, not a second product. Verified: `swift build -c debug` compiles the real
files; `swift build -c release` compiles the stub; `swift build -c release --traits
AlwaysEnabled` compiles the real files again, in Release.

**Android core module has no `react-android` dependency — which required a small API change.**
The issue's own text claims `CordieriteConnectionManager.kt` "imports only Android + OkHttp,"
but the code as found also referenced `com.facebook.react.bridge.ReadableMap` by fully-qualified
name in `CordieriteConnectOptions.fromReadableMap` and `CordieriteConnectionManager.connect()`'s
public signature — a real, if undeclared, RN dependency that would have forced
`packages/native/android/core` to depend on `react-android` too, defeating the "framework-free"
point of the move and directly contradicting the issue's explicit "no react-android dependency"
requirement for this module. Fixed by changing `fromReadableMap(ReadableMap)` to
`fromMap(Map<String, Any?>)` and `connect()`'s parameter to the same plain map type; the RN
bridge (`NativeCordieriteModule.kt`, which stays in `@cordierite/react-native` and is the one
place that still legitimately needs `ReadableMap`) now converts via `ReadableMap.toHashMap()`
before calling in. Semantically identical (same field extraction, same validation), verified by
the unchanged `CordieriteConnectionManagerTest.kt` test suite (which never called `connect()`
directly, only the pure functions) continuing to pass unmodified.

**Android package name unchanged; AAR namespace changed.** The issue allows either keeping the
existing Kotlin package (`com.callstackincubator.cordierite`) for the moved classes or moving
them under a `.core` subpackage, calling the former "acceptable and lower-risk." Taken: touching
every import across the moved files and the still-RN-package bridge that references them by
simple name is unnecessary risk for a mechanical move. The AAR **namespace** (a separate AGP
concept — where a module's own generated `R`/`BuildConfig` land, not the Kotlin package its
classes declare) is `com.callstackincubator.cordierite.core` for both `core` and `core-noop`,
distinct from `@cordierite/react-native`'s own `com.callstackincubator.cordierite` namespace —
required since a consumer app links the RN module and one of `core`/`core-noop` into the same
build. `core` and `core-noop` share a namespace with each other safely, since exactly one is
ever on a given variant's classpath (`debugImplementation`-equivalent vs.
`releaseImplementation`-equivalent, expressed here as the `java.srcDirs` swap in
`android/build.gradle`, not as separate Gradle configurations).

**`packages/native` is not a pnpm/Turbo workspace member.** It has no `package.json`. pnpm's
`packages/*` glob silently skips a directory with no `package.json` (confirmed: `pnpm build`
and `pnpm test` at the root run cleanly with `packages/native` present, no workspace-resolution
error), and Turbo only ever operates over resolved pnpm packages. No explicit exclude entry was
needed in `pnpm-workspace.yaml` or `turbo.json`.

**iOS Stub choices (documented in code, repeated here for visibility):** `getState()` always
reports `"idle"`, matching the JS `/noop` entry's `getCordieriteState()`. `getConstants()`'s
`trust` reports `"excluded"` — a value no real trust resolution (`"pin"`/`"link"`/an echoed
invalid string) ever produces. `CordieriteCoreMarker` is deliberately **not** mirrored in the
stub: its only purpose is to prove the real implementation shipped.

**Android `core-noop` choices:** `getState()` → `"idle"`; `getResumeLeaseRecord()` → `null`;
`getBuildConfig()` → `trust = "excluded"` — the same value as the iOS stub, for the same reason
(a value real resolution never produces).

**`cordierite doctor` iOS detection tightened to match Android.** Added `CordieriteCoreMarker`
(an `@objc` class compiled only into `Real/`) as `ios-core-marker-symbol`. `present` on iOS is
now `ios-core-marker-symbol OR ios-objc-class-symbol` only — the Info.plist keys
(`CordieriteCliPins`/`CordieriteTrust`/`CordieriteAllowPrivateLanOnly`) are corroborating only
and can no longer flip `present` to `true` by themselves, since an app can author those keys by
hand without the real implementation being present. This mirrors the reasoning Android's
marker-only rule already documents.

## Native CI additions

- `.github/workflows/test.yaml`'s `ios` job runs `swift build -c release` (stub compile check)
  and `swift test` (the moved XCTest suite, `-c debug`) at the repo root, before the
  CocoaPods-based playground build — independent of Expo prebuild/`pod install`, so it fails
  fast. This replaces the old `Cordierite-Native-Tests` scheme, which was generated by
  `playground/scripts/create-cordierite-test-scheme.rb` from a `test_spec` in
  `Cordierite.podspec` — both are deleted now that all native tests live in the SwiftPM
  package. `playground/plugins/with-native-tests.js`, which existed solely to hand-add the
  `Cordierite` pod for that now-gone test target (and to skip doing so when the package was
  excluded — see `docs/tasks/13-ios-ci-doctor-gate.md`), is deleted too, along with its entry
  in `playground/app.json`'s plugin list. The codegen-coupling problem that plugin worked
  around no longer applies: there is no longer a hand-added pod to interact with an excluded
  build at all.
- `.github/workflows/test.yaml`'s `android` job runs
  `./gradlew :core:testDebugUnitTest :core-noop:assembleRelease` in `packages/native/android`,
  independent of the playground prebuild.
- Every existing `cordierite doctor` gate (four Android legs, two iOS legs) is unchanged in
  shape; only the iOS detection signal set (above) changed.

## Deviations from a strictly mechanical move

- The iOS and Android core moves landed in one commit instead of two (`git mv` had already
  staged both by the time the first commit was made) — the commit message covers both moves;
  this note is the paper trail for "commit in logical steps" not landing exactly as split as
  described.
- The `ReadableMap` → `Map<String, Any?>` change on Android (above) is a real, if narrow, API
  change — not appearance-only — made necessary by the "no react-android dependency"
  requirement the issue itself states for this module.
- `packages/react-native/android`'s own `src/test` is now empty (its two Kotlin test classes
  moved to `packages/native/android/core/src/test`); `:cordierite_react-native:testDebugUnitTest`
  still runs in CI and still passes, trivially (no test classes to run) — real coverage of the
  vendored sources' *behavior* lives in `packages/native/android`'s own test task, and
  `assembleDebug`/`assembleRelease` plus the `cordierite doctor` gates are what prove the
  vendored copy actually compiles and is detectable in each `CORDIERITE_ENABLED` state.

## Out of scope (left for later phases of issue #48)

- Publishing `packages/native` to CocoaPods trunk / Maven Central (Phase 3).
- Public native entry points (`Cordierite.shared` on iOS, a `Cordierite` object on Android) and
  native playground apps (Phase 3).
- Porting the TypeScript session-lifecycle/registry/tool-invocation logic into the core
  (Phase 2) — this task only moved code that was already framework-free in intent.
