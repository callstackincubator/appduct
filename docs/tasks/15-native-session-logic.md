# 15 — Move session logic into the native core (Phase 2 of issue #48, iOS + JS)

**Depends on task 14** (the mechanical core extraction). Covers the iOS core and the
JavaScript side only; the Android core and bridge (`packages/native/android`,
`packages/react-native/android`) are a parallel, independent PR against the same frozen
TurboModule spec — see `docs/tasks/16-android-session-logic.md` (written by that PR, not
this one).

## Goal

Port everything `packages/react-native/src/client/*`, `deep-link-core.ts`, and
`connect-helpers.ts` owned into the native core, so the same reconnect/registry/
tool-invocation logic that already exists once in Swift is available to a plain iOS app
too (Phase 3), and so `@cordierite/react-native` shrinks to a thin translation layer. Issue
#48's decision 1 ("session logic is single-sourced in native") and decision 5 ("the public
JS API does not change") are both binding; §5 of the issue's "Phases" section sketches the
resulting TurboModule spec.

## The frozen TurboModule spec

`packages/react-native/src/NativeCordierite.ts`, committed before this work started:

```ts
registerTool(descriptorJson: string): void;
unregisterTool(name: string): void;
handleUrl(url: string): boolean;
connect(inputJson: string, supersede: boolean): Promise<void>;
restoreSession(): Promise<boolean>;
disconnect(): Promise<void>;
postEvent(name: string, payloadJson: string | null): Promise<void>;
respondToToolCall(id: string, resultJson: string | null, errorJson: string | null): void;
reportToolProgress(id: string, progress: number | null, message: string | null): void;
getState(): string;
getSessionId(): string | null;
getRegisteredToolsJson(): string;
getConstants(): CordieriteBuildConfigNative;

onToolCall: EventEmitter<{ id, name, argsJson }>;
onToolCancel: EventEmitter<{ id, reason }>;
onStateChange: EventEmitter<{ state, reason? }>;
onSessionChange: EventEmitter<{ sessionId, alias }>;
onError: EventEmitter<{ phase, message, ... }>;
```

Every structured value crosses as a JSON string. Neither platform's bridge could change
this shape; both were built against it as-is.

## The core API (`packages/native/ios/Sources/CordieriteCore/Real/`)

`public actor CordieriteClient` sits on top of the existing `CordieriteConnectionManager`
(TLS, SPKI pinning, trust resolution, the wire handshake, keepalive, the resume lease
store — all untouched from task 14) and owns:

- **Tool registry** (`CordieriteToolRegistry.swift`) — `registerTool(_:handler:)`/
  `unregisterTool(_:)`/`registeredTools`, validated exactly like `@cordierite/shared`'s
  `isToolDescriptor` (name `^[a-zA-Z0-9_-]{1,64}$`, description 1–4096 chars, schemas as
  JSON objects, annotations as booleans, `timeout_ms` a positive integer). Deliberately
  **not** actor-isolated: `registerTool`/`unregisterTool` are synchronous, throwing
  TurboModule methods with no `Promise`, so validation and the mutation itself cannot wait
  on an actor hop. Guarded by a plain `NSLock` instead — the same pattern
  `CordieriteProcessResumeLeaseStore` already used for the identical reason. Sending the
  resulting `tool_registry_delta` frame is genuinely async and is fired off separately.
