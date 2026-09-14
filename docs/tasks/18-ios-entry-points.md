# 18 — iOS app-facing entry points and native playground (Phase 3 of issue #48, iOS)

**Depends on the phase 2a merge** ("phase 2a (Swift core, iOS bridge, JS thin client)" into
`feat/native-core`) — `CordieriteClient` and its `+Session`/`+ToolInvocation` extensions
(`docs/tasks/15-native-session-logic.md`) already own the whole session lifecycle; this task adds
nothing to that state machine. Two sibling PRs cover the same phase for Android
(`packages/native/android`, `packages/cordierite`'s scheme discovery) and are out of scope here —
this task touches only `packages/native/ios/**`, the repo-root `Package.swift`, a new
`playground-native/ios/**`, a new `packages/native/ios/README.md`, and this file.

## Goal

Give a plain iOS app (no React Native, no Expo) the same three things
`@cordierite/react-native` gives a React Native app — register a tool, forward a deep link, read
connection state — without making that app touch `JSONValue`, `ToolDescriptor`'s wire shape, or
`CordieriteClient`'s actor directly. Issue #48's phase-3 sketch names the shape:

```swift
Cordierite.shared.register(name:description:inputSchema:...) { args in ... }
ContentView().onOpenURL { Cordierite.shared.handle($0) }
```

This task builds exactly that facade, a unit-test suite for it, a native SwiftUI playground app
that exercises it end-to-end, and the docs a plain-app integrator needs.

## The facade (`Sources/CordieriteCore/Real/CordieriteAPI.swift` + `Stub/CordieriteAPIStub.swift`)

`public final class Cordierite: Sendable` wraps one `CordieriteClient` instance. `Cordierite.shared`
is a `static let` — Swift's own thread-safe, exactly-once lazy initializer — so "first access
constructs the client and starts `restoreSession()` in the background" (Decision 3 below) is well
defined without an explicit `configure()`/`setup()` step the app could forget to call. The
initializer itself is `internal`, not `private`: a plain app (a different module) can only ever
reach a `Cordierite` through `.shared`, but `CordieriteAPITests.swift`
(`@testable import CordieriteCore`) uses it directly to wrap a scripted `FakeTransportSession`
instead of a real `CordieriteConnectionManager` — the same pattern
`CordieriteClientTests.swift` already established for the client itself.

Every method mirrors one already on `CordieriteClient`, translated across the `[String: Any]`
boundary (Decision 1) — `register` (two overloads, with and without `ToolCallContext`), `handle(_:)`,
`postEvent`, `restoreSession()`, `disconnect()`, plus synchronous `state`/`sessionId`/`buildConfig`
snapshots and one unified `addListener` replacing `CordieriteClient`'s three separate
`onStateChange`/`onSessionChange`/`onError` registrations. `ToolRegistration` and `Subscription`
(the two handles `register`/`addListener` return) both have a `deinit`-does-nothing contract,
matching `@cordierite/react-native`'s `registerTool(...).remove()` — an app that drops the handle
without calling `.remove()`/`.cancel()` keeps the registration/subscription alive, on purpose.

`Stub/CordieriteAPIStub.swift` mirrors the same public API as inert no-ops, exactly like
`Stub/CordieriteClientStub.swift` does for the client itself — see Decision 4 for the one place its
answer deliberately differs from the client stub's.

## Decisions

1. **The `[String: Any]` boundary converts by the same rules `JSONSerialization` uses, but throws
   instead of coercing an unrepresentable value to `null`.** `JSONValue.from(foundation:)` (the
   existing wire-parsing helper) already has a `default: return .null` case, correct for parsing
   JSON that was already validated — but wrong for a Swift value an app handed the facade directly
   (a `Date`, `Data`, or custom type), where silently answering `null` would hide a real bug. The
   facade's own `jsonValue(fromFoundation:)` (private to `CordieriteAPI.swift`) is structurally
   identical but throws on that case instead; a tool handler's return value that fails this
   conversion is reported as `CordieriteToolHandlerError(type: "tool_serialization_error", ...)` —
   the exact wire error type and message text `CordieriteClient+ToolInvocation.swift`'s
   `respondSuccess` already produces when a well-formed `JSONValue` turns out to contain a
   non-finite number. An app-side conversion failure and a core-side one now look identical on the
   wire, which is the point: nothing about *why* a result failed to serialize should be visible to
   the CLI/agent on the other end of the socket.
2. **`inputSchema`/`outputSchema` are `[String: Any]?`, not a typed schema object.** Matches
   Decision 4 in issue #48 verbatim: native does no schema derivation and no input validation,
   raw JSON Schema is the entire contract. A malformed schema value (not convertible to a JSON
   object) is reported as a `ToolDescriptorValidationError` at `register(...)` call time — a
   registration-time failure, distinct from a tool-*result* conversion failure (Decision 1), since
   nothing has been sent to the daemon yet.
3. **`Cordierite.shared`'s first access starts `restoreSession()` in the background, not on the
   result of that call.** `restoreSession()` is `async`; a `static let` initializer cannot itself be
   `async`, so the initializer fires a detached `Task` and returns immediately — mirroring how
   `CordieriteClient.init` itself defers its own transport/foreground wiring to a `Task` for exactly
   the same "can't await inside a synchronous initializer" reason (see that initializer's own doc
   comment). An app that wants to know *whether* a lease was actually recovered calls
   `await Cordierite.shared.restoreSession()` itself — idempotent, since the underlying
   `CordieriteClient.restoreSession()` is a no-op once `heldSession` or `clientState` has already
   moved past idle/closed.
4. **The stub facade's `state` is `.closed`, not `.idle`.** `Stub/CordieriteClientStub.swift`
   answers `.idle` for the same reason `CordieriteConnectionManager`'s own stub does — a stub build
   never attempts a connection at all, so there is no "closed" to report. The facade's stub instead
   answers `.closed`: `.closed` is the state the *real* facade eventually settles into once a
   session is definitely gone, so a caller that only branches on "is anything live right now"
   (rather than distinguishing "never tried" from "tried and ended") gets the answer that
   generalizes correctly across both builds. This is a narrow, deliberate divergence from the
   client stub's own choice, documented at the call site (`Cordierite.state`'s doc comment) rather
   than silently inconsistent.
