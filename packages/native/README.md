# `packages/native`

The framework-free native core behind Cordierite: TLS-pinned session transport, SPKI pinning,
explicit trust-mode resolution, process-memory resume leases, and — since issue #48 phase 2 — the
entire app-side session lifecycle (claim/resume, reconnect backoff, grace-window recovery, the tool
registry and its wire deltas, per-call timeout/cancel/progress, and v2 bootstrap deep-link
handling), in plain Swift and Kotlin with no React Native dependency. See
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §11,
[`docs/tasks/14-native-core-extraction.md`](../../docs/tasks/14-native-core-extraction.md) (phase 1:
the mechanical extraction), and
[`docs/tasks/15-native-session-logic.md`](../../docs/tasks/15-native-session-logic.md) (phase 2:
this session-logic port) for how this split came to be and why.

## `CordieriteClient` (iOS)

`ios/Sources/CordieriteCore/Real/CordieriteClient.swift` (plus its `+Session`/`+ToolInvocation`
extensions) is a `public actor` on top of `CordieriteConnectionManager` that owns everything the
TypeScript client (`packages/react-native/src/client/*`) used to own. See
`docs/tasks/15-native-session-logic.md` for the full API and the RN bridge's continuation-per-call
protocol on top of it. The Kotlin equivalent is tracked separately (`docs/tasks/16-android-session-logic.md`).

This directory is **not an npm/pnpm workspace package** — it has no `package.json`, so
`pnpm-workspace.yaml`'s `packages/*` glob does not pick it up (pnpm silently skips a directory with
no `package.json`) and Turbo, which only ever operates over resolved pnpm workspace packages, never
sees it either. Nothing extra needed to be added to either config for that reason.

## Layout

```
ios/
  Sources/CordieriteCore/
    Real/      the real implementation, every file wrapped in `#if CORDIERITE_ENABLED`
    Stub/      a same-API no-op mirror, every file wrapped in `#if !CORDIERITE_ENABLED`
  Tests/CordieriteCoreTests/    XCTest suite (moved from packages/react-native/ios/CordieriteTests)
  CordieriteCore.podspec        CocoaPods consumption
android/
  core/        the real implementation as a standalone Gradle module
  core-noop/   same public API, every method a no-op -- no okhttp, no marker class
```

The repo-root [`Package.swift`](../../Package.swift) is the SwiftPM manifest for `ios/` — it has to
live at the repository root, not here, because SwiftPM only resolves remote package URL
dependencies (and therefore only lets another project depend on this repo via
`.package(url: ...)`) when the manifest sits at the repo root.

## How `@cordierite/react-native` vendors this

The RN package does **not** depend on `CordieriteCore` as a CocoaPods/Gradle dependency. Publishing
this core independently to CocoaPods trunk and Maven Central is deferred to Phase 3
(`docs/tasks/14-native-core-extraction.md`); until then the RN package's own releases would be
blocked on unrelated native-core publishing infrastructure if it depended on published core
artifacts. Instead, `packages/react-native/scripts/sync-native-core.mjs` copies source files
straight into the RN package at build/publish time:

- `ios/Sources/CordieriteCore/Real/*.swift` → `packages/react-native/ios/Core/` (only `Real/` — the
  RN pod always compiles with `-DCORDIERITE_ENABLED` set, so it never needs `Stub/`)
- `android/core/src/main/java/**` → `packages/react-native/android/core/`
- `android/core-noop/src/main/java/**` → `packages/react-native/android/core-noop/`

These vendored directories are gitignored in the RN package but included in its published npm
tarball (see `.npmignore`/`package.json#files`), so a consumer installing `@cordierite/react-native`
from npm gets the vendored sources without ever needing this directory or a SwiftPM/Maven
dependency resolution step.

## How a plain native app will consume this (Phase 3)

Not yet built. `docs/tasks/14-native-core-extraction.md`'s issue tracks the public entry points
(`Cordierite.shared` on iOS, the `Cordierite` object on Android), native playground apps, and
publishing this core to CocoaPods trunk and Maven Central so `packages/native` becomes a real
`.package(url:)`/Maven dependency instead of something only consumed by vendoring.
