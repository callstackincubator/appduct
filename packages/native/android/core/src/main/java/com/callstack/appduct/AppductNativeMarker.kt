package com.callstack.appduct

/**
 * Exists for exactly one reason: to give `appduct doctor` (`packages/appduct/src/artifact-inspect.ts`,
 * docs/tasks/10-android-detection-keep-rule.md) a detection anchor that survives R8/ProGuard minification
 * even when no other keep rule is configured for this package.
 *
 * Lives in `packages/native/android/core` (docs/tasks/14-native-core-extraction.md) and is vendored
 * into `@appduct/react-native` at build time by `scripts/sync-native-core.mjs` -- it is never
 * present in the `core-noop` module. `consumer-rules.pro` (shipped via `consumerProguardFiles` in
 * this module's `build.gradle`, and re-referenced from the vendored copy inside the RN package) keeps
 * this one class's fully-qualified name unminified and unremoved. Consumer apps never call it — it is
 * dead code from a reachability standpoint — so the keep rule is load-bearing: without it, R8 would
 * strip this class entirely, same as everything else with no live reference. Deliberately scoped to a
 * single class rather than the whole package, per the task's "keep the kept surface as small as
 * possible" requirement.
 *
 * Do not rename, delete, or move this class without updating `ANDROID_KEEP_MARKER_CLASS` in
 * `artifact-inspect.ts` and `consumer-rules.pro` in lockstep — the three must always agree on the same
 * fully-qualified name.
 */
internal object AppductNativeMarker