5. **`ClientState` and `BuildConfig` are new public names, not the existing internal/public types
   renamed.** `CordieriteClientState` is already `public` and used by the RN bridge
   (`event.state.rawValue`); renaming it to match the issue's `ClientState` sketch would ripple into
   that unrelated file for no behavioral benefit, so the facade exposes
   `public typealias ClientState = CordieriteClientState` instead. `CordieriteBuildConfig`
   (`CordieriteConnectionManager.swift`) is `internal`, not `public` — a `public typealias` cannot
   point at an internal type, so `BuildConfig` is a small new public struct with the same three
   fields, populated from `currentCordieriteBuildConfig()` (itself internal, callable directly since
   `CordieriteAPI.swift` lives in the same module).
6. **The playground app's Xcode project is generated by `xcodegen` from `project.yml`, not
   committed.** `brew install xcodegen` was already available in this environment; `project.yml`
   is one declarative, diffable source of truth for the target's settings (mirroring
   `Package.swift` being the one source of truth for the Swift package itself), and there is
   nothing app-specific in the generated `.xcodeproj` worth hand-maintaining or merge-conflicting
   over. The `.xcodeproj` is gitignored (`.gitignore`'s new
   `playground-native/ios/*.xcodeproj` entry).
7. **The playground targets iOS 15.1** — matching `Package.swift`'s `.iOS("15.1")` platform floor
   for `CordieriteCore` itself, so the example app never claims API availability the SDK's own
   minimum deployment target couldn't support. Concretely this meant `ContentView.swift` uses
   `NavigationView`/plain `HStack` rows instead of `NavigationStack`/`LabeledContent` (both iOS
   16+); caught by `xcodebuild`, not by inspection.
8. **No `CordieriteTrust`/`CordieriteCliPins` in the playground's `Info.plist`.** Unlike
   `playground/app.json` (the Expo playground), which pins a fixture key for CI repeatability, the
   native playground is meant to demonstrate the zero-config path: it trusts whatever pin
   `cordierite link` puts on the deep link for that session (`trust: "link"`).

## The `[String: Any]` boundary, precisely

- Args: the core hands the facade a `JSONObject` (`[String: JSONValue]`); the facade converts every
  value with the existing `JSONValue.foundationValue` accessor before calling the app's handler —
  this direction already existed and needed no new code.
