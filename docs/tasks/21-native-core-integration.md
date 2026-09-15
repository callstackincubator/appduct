# 21 — Native core integration (issue #48, final wiring)

**Depends on tasks 14–20** (every phase of issue #48 has landed on `feat/native-core`). This task
does no new native/CLI work — it wires the native playgrounds into CI, brings the top-level docs in
line with what was built, runs full verification on the combined tree, and records this table:
where every Decision and Phase bullet in [issue #48](https://github.com/callstackincubator/cordierite/issues/48)
actually landed, or why it didn't.

## Decisions (issue #48)

| # | Decision | Where it landed | Status |
| --- | --- | --- | --- |
| 1 | Session logic single-sourced in native (reconnect, grace, lease restore, registry snapshots/deltas, timeouts, cancel, progress live in Swift/Kotlin once, shared by RN and native consumers) | `packages/native/ios/Sources/CordieriteCore/Real/CordieriteClient*.swift`, `packages/native/android/core/src/main/java/.../CordieriteClient.kt` (`docs/tasks/15-native-session-logic.md`, `docs/tasks/16-android-session-logic.md`) | **Done** |
| 2 | Release exclusion structural per platform, always fails closed (Android two artifacts; iOS CocoaPods `:configurations`; iOS SwiftPM define + trait; no runtime checks anywhere) | Android: `packages/native/android/core`/`core-noop`, `android/build.gradle`'s `java.srcDirs` swap (RN) / `debugImplementation`+`releaseImplementation` (plain app). iOS CocoaPods: `packages/native/ios/CordieriteCore.podspec` + `packages/react-native/Cordierite.podspec`'s `:configurations => ['Debug']`. iOS SwiftPM: `Package.swift`'s `.when(configuration: .debug)` + `AlwaysEnabled` trait (`docs/tasks/14-native-core-extraction.md`) | **Done**, with the SwiftPM shape changed — see "Known changes" below |
| 3 | `cordierite doctor` is the guarantee (marker-symbol-only presence on both platforms; marker never compiled into the no-op/stub; release pipelines run `doctor --assert-absent` as a blocking step) | `CordieriteCoreMarker` (iOS, `docs/tasks/14-native-core-extraction.md`), `CordieriteNativeMarker` (Android, pre-existing, unchanged). CI: `.github/workflows/test.yaml`'s `android`/`ios` jobs, now including the native playground legs added by this task | **Done** |
| 4 | Schemas on native are raw JSON Schema (`[String: Any]`/`JSONObject`); no app-side input validation on native | `CordieriteToolDescriptor`/`CordieriteToolRegistry` on both platforms; `Cordierite.register`'s `inputSchema`/`outputSchema: [String: Any]?`/`JSONObject` (`docs/tasks/15-native-session-logic.md`, `docs/tasks/18-ios-entry-points.md` Decision 2) | **Done** |
| 5 | Public JS API unchanged (`useCordieriteTool`, `registerTool`, `postEvent`, the listener surface); only the TurboModule spec shrinks | `packages/react-native/src/public-api.ts`, `NativeCordierite.ts` (frozen spec, `docs/tasks/15-native-session-logic.md`) | **Done** |

## Phases (issue #48)

| Phase | What it covers | Where it landed | Status |
| --- | --- | --- | --- |
| 0 | Fail-closed autolinking fallback (`CORDIERITE_ENABLED` unparseable → `devOnly`, not `everyBuild`) | `packages/react-native/react-native.config.js` (pre-`feat/native-core`, per `docs/tasks/14-native-core-extraction.md`'s own header: "fixed and committed before any of the rest of this work") | **Done** |
| 1 | Extract the core (mechanical, no behavior change): `packages/native` layout, vendoring script, doctor anchors | `packages/native/{ios,android}`, `packages/react-native/scripts/sync-native-core.mjs`, `docs/tasks/14-native-core-extraction.md` | **Done** |
| 2 | Move session logic into the core (iOS/JS + Android halves), cross-language conformance fixtures | `docs/tasks/15-native-session-logic.md`, `docs/tasks/16-android-session-logic.md`, `docs/tasks/17-conformance-fixtures.md`, `packages/native/fixtures/` | **Done** |
| 3 | Native entry points and packaging: `Cordierite.shared`/`Cordierite` facades, native playgrounds, `cordierite init`/scheme discovery, publishing | `docs/tasks/18-ios-entry-points.md`, `docs/tasks/19-android-entry-points.md`, `docs/tasks/20-cli-native-scheme-discovery.md`, `playground-native/{ios,android}` | **Done except publishing** — see below |
| — | Publish `CordieriteCore` to CocoaPods trunk / a SwiftPM tag, `core`/`core-noop` to Maven Central | Not done | **Ops task, deliberately not performed** (below) |
| — | Wire native playgrounds into CI, bring top-level docs in line, run full verification on the combined tree | This task: `.github/workflows/test.yaml`, `docs/CI.md`, `README.md`, `packages/native/README.md`, `docs/ARCHITECTURE.md`, `docs/BUILD-VARIANTS.md`, `docs/SECURITY.md` | **Done** — verification results below |

## Known changes (called out in the issue-adjacent task briefs, recorded here for one-stop reference)

- **The second SwiftPM product became the `AlwaysEnabled` trait.** The issue's Decision 2 reads
  as if `CordieriteCoreAlways` would be a second SwiftPM *product*. A target's sources — and
  therefore which `#if CORDIERITE_ENABLED` branch is active — are shared by every product built
  from that target, so a second product pointed at the same target cannot compile different
  content from the first; a package *trait* controls the compiler define at the build-settings
  level instead, which is the level that actually needs to differ. `docs/tasks/14-native-core-extraction.md`
  documents this as a deliberate, verified departure (`swift build -c release --traits AlwaysEnabled`
  compiles the real files in a Release configuration).
- **Vendoring by copy, not a published-artifact dependency.** `@cordierite/react-native` copies
  `packages/native`'s sources in at build/publish time (`scripts/sync-native-core.mjs`) rather than
  depending on published CocoaPods/Maven artifacts, so the RN package's releases are never blocked
  on `packages/native` publishing infrastructure that doesn't exist yet (below).
  `docs/tasks/14-native-core-extraction.md` and `packages/native/README.md`.
- **`CordieriteConnectionManager.kt`'s hidden RN dependency, removed.** The issue's own text
  claimed the Android connection manager "imports only Android + OkHttp," but it also referenced
  `com.facebook.react.bridge.ReadableMap` by fully-qualified name — phase 1 changed
  `fromReadableMap(ReadableMap)`/`connect(ReadableMap)` to `fromMap(Map<String, Any?>)`/
  `connect(Map<String, Any?>)`, moving the one legitimate `ReadableMap` conversion into the RN
  bridge (`NativeCordieriteModule.kt`, via `.toHashMap()`). `docs/tasks/14-native-core-extraction.md`.
- **`sessionChange` carries only `{ sessionId, alias }`.** The frozen TurboModule spec's
  `CordieriteSessionChangeEventNative` dropped the pre-port `{ type, sessionId, alias, reason? }`
  shape — no `"claimed" | "resumed" | "lost"` discriminant, no `reason` (that lives on the paired
  `stateChange` event instead). `docs/tasks/15-native-session-logic.md` deviation 1,
  `docs/tasks/16-android-session-logic.md` deviation, `docs/ARCHITECTURE.md` §11.
- **`defaultToolTimeoutMs` is no longer app-configurable.** Timeout enforcement moved entirely to
  native, fixed at `CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS` (10 s, matching the old JS default); the
  frozen spec has no constructor-time parameter for JS to override it. A per-tool `timeoutMs`
  override still works, since it travels on the descriptor JSON.
  `docs/tasks/15-native-session-logic.md` deviation 2, `docs/ARCHITECTURE.md` §11.
- **Facade files excluded from RN vendoring.** `CordieriteAPI.swift` (iOS) and `Cordierite.kt`/
  `CordieriteInitProvider.kt`/`CordieriteLinkActivity.kt` (Android) are explicitly filtered out of
  `sync-native-core.mjs`'s copy (`IOS_FACADE_FILES`/`ANDROID_FACADE_FILES`) — an RN app must never
  end up with a second `CordieriteClient` behind a vendored facade racing the RN bridge's own
  client for the one process-memory resume lease. Landed in `e2ae379` (this worktree's starting
  commit) on top of the phase-3 merges; documented in `packages/native/README.md`,
  `docs/ARCHITECTURE.md` §11 (this task).
- **The Android bridge's cancel-reason and fractional-`timeout_ms` fixes.** `e2ae379`'s parent
  commit(s) closed two RN bridge gaps found in review: a cancel reason that wasn't reaching JS
  correctly, and `timeout_ms` accepting a fractional value where the wire contract requires a
  positive integer. Landed in the Android bridge (`packages/react-native/android`) before this
  task's starting commit; exercised (not just unit-tested) by this task's Expo-playground
  verification step below, which is the only thing in this repo that actually compiles and runs
  the RN bridge end to end.
- **Publishing to CocoaPods trunk / Maven Central / a SwiftPM tag is an ops task, not performed.**
  Every task brief from 14 onward says this explicitly (credentials, trunk registration, and CI
  publish wiring are release-process decisions, not something to do from an isolated worktree).
  `publishToMavenLocal` (this task's CI addition, and `docs/tasks/19-android-entry-points.md` §6)
  and local SwiftPM/CocoaPods paths are what's actually exercised; `packages/native/README.md`'s
  consumer table and `packages/native/ios/README.md`/`android/README.md`'s install instructions
  describe the published-artifact usage as it will work once that ops task happens.

## This task's own changes

- **CI** (`.github/workflows/test.yaml`): `ios` job now runs `xcodegen generate` +
  `xcodebuild` Debug/Release for `playground-native/ios`, each followed by the matching
  `cordierite doctor` gate; `android` job now runs `:app:assembleDebug :app:assembleRelease` for
  `playground-native/android` with the matching gates, and the standalone
  `packages/native/android` step gained `:core:publishToMavenLocal :core-noop:publishToMavenLocal`.
  `docs/CI.md` documents both under a new "Native playground gates" section.
- **Docs**: `README.md` (Packages table, Support, Getting started), `packages/native/README.md`
  (rewritten as the hub — three consumers, facade-exclusion rule, links), `docs/ARCHITECTURE.md`
  §11 (names both native consumers, states the facade-coexistence rule), `docs/BUILD-VARIANTS.md`
  (names all three exclusion mechanisms including the plain-app Maven dependency shape, restates
  the marker-only doctor rule and the "verify the signed artifact" guidance),
  `docs/SECURITY.md` (a paragraph per platform pointing a plain-app integrator at the same trust
  keys). `docs/PROTOCOL.md` checked — no wire-behavior change from any phase of issue #48, left
  untouched.

## Review fixes (issue #48 code review, on top of this task's own commit `bf7dfcf`)

A follow-up review pass found nine findings against the tree this task produced. Landed as one
commit per finding/logical group on `feat/native-core`; see the commit history for exact diffs.

1. **Kotlin cancellation acknowledgement never reached the wire.**
   `CordieriteToolInvoker.kt`'s `handleToolCancel`/`abortAllInFlight` cancel the handler's own
   coroutine `Job`, so by the time the `catch (CancellationException)` branch's `sendToolError`
   suspended through `CordieriteClient.rawSend`'s `suspendCancellableCoroutine`, the coroutine was
   already "Cancelling" and resumed with a forced `JobCancellationException` instead of the send's
   real outcome — silently turned into a spurious `phase="tool"` error by `sendSafely`'s
   `catch (Throwable)`. Fixed by wrapping every terminal-outcome send in
   `withContext(NonCancellable) { ... }`. `FakeCordieriteTransport` gained a `deferSendCompletion`
   mode (the default synchronous completion never exercises this path at all) and two regression
   tests, verified to fail without the fix.
2. **`sessionChange` lost `type`/`reason` — a public-API regression against `main` and against issue
   #48 decision 5.** Restored end to end: `NativeCordierite.ts` (the one sanctioned edit to the
   frozen TurboModule spec, recorded in its own header comment), `Cordierite.types.ts`/
   `client-types.ts`/`CordieriteModule.ts`/`client/index.ts`, the Swift core (`CordieriteClientTypes.swift`'s
   new `CordieriteSessionChangeKind`, emitted from `onAckReceived`/`finalizeSessionLost`/`disconnect`)
   and its bridge (`CordieriteTurboBridge.swift` + `RCTNativeCordierite.mm`), the Kotlin core
   (`CordieriteClient.kt`, the `Cordierite` facade's new `SessionChangeType`, mirrored in
   `core-noop`) and its bridge (`NativeCordieriteModule.kt`). Tests extended in all three suites for
   claim, resume, grace expiry, revoke (close 1000), a generic terminal close, and app disconnect.
3. **Neither native core clamped a declared tool `timeout_ms`.** The old JS registry clamped via
   `clampToolTimeoutMs` (`packages/shared/src/domains/tool-descriptor.ts`) before using the value as
   both the local abort timer and the wire value; ported to `CordieriteToolRegistry.upsert` on both
   platforms (still rejecting non-positive/non-integer values per PROTOCOL.md §5), with identically
   named bounds constants on both platforms pointing at the TS source, and `CordieriteClient.swift`'s
   bare `10_000` default replaced with a named constant matching Kotlin's existing one.
4. **JS `postEvent` silently demoted every native rejection to `logger.debug`.** Restored the old
   contract: a drop because no session is active is `logger.devWarn`; any other failure is
   `logger.warn` plus an `error` listener event. The two are distinguished by a new
   `E_CORDIERITE_NOT_ACTIVE` rejection code both bridges now use (iOS via the core's existing
   `CordieriteNotActiveError`; Android via a state guard in `NativeCordieriteModule`, since the
   Kotlin core's own `postEvent` stays a silent best-effort no-op for plain-app callers).
5. **`CordieriteModule.web.ts`'s `restoreSession`/`disconnect` didn't throw**, contradicting the
   file's own doc comment. Fixed to throw the same `unsupported(...)` error as `connect`/
   `registerTool`/`postEvent`; `noop-parity.test.ts` re-verified to still hold (`./noop` is a
   different, deliberately inert entry).
6. **Android descriptor/connect-input JSON parsing lived only in the RN bridge**, unlike the Swift
   equivalents already vendored in the core. Moved to `CordieriteToolDescriptor.fromJson`/
   `CordieriteConnectInput.fromJson` in `packages/native/android/core`'s `CordieriteClientTypes.kt`,
   mirrored in `core-noop`. Wiring `FixturesConformanceTest.kt`'s tool-descriptors case to the real
   `fromJson` (instead of a second hand-maintained parser) surfaced one real divergence — a
   non-string `description` silently coerced via `optString` instead of rejected, unlike the Swift
   bridge's strict `stringValue` — fixed in `fromJson` per this fixture suite's own rule that a
   divergence is fixed in the implementation, never the fixture.
7. **IPv6 literals were never bracketed** in either `CordieriteConnectionManager`'s daemon connect
   URL, unlike `formatAgentWebSocketUrl` (`packages/shared/src/domains/transport.ts`). Factored into
   a small pure `formatCordieriteWebSocketUrl` function on each platform (same name in both Swift
   and Kotlin), with unit tests.
8. **`artifact-inspect.ts`'s Android marker comment was stale**, still pointing at
   `packages/react-native/android/src/main/java`. Repointed at
   `packages/native/android/core/.../CordieriteNativeMarker.kt` and its `sync-native-core.mjs`
   vendored copy.
9. **Not done (optional, judged non-trivial): `sync-native-core.mjs`'s filename-based facade
   exclusion left as a list on both platforms.** A directory split (`Sources/CordieriteCore/API/`)
   would work for iOS but touches `Package.swift`'s target paths, `CordieriteCore.podspec`, and the
   RN podspec/vendoring script together; Android's public package name makes a subpackage split
   change the facade's import path, so a list is the only option there regardless. Left as-is on
   both platforms rather than risk destabilizing the packaging surface for a purely cosmetic change.

**Noted but deliberately not changed** (flagged during review, out of scope for this pass):

- The NaN/Infinity serialization divergence between the JS/Swift/Kotlin JSON layers (each rejects or
  coerces slightly differently at the edges) — a pre-existing cross-language wrinkle, not something
  this review's findings asked to unify.
- The pre-existing `configuredPins` TLS-delegate race in `CordieriteConnectionManager.swift` (a
  concurrently-in-flight `connect()` mutating `configuredPins` while the delegate reads it during
  the handshake) — a real but separate concern from anything this review's nine findings covered.

## Verification

Run from this worktree (`/Users/szymon.chmal/Projects/cordierite/.claude/worktrees/agent-a3ad3c9bae8781450`)
after fast-forwarding to `feat/native-core` (`e2ae379`) and making the changes above. See this
task's own commit(s) and the session report for exact commands/output; anything that could not be
run in this environment is called out there rather than claimed as passing.

See also the "Review fixes" section above for a second verification pass run in a later worktree
(`bf7dfcf` onward) against the nine code-review findings; that session's own report has the exact
commands/output for that pass.