- **Session lifecycle** (`CordieriteClient+Session.swift`) — `connect`/`restoreSession`/
  `disconnect`/`handleUrl`, full-jitter reconnect backoff (`CordieriteBackoff.swift`, the
  same 0.5 s/30 s-cap/jitter constants as `client/backoff.ts`), grace-window recovery, and
  v2 bootstrap decode (`CordieriteBootstrap.swift`, a straight port of `@cordierite/shared`'s
  `decodeBootstrap` plus `bootstrap.ts`'s URL/expiry/private-IP layer). `handleUrl` is
  `nonisolated` and synchronous (matching the frozen spec's `boolean` return with no
  `Promise`): it answers `hasCordieriteBootstrapQuery(url)` immediately and does the actual
  decode/validate/supersede/connect work in a detached `Task`, reporting failures on
  `onError` — exactly the fire-and-forget shape the pre-port `handleCordieriteDeepLinkUrl`
  already had from a `Linking` listener's perspective.
- **Tool invocation** (`CordieriteClient+ToolInvocation.swift`) — dispatches incoming
  `tool_call`/`tool_cancel` wire frames, owns the per-call timeout timer, and classifies the
  outcome into the seven `tool_error` types `tool_not_found` (unregistered name, before a
  `ToolHandler` even runs), `tool_timeout`, `tool_cancelled`, `tool_execution_error`, and
  `tool_serialization_error` are entirely native's job; `tool_input_validation_error`/
  `tool_output_validation_error` stay JS's job (decision 4: native does no app-side schema
  validation) and reach the wire by the JS-side bridge handler throwing a typed
  `CordieriteToolHandlerError` that the core forwards verbatim.
- **Cancellation** is Swift's own cooperative `Task` cancellation, not a bespoke
  `AbortSignal`-alike type: the core cancels the `Task` running a call's handler on an
  explicit `tool_cancel` frame, its own timeout, or session suspension, and a handler
  observes it via `Task.isCancelled`/`try Task.checkCancellation()`. `ToolCallContext`
  exposes `cancelReason()` (`"client_cancelled"`/the wire reason, `"timeout"`, or
  `"session_suspended"`) so the RN bridge's proxy handler can forward the right reason on
  `onToolCancel` without re-deriving it.
- **Foreground/background** gating for the reconnect timer, via `UIApplication`
  notifications behind `#if canImport(UIKit)` (`CordieriteForegroundObserving`), mirroring
  the rules `client/index.ts`'s `AppState` listener applied — no timer scheduled while
  backgrounded; an immediate resume attempt on returning to foreground.

### Transport seam