- Results: the app's handler returns `Any?`; the facade converts with
  `jsonValue(fromToolResult:)` → `jsonValue(fromFoundation:)` (Decision 1). `nil` maps to `.null`
  (matching the core's own `respondSuccess` accepting a bare `.null` result).
- Schemas/payloads (`inputSchema`, `outputSchema`, `postEvent`'s `payload`): converted the same way,
  but a failure here throws immediately from the calling method (`register`/`postEvent`) rather
  than producing a wire error, since nothing has reached the daemon yet at that point.

## Verification

Run from the worktree root (`/Users/szymon.chmal/Projects/cordierite/.claude/worktrees/agent-a0e98193bb5e2cd5a`)
unless noted.

- **`swift build -c debug`, `swift build -c release`, `swift build -c release --traits
  AlwaysEnabled`** — all pass, each with the facade's new files (`CordieriteAPI.swift`,
  `CordieriteAPIStub.swift`) compiled into the module.
- **`swift test`** — 120/120 pass: the 108 pre-existing tests unchanged, plus 12 new
  `CordieriteAPITests` covering exactly the list this task's brief named: register → snapshot
  contains the descriptor (`testRegisterAddsDescriptorToSnapshot`), a tool call → handler runs,
  `[String: Any]` round-trips, and the result reaches the wire
  (`testToolCallRunsHandlerAndResultReachesTheWire`, `testToolCallContextOverloadReceivesCallMetadata`),
  an unserializable result maps to `tool_serialization_error`
  (`testUnserializableResultSendsToolSerializationError`), `handle(url)` routes a valid bootstrap
  link and ignores an unrelated one (`testHandleRoutesAValidBootstrapLink`,
  `testHandleReturnsFalseForUnrelatedUrl`), `remove()` sends the registry delta
  (`testRemoveSendsRegistryDeltaAndDropsTheDescriptor`), and a listener receives state/session
  change events (`testListenerReceivesStateChangeEvents`, `testListenerReceivesSessionChangeEvents`).
- **`playground-native/ios`: `xcodegen generate`, then `xcodebuild build` for both `Debug` and
  `Release`** (`-sdk iphonesimulator -destination 'generic/platform=iOS Simulator'
  CODE_SIGNING_ALLOWED=NO`) — both `** BUILD SUCCEEDED **`.
- **`cordierite doctor <built .app>`** against both configurations of the playground:
  - Debug: `Present true`, `Signals ios-core-marker-symbol, ios-info-plist-keys`,
    `Assertion present (holds)` with `--assert-present`. (No `ios-objc-class-symbol` this time —
    that signal is `RCTNativeCordierite`, an RN-only class; this app has no RN bridge at all, and
    the marker symbol alone is already sufficient for `present`, per Decision 3 in
    `docs/tasks/14-native-core-extraction.md`.) `ios-info-plist-keys` fires even though this
    playground's `Info.plist` sets none of the three trust keys — that signal matches the literal
    strings `CordieriteCliPins`/`CordieriteTrust`/`CordieriteAllowPrivateLanOnly` anywhere in the
    binary, and the real `CordieriteConnectionManager` compiles those exact string constants in
    regardless of whether the app's own `Info.plist` sets the keys.
  - Release: `Present false`, `Signals none`, `Assertion absent (holds)` with `--assert-absent`.
- **End-to-end in the iOS Simulator — completed**, unlike the two earlier attempts recorded in
  `docs/tasks/15-native-session-logic.md`/the phase-2a merge notes (both blocked by this kind of
  environment's network sandboxing on port 8081). That blocker doesn't apply here: this playground
  has no Metro, no RN, and no port 8081 dependency at all, so there was no JS bundle version
  mismatch to hit.

  - Booted `iPhone 16 Pro` (`62C30121-D00F-4898-819A-EB46BB444074`, iOS 18.0 — already booted in
    this environment; used as-is rather than booting a second one).
  - `xcrun simctl install`/`launch` the Debug `.app`; confirmed on screen (State `idle`, Session
    `none`, Trust `link`) via the iOS Simulator control tool's screenshot.
  - Private daemon: `CORDIERITE_STATE_DIR=/tmp/cordierite-3a-state`, `config.json` with
    `{"wssPort": 8455}` (8443 was free, but followed the brief's suggested override anyway),
    started implicitly by the first CLI call against that state dir.
  - `cordierite link --scheme cordierite-native --open ios-sim --device
    62C30121-D00F-4898-819A-EB46BB444074` → `Delivered yes (ios-sim)`.
  - **Discovery, not a defect:** `xcrun simctl openurl` on this Simulator/iOS version presents an
    "Open in *App*?" confirmation as a **native macOS sheet drawn by `Simulator.app` itself**
    (an `AXSheet`/`AXButton` pair inspectable and clickable via macOS Accessibility/`System
    Events`), not as an in-device SpringBoard alert. The iOS-Simulator-control tool's device-space
    `tap`/`inspect` (which drive the *simulated touch surface*) cannot see or dismiss it for
    that reason — confirmed by testing `tap` at multiple coordinates and by `inspect` consistently
    reporting "not available right now" while the sheet was up. Dismissed it instead via
    `osascript`/`System Events`, clicking the `AXButton` at the real macOS screen coordinates
    `System Events`' own accessibility tree reported (`click e` on the `AXButton` whose `position`
    had `x = 740`, the right-hand "Otwórz"/Open button). Once dismissed, in-app SwiftUI buttons
    *did* respond to the control tool's own device-space `tap` normally (converting the tool's
    reported screenshot pixels to its stated `402×874`-point coordinate space) — only the
    Simulator-chrome-level sheet needed the macOS-side workaround. A real device's Safari/Messages
    equivalent of this confirmation is dismissed by an actual human tap, so this is purely a
    simulator-automation wrinkle, not something `Cordierite.shared.handle(_:)` needs to account
    for.
  - Once dismissed: `state -> connecting` then `state -> active`, `session -> <id> as iphone` —
    all visible live in the playground's own "Recent activity" log (fed by `addListener`), and via
    `cordierite ls`.
  - `cordierite tools` → all five (`sum`, `call_count`, `reset_counter`, `slow_task`,
    `throwing_tool`), matching `playground/app/(tabs)/index.tsx` name-for-name.
  - `cordierite invoke sum --input '{"a":2,"b":3}'` → `{"total": 5}`.
  - `cordierite invoke call_count --input '{}'` → `{"count": 1}` (bumped by the `sum` call above).
  - `cordierite invoke throwing_tool --input '{}'` → `tool_execution_error`,
    `"throwing_tool always fails on purpose."` — the app's own thrown `Error`, translated through
    the core's generic (non-`CordieriteToolHandlerError`) failure path.
  - `cordierite invoke reset_counter --input '{}'` → `{"count": 0}`.
  - `cordierite invoke slow_task --input '{}'` → `{"done": true}` after ~1.6s (progress reports not
    separately captured by `invoke`, but the call's duration confirms the three 500ms progress
    steps ran).
  - Tapped "Post playground_button_tap" in the app (in-app tap, device-space coordinates, no
    macOS-side workaround needed); `cordierite events --since 0` shows
    `app_event iphone {"name": "playground_button_tap", "payload": {"callCount": 1}, ...}` —
    the exact payload the button handler sent.
  - Background/foreground: pressed the Simulator's Home button
    (`mcp__Claude_Code_iOS_Simulator__control` `button` action) → `cordierite ls` reported the
    session `suspended`. Re-launching via `xcrun simctl launch` brought the app back showing
    `State idle`, `Session none`, an empty activity log — i.e. a **fresh process**, not a resumed
    one: this environment's Simulator evidently terminated the backgrounded process rather than
    merely suspending it (a Simulator memory-management choice, not something under this task's
    control). This still exercised the code path worth exercising —
    `Cordierite.shared`'s first access on the new process called `restoreSession()` in the
    background, found no process-memory lease (correctly, since that lease is scoped to the
    process that died — "process-memory", not persisted), and settled at `.idle` without hanging
    or crashing. The *within-grace, same-process* resume path is already covered by
    `CordieriteClientTests`' `testRestoreSessionStartsResumeFromAValidLease` and this task's own
    facade tests exercise the same client underneath; this simulator's backgrounding behavior made
    re-demonstrating it live impractical within this task's time budget.
  - Cleaned up: `cordierite daemon stop`, `xcrun simctl terminate`, detached the Simulator control
    panel.

## Deviations from issue #48

- The issue's phase-3 sketch shows `register` taking only `inputSchema` before the trailing
  handler closure; this implementation also exposes `outputSchema`, `annotations`, and `timeoutMs`
  as optional parameters (all default `nil`), matching every field `ToolDescriptor` already
  supports and every field the JS `registerTool` already exposes. Omitting them here would have
  made the native API strictly less capable than the JS one for no reason stated in the issue.
- The issue's sketch shows no explicit listener/state-observation API; `addListener` and the
  synchronous `state`/`sessionId`/`buildConfig` snapshots are additions needed to actually build
  the playground app's UI (and named in this task's own brief as required facade surface), not
  present in the issue text itself.
- `packages/native/README.md`'s "How a plain native app will consume this (Phase 3)" section
  still reads "Not yet built" as of this task — that file is explicitly out of this task's scope
  (the task brief lists it as a file to stay out of, presumably because a sibling PR or a follow-up
  owns the top-level `packages/native` docs). This is known, pre-existing staleness this task
  deliberately did not fix.
- CocoaPods trunk / SwiftPM tag publishing for `CordieriteCore` (named in the issue's phase-3 scope)
  was not done: this task's own brief scopes it to "app-facing entry points ... plus a native
  SwiftUI playground app," and actually cutting a release/publishing to a package registry is a
  repository-wide release-process decision outside an isolated worktree. `packages/native/ios/README.md`
  documents the SwiftPM/CocoaPods usage as it will work once published, matching the version
  already single-sourced from `packages/react-native/package.json` (`CordieriteCore.podspec`).