`CordieriteTransportSession` is a small protocol matching the surface `CordieriteClient`
needs from `CordieriteConnectionManager` (the four `emit*` callbacks, `connect`/`send`/
`close`/`invalidate`, and the three synchronous snapshot readers). `CordieriteConnectionManager`
conforms to it with no changes beyond visibility (`public`) and giving its `emit*` closure
properties an explicit `@Sendable` type — both needed to satisfy strict concurrency once a
second, test-only conformer exists. `CordieriteClientTests.swift` supplies
`FakeTransportSession` (a scripted stand-in with `simulateAck`/`simulateClose`/
`simulateIncoming` helpers) and `FakeClientTimers` (a virtual clock with `advance(byMs:)`,
mirroring the role `client/timers.ts`'s fake `ClientTimers` played in the JS test suite), so
the whole reconnect/registry/tool-invocation state machine is tested without a real
TLS/WebSocket stack.

**Deviation from the literal instruction "testable with a scripted fake socket":** the seam
sits at the `CordieriteConnectionManager` level (a fake *transport session*), not at
`URLSessionWebSocketTask` itself. Rewriting `CordieriteConnectionManager`'s TLS/pinning/
socket-lifecycle internals to accept an injectable socket type was a materially larger,
independently risky change to code task 14 had just moved verbatim and which this task did
not otherwise need to touch; the chosen seam gives `CordieriteClient` the same test
independence from real networking while leaving `CordieriteConnectionManager` itself
alone.

## The RN bridge (`packages/react-native/ios/`)

`CordieriteTurboBridge.swift` owns one `CordieriteClient` and a `PendingToolCallStore`. The
`ToolHandler` installed for every JS-registered tool:

1. Emits `onToolCall(id, name, argsJson)`.
2. Suspends on `pendingToolCallStore.awaitAnswer(id)` — a `CheckedContinuation` wrapped in
   `withTaskCancellationHandler`, so the *core's* cancellation of this call's `Task` (via
   `tool_cancel`/timeout/suspension) resumes the continuation with `CancellationError`
   instead of hanging forever (a plain `withCheckedContinuation` does not observe task
   cancellation on its own).
3. On `CancellationError`, forwards `context.cancelReason()` to JS as `onToolCancel(id,
   reason)`, then rethrows so the core's own `cancelled`/`timedOut` bookkeeping decides the
   wire `tool_error` type exactly as it would for a native handler.
4. Otherwise returns the `JSONValue` JS answered with, or throws the `CordieriteToolHandlerError`
   JS rejected with (`respondToToolCall`'s `errorJson`) — both handled by the core's normal
   dispatch path.

`respondToToolCall`/`reportToolProgress` are fire-and-forget, synchronous TurboModule
methods (matching the frozen spec: no `Promise`); the bridge answers/forwards them by
completing the pending continuation or spawning a detached `Task` into
`client.reportToolProgress`. `registerTool`/`unregisterTool`/`handleUrl` are also
synchronous — `CordieriteClient`'s own methods for these are `nonisolated` for exactly this
reason (see above). `RCTNativeCordierite.mm` bridges a thrown Swift error from
`registerTool` to a synchronous Objective-C exception, which the TurboModule runtime
surfaces to JS as a rejected/thrown error the same way the old bridge's `reject()` callbacks
did for `connect`.

**Verified against real Codegen output** (see the verification section below): running
`expo prebuild`/`pod install` over the playground app generated the actual
`NativeCordieriteSpec` protocol from `NativeCordierite.ts`, which caught one real mismatch —
`handleUrl` is generated as returning `NSNumber *` (boxed), not a bare `BOOL`, because the
TurboModule bridging convention boxes every ObjC method return type crossing into JSI.
`RCTNativeCordierite.mm` was fixed to box it (`return @([_swift handleUrl:url]);`); every
other hand-written selector already matched the generated header exactly. The rest of the
signatures were originally written by extending the naming conventions the pre-existing,
working `.mm` file already demonstrated for `connect`/`getConstants` (Promise methods take
`resolve:`/`reject:` blocks; plain-type params keep their TS names).

## What stayed in JS, and why

Per decision 4 (native does no app-side schema validation) and decision 5 (nothing about
the public API changes), JS keeps:

- **Schema conversion and validation** (`schema.ts`, unchanged) — Standard Schema → JSON
  Schema export, and validating a handler's input/output against the *registered* schema.
  This is genuinely JS: it depends on whatever validation library the app chose.
- **Running the handler itself.** The RN bridge's continuation-per-call protocol (above)
  means a JS-registered tool's handler still runs in JS; native only owns the surrounding
  bookkeeping (timeout, cancel delivery, the registry, the wire frames).
- **`useCordieriteTool`, `public-api.ts`, and every root export** — untouched, same
  signatures, same behavior.
- **`bootstrap.ts`'s `parseBootstrapPayload`/`parseBootstrapUrl`** — kept for apps that
  parse a bootstrap link themselves without going through native's `handleUrl` (still
  exported from the root entry). Native independently ports the same decode logic
  (`CordieriteBootstrap.swift`) for its own `handleUrl`; the two never share code across the
  bridge, but they are ports of the same `@cordierite/shared` source and are tested against
  the same wire fixtures in spirit.

`client/index.ts` is now a thin translation layer: a local `Map` of tool name →
handler/schema (mirroring what native independently tracks, so JS never needs a round trip
to ask "is this tool registered"), an `AbortController` per in-flight call keyed by call id,
and mapping native's five events onto `addCordieriteListener`'s three kinds plus the
handler-dispatch path. `client/tool-invocation.ts` is the part of the old file that is still
inherently JS: schema validation, invoking the handler, and answering through
`respondToToolCall`/`reportToolProgress` — timeout, the wire frames themselves, and
`tool_not_found` are gone from it (native answers an unregistered name before ever emitting
`onToolCall`).

### Deleted (behavior moved to native, no JS copy kept)

`client/backoff.ts`, `client/registry.ts`, `client/resume-lease.ts`,
`client/terminal-close.ts`, `client/app-state.ts`, `client/real-app-state.ts`,
`client/timers.ts`, `deep-link-core.ts`, `connect-helpers.ts`, and their test files
(`backoff.test.ts`, `connect-helpers.test.ts`, `connect-options-parity.test.ts`,
`deep-link-bootstrap.test.ts`, `resume-lease-native-adapter.test.ts`). Each has a Swift
counterpart in `packages/native/ios/Sources/CordieriteCore/Real/` with its own test coverage
in `CordieriteCoreTests`.

### What was removed from the advanced `cordieriteClient` export

- **`send(message)`** — there is no more generic "send an arbitrary wire frame" operation.
  The only ways to talk to native are `registerTool`/`unregisterTool` (registry),
  `postEvent` (app events), and `respondToToolCall`/`reportToolProgress` (answering a tool
  call) — all narrower and purpose-built, matching the frozen spec.
- **`clientOptions.timers`/`.appState`/`.resumeLeaseStore`/`.sessionClaimDeviceFields`** —
  reconnect timing, foreground/background gating, and lease recovery are entirely native
  now, so there is nothing left in JS for a test seam to inject into; device metadata
  overrides are threaded straight through `connect()`'s JSON input instead
  (`CordieriteConnectInput.deviceManufacturer`/`deviceModel`/`deviceOs`, read by native's
  `parseCordieriteConnectInput`).
- **`clientOptions.defaultToolTimeoutMs`** — see the deviation below.
- Raw native event passthrough (`addListener("message"|"error"|"close", ...)`) — the old
  native events it exposed (`message`, `close`) no longer exist; `error` now only exists as
  part of the same five-event set the unified listener bus already covers, so there is no
  separate "raw" tier to expose.

Kept, because they still make sense against the new spec: `getState()`/`getClientState()`
(now identical — see the deviation below), `getSessionId()`, `connect()`, `restoreSession()`,
`close()`/`disconnect()` (both names, both call native's `disconnect()`), `registerTool`/
`unregisterTool`/`getRegisteredTools()`, `addCordieriteListener`, `handleUrl()`, `destroy()`.

## Deviations from issue #48 (and why)

1. **`CordieriteSessionChangeEvent` dropped `type`/`reason`.** The frozen
   `CordieriteSessionChangeEventNative` is `{ sessionId, alias }` only — no `"claimed" |
   "resumed" | "lost"` discriminant and no `reason`. The pre-port JS event carried both,
   computed from state the old client tracked itself (whether a resume vs. a fresh claim
   was in flight, and why a loss happened). Preserving them would have meant editing the
   frozen spec (out of scope: "if something in it is genuinely unimplementable, say so
   rather than editing it") or inventing a second, redundant event. Resolution: the event
   reports only what native has (`null`/`null` once the session is gone); a caller that
   needs the departing id/alias keeps the last non-null event, and the *why* is on the
   paired `stateChange` event's `reason`, which already carried it.
2. **`defaultToolTimeoutMs` is no longer app-configurable.** The old
   `CreateCordieriteClientOptions.defaultToolTimeoutMs` let an app override the client-wide
   fallback timeout JS applied when a tool omitted its own `timeoutMs`. Timeout enforcement
   is now entirely native (`CordieriteClient`'s own `defaultToolTimeoutMs`, currently fixed
   at `CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS` = 10 s to match the old default exactly), and the
   frozen TurboModule spec has no parameter through which JS could hand native a different
   value at construction time. A per-tool override (`registerTool({ timeoutMs })`) still
   works unchanged, since it travels on the descriptor JSON. Narrowing this from
   "client-wide configurable" to "fixed at the old default" is the one behavior change this
   port makes; it was judged low-risk (the option is undocumented in the package README and
   likely unused) rather than blocking on a TurboModule spec change.
3. **The transport-injection seam is at `CordieriteConnectionManager`'s level, not
   `URLSessionWebSocketTask`'s.** See "Transport seam" above.
4. **`packages/react-native/scripts/sync-native-core.mjs` needed no changes.** It already
   copies the whole `Real/` directory verbatim; every new file (`CordieriteClient.swift` and
   its extensions, `CordieriteBackoff.swift`, `CordieriteBootstrap.swift`,
   `CordieriteJSON.swift`, `CordieriteToolDescriptor.swift`, `CordieriteToolRegistry.swift`,
   `CordieriteClientTypes.swift`, `CordieriteTerminalClose.swift`, `CordieriteClientTimers.swift`)
   is vendored automatically by the existing directory copy.

## Verification

Run from the worktree root unless noted.

- **`swift build -c debug`**, **`swift build -c release`**, **`swift test`** — all pass.
  `swift test` runs 108 tests across `CordieriteConnectionManagerTests` (unchanged, task
  14's suite), `CordieriteBackoffTests`, `CordieriteBootstrapTests`, `CordieriteJSONTests`,
  `CordieriteToolDescriptorTests`, `CordieriteToolRegistryTests`, and `CordieriteClientTests`
  (the new integration suite: claim/resume handshake, reconnect backoff, grace expiry,
  terminal vs. transport-level closes, registry deltas, tool call success/timeout/cancel/
  error classification, progress, `postEvent`, `handleUrl`'s supersede/ignore rules, and
  resume-lease expiry). `swift build -c release --traits AlwaysEnabled` also passes (the
  real implementation compiled into a Release configuration, per task 14's Decision 2).
- **`pnpm build && pnpm test && pnpm typecheck && pnpm lint && pnpm check:links`** — all
  pass: 6/6 turbo tasks, 240/240 JS tests (`@cordierite/react-native`'s suite), zero
  TypeScript errors, zero ESLint errors (146 pre-existing warnings, all in files this task
  did not touch or in test files rewritten here — see the commit history for the exact
  diff), and the Markdown link checker reports no broken links across all 30 files.
- **`cd playground && npx expo prebuild --platform ios`, then `pod install --repo-update`
  in `playground/ios`, then an `xcodebuild build` against the generated workspace —
  all pass.** (`pod install` needed `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` in this
  environment's shell to work around a CocoaPods/Ruby `Encoding::CompatibilityError`
  unrelated to this change.) The exact command:
  `xcodebuild -workspace playground.xcworkspace -scheme playground -configuration Debug
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build` →
  `** BUILD SUCCEEDED **`. Confirmed compiled (not cached from a prior run) by the presence
  of `libCordierite.a`, `Cordierite.swiftmodule`, and one `.o` per new source file
  (`CordieriteClient.o`, `CordieriteClient+Session.o`, `CordieriteClient+ToolInvocation.o`,
  `CordieriteBackoff.o`, `CordieriteBootstrap.o`, `CordieriteJSON.o`,
  `CordieriteToolDescriptor.o`, `CordieriteToolRegistry.o`, `CordieriteClientTypes.o`,
  `CordieriteTerminalClose.o`, `CordieriteClientTimers.o`, `CordieriteTurboBridge.o`,
  `RCTNativeCordierite.o`) under the derived data directory. This is also what caught the
  `handleUrl` return-type mismatch noted above.
- **`cordierite doctor <built .app> --assert-present` — passes.** Run against the
  playground's built `playground.app` from the `xcodebuild` above:
  `Present true`, `Signals ios-core-marker-symbol, ios-objc-class-symbol,
  ios-info-plist-keys`, `Assertion present (holds)` — confirming `CordieriteCoreMarker`
  (compiled only into `Real/`, per task 14) is actually present in the built binary.
- **End-to-end in the iOS simulator — attempted, blocked by this environment's network
  sandboxing, not by this change.** Booted a dedicated simulator (`iPhone 17 Pro`),
  installed and launched the built `playground.app` (`xcrun simctl install`/`launch`), and
  brought up a private daemon (`CORDIERITE_STATE_DIR=/tmp/cordierite-2a-state`, port 8453)
  which minted a session and deep link successfully. The app itself, however, loaded with a
  red-screen `React Native version mismatch` error (`JavaScript version: 0.83.2, Native
  version: 0.81.5`) before the deep link was ever delivered: `lsof -i :8081` showed the
  simulator's outbound connection being intercepted by this sandbox's local network proxy
  rather than reaching a real Metro dev server (none was started for this attempt, and
  none should have been needed to reach one at all) — a JS bundle for a different RN
  version came back instead. This is an artifact of the sandboxed environment's network
  layer, not a defect introduced by this port: the native build itself is the thing this
  task changed, and it already succeeded above. Stopped the daemon and shut the simulator
  down afterward. `cordierite link --open ios-sim`, `tools`, `invoke`, `events`, and the
  background/foreground reconnect check were not reached.
