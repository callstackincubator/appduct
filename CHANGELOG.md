# Changelog

All notable changes to `appduct`, `@appduct/shared`, and `@appduct/react-native` are
documented here. The three packages are versioned in lockstep (identical version numbers), so one
changelog covers all of them.

This file is maintained by hand; there is no automated changelog tooling. Every PR with a
user-visible change adds a line under `Unreleased` in the form the `writing-changelog` skill in
`.claude/skills/` describes, and the release PR (see the `cut-release` skill there) turns that
section into a versioned heading.

## Unreleased

- **Breaking: the CLI commands are now noun-verb, with no aliases.** `ls` is now `sessions ls`,
  `revoke` is `sessions revoke`, `link` is `sessions link`, `tools` is `tools ls`, `tools <name>`
  is `tools describe <name>`, `invoke` is `tools call`, `events` is `events tail`, and
  `events --since <cursor>` is `events since <cursor>`; a removed command's error names its
  replacement.
- **Breaking: `appduct_events` returns flat events.** Each event is now
  `{ name, payload, ts, seq, sessionId, alias }` instead of `{ kind, data }`, and `limit` now
  defaults to 50.
- **New: filter events by name.** `appduct_events` accepts `name`, a glob such as `"cart.*"`
  (`*` matches any run of characters), to return only events whose name matches.
- **Breaking: `appduct_events` truncates a payload over 4096 bytes by default.** A truncated event
  comes back as `{ name, payloadPreview, truncated: true, payloadBytes }` instead of
  `{ name, payload }`; pass `payloadMaxBytes` to raise or lower the cap.
- **New: `appduct_events` and `app.events()` report `dropped` and `remaining`.** `dropped` counts
  events evicted from the retention buffer before you asked, and `remaining` counts events still
  waiting after the page you got back.
- **New: `app.events()` accepts `payloadMaxBytes` to cap an event's payload size.** Without it every
  event keeps its full `payload`; with it, an oversized payload comes back as `payloadPreview`/
  `payloadBytes` and you check `truncated` before reading `payload`.
- **Breaking: `appduct/client`'s `AppEvent` type may now be truncated.** Code that annotates a
  variable or parameter with `AppEvent` and reads `.payload` unconditionally should switch to
  `FullAppEvent`, which `appduct/client` now exports alongside `TruncatedAppEvent`.

## 0.12.0 (2026-09-24)

- **Breaking: `appduct events`, `appduct_events` and `appduct_wait_for_event` show only the events
  your app posts.** Device connections and tool calls no longer appear and `kinds` is rejected;
  to wait for a device, use `appduct ls --json` or `appduct_wait_for_session`.
- **Fix: app events are no longer lost after about 128 tool calls.** Each device keeps its last
  256 app events (`eventBufferSize`) however many tool calls run in between.
- **New: the daemon writes its own events to `~/.appduct/events.log`.** Session, link and tool-call
  events land there as JSON lines for debugging Appduct, never your app's events; the file rotates to
  `events.log.1` past `eventsLogMaxBytes` (default 10 MiB).

## 0.11.1 (2026-09-22)

- **Fix: an ungrouped tool reports `group: null` to every reader.** `appduct_describe_tool`
  dropped the key instead of reporting `null`, so it disagreed with `appduct_list_tools` about
  the same tool. `ToolDescriptor.group` is
  `string | undefined` again — it is the registration type, and registering `null` has always been
  rejected — so the type app authors write against (`appduct/client`, the React Native SDK's
  `getRegisteredTools()`) no longer admits a value that throws. Code reading a `tools.list` entry
  takes the new `ListedToolDescriptor` (or `ToolsListEntry`, which adds `policy`), where `group` is
  `string | null`; `appduct/client`'s `tools()` now returns those entries.
- **Fix: the first Appduct command on a clean machine no longer fails with a bare `ENOENT`.**
  Nothing created the state directory before the auto-spawn path wrote into it: `~/.appduct` is
  created by `startDaemon`, but the spawn-lock and `daemon.log`'s fd are opened by the *parent*
  process, before the daemon it spawns exists. So with no `~/.appduct` yet, every command that
  auto-spawns a daemon — `appduct ls`, `appduct daemon start|status`, and `appduct mcp`, which
  died before an MCP client could finish `initialize` — failed with
  `ENOENT: ... open '~/.appduct/daemon.spawn.lock'` until someone ran `appduct daemon run` in the
  foreground once. The auto-spawn path now creates the directory (mode `0700`, same as the daemon
  would) before taking the lock.

## 0.11.0 (2026-09-22)

- **Docs: designing tools for agents.** `docs/TOOLS.md` gains a "Designing tools for agents"
  section (name by intent, annotate, pair mutations with observers, declare `outputSchema`,
  describe parameters, coarse over fine, `timeoutMs`, no tools that wait on a person), linked from
  the React Native, iOS and Android READMEs and the website. The Appduct skill is split into a short
  `SKILL.md` (the CLI loop, chaining calls in one shell invocation, errors) plus on-demand
  references for the CLI, writing tools and setup. The playground tools now follow the rules:
  `reset_counter` is also `idempotentHint`, `throwing_tool` is `readOnlyHint`, and descriptions
  name their side effects.
- **New: tool groups.** A tool can declare an optional `group` — a top-level group (`"cart"`)
  or one subgroup below it (`"checkout/payment"`); each part matches the tool-name pattern
  `[a-zA-Z0-9_-]{1,64}`. Set it with `registerTool`/`useAppductTool`'s `group` option (a change
  to it re-registers the tool), with `createToolGroup("cart")` to bind one group for a whole
  feature module, or with the `group` parameter of the Swift and Kotlin `register` calls. An
  invalid group invalidates the registry snapshot exactly like an invalid `timeout_ms`, so all
  three SDKs reject it at registration — an explicit `null` included, so an ungrouped tool omits
  the option rather than passing `null`. A daemon that predates groups ignores the field.
- **New: `appduct tools --group <name>` and `appduct tools --groups`.** `--group checkout` lists
  the `checkout` group and all its subgroups (`checkout/payment` lists just that subgroup) and
  combines with `--filter`/`--limit`/`--offset`; `--groups` lists only the groups and their tool
  counts. Without `--group`, a registry with groups is listed under group headings, and a
  truncated listing's footer names the top-level groups to narrow to. `tools.list` gains a
  `group` param (applied before `total` and paging) and a `groups` summary of the whole registry
  on every result, so `appduct tools --json` now returns `{ tools, total, groups }`. Every entry
  carries a `group`, `null` for an ungrouped tool — the same value the `groups` summary uses for
  its own ungrouped row, so one test answers "ungrouped" in either half of the result.
- **New: groups over MCP.** `appduct_list_tools` takes a `group` (same matching as `--group`),
  shows each tool's `group`, and returns the `groups` summary on every result, so an agent can
  see an app's areas and list one of them. `appduct_describe_tool` includes the tool's `group`.
- **Fixed (iOS): a tool name with a trailing newline (`"tool\n"`) is now rejected**, matching
  `@appduct/shared` and Android. The Swift core's name check accepted it because ICU's `$` also
  matches before a final line terminator; the daemon would then have rejected the snapshot.

- **Breaking (MCP): the app's tools are no longer listed as MCP tools.** An agent reaches them
  through three built-ins that mirror the CLI: `appduct_list_tools` (one-line signatures and
  each tool's policy, with `filter`/`limit`/`offset`, like `appduct tools`),
  `appduct_describe_tool` (one tool's full schema, like `appduct tools <name>`) and
  `appduct_call_tool` (`{ selector?, name, args?, timeoutMs? }`, like `appduct invoke`).
  `tools/list` is now a fixed set of built-ins, so an app with hundreds of tools adds three
  definitions to an agent's context, not hundreds. `appduct_list_tools` returns 50 tools at a time
  unless given `limit`. `selector` takes a session alias or id; a call is routed by session id, so
  it fails with `unknown_session` rather than reaching a new device that took over a departed
  device's alias. Unknown parameters are rejected (`invalid_request`). `timeoutMs` can only
  shorten the tool's own deadline, since the app stops a tool at its declared timeout; a longer
  one, or one outside 1000–600000, is rejected rather than clamped. What goes away:
  - Calling an app tool by its own name through `tools/call`. It now returns `tool_not_found`,
    pointing at `appduct_list_tools` and `appduct_call_tool`.
  - `<alias>__<name>` namespacing. With several devices connected, pass `selector` (the
    session alias or id) instead.
  - `notifications/tools/list_changed`, and the `listChanged` capability.
  - MCP-level `outputSchema` enforcement and schema degradation: schemas reach the agent as
    data through `appduct_describe_tool`, exactly as registered, whatever their root type. The
    React Native SDK no longer warns about non-object output schemas.
  - MCP client permission rules that named individual app tools (for example
    `mcp__appduct__seed_cart`) no longer match anything; the client's permission now covers
    `appduct_call_tool` as a whole, so "always allow" there approves every app tool. To keep a
    person approving destructive calls, set `policy.destructive` to `"prompt"` (it covers tools
    annotated `destructiveHint: true`). `"prompt"`-policy
    consent itself is unchanged: it is asked per call, via elicitation.
  - The React Native SDK's input-schema warning now fires only for a root `type` that rules out
    an object (`z.string()`, `z.array(...)`), not for unions or intersections of objects.
  - `@appduct/shared` no longer exports `isObjectRootedSchema`.

- **Breaking (MCP): `"prompt"`-policy consent is elicitation-only.** The Claude Code-specific
  fallback is gone: `tools/list` no longer emits `_meta["anthropic/requiresUserInteraction"]`, and
  the MCP server no longer sends `consent: "client"`. A `"prompt"` tool called from an MCP client
  that doesn't declare the `elicitation` capability is now denied with `policy_denied` (reason
  `no_consent_channel`), the same as the CLI. Current Claude Code declares elicitation, so it gets
  the elicitation prompt instead; only a client that relied on the flag without supporting
  elicitation loses access. To fix that, use a client that supports elicitation, or set the tool's
  policy to `"allow"` in `config.json` — which removes the gate for every caller, including the
  CLI — and restart the daemon (`appduct daemon stop`), since `config.json` is read once at daemon
  start. The restart disconnects every device, which then has to link again, and a running
  `appduct mcp` loses its daemon connection, so restart the MCP server in your client too.
  - A daemon with this change that receives `consent: "client"` from an older MCP server treats it
    as no consent, so the call is denied and audited as `no_consent_channel`.
  - `@appduct/shared`: `ToolsCallParams.consent` and the audit record's `consent` narrow to
    `"elicitation"`. New audit records never carry `"client"`; existing audit files may.

- **`config.json`'s `wssPort` accepts `0`, meaning "bind an OS-assigned port".** The pinned-wss
  listener takes whatever ephemeral port the OS hands it, and everything that reports or advertises
  the port — `daemon.status`'s `wssPort`, a minted link's `endpoint.port`, and so the deep link and
  QR code composed from it — carries the *bound* port rather than the configured `0`. This lets
  several daemons (separate state dirs) coexist on one machine without an operator hand-picking a
  port for each. Every other value must still be a port number in `1..65535`; the default is
  unchanged at `8443`.

- **Fixed: a zombie daemon process no longer blocks pidfile takeover.** `process.kill(pid, 0)`
  succeeds for an exited-but-unreaped process, so a daemon that was killed after its parent CLI had
  exited could keep its pidfile looking live — in containers whose PID 1 does not reap, for the
  life of the container, leaving every later command reporting a daemon that was already dead. The
  liveness probe now also reads `/proc/<pid>/status` on Linux and treats `State: Z` as dead;
  everywhere `/proc` is absent or unreadable the previous behaviour is unchanged.

- **Breaking (CLI): `--json` output is compact by default.** Every `appduct <command> --json`
  invocation used to pretty-print its JSON with 2-space indentation; it now prints it on a single
  line (`JSON.stringify`, no whitespace). Any JSON parser is unaffected. A script that greps or
  diffs the indented text directly is not — pass the new `--pretty` flag to restore the old
  indentation.
- **Breaking (CLI): the `meta` block (`command`, `timestamp`, `duration_ms`) is no longer emitted
  by default**, in either human or `--json` output. Pass the new `--verbose` flag to restore it —
  the trailing `Meta` lines in human mode, the `meta` field on the `--json` envelope.
- **New: `--pretty` and `--verbose` global flags**, alongside `--json` and `--no-color`. See the
  [`appduct` README](packages/appduct/README.md) for the full description of each.
- **Breaking (CLI): `appduct tools --json` for a listing now returns `{ tools, total }`** instead
  of a bare array. The single-tool form (`appduct tools <selector> <name>`) is unchanged — it still
  returns the bare tool descriptor.
- **New: a signature-based `tools` listing, with `--filter`/`--limit`/`--offset`.** The human
  listing now shows one call signature (`name(params) -> result`) plus a one-line description per
  tool instead of a bare name/description table, and `appduct tools` gains `--filter <text>` to
  narrow by name/description, and `--limit <n>`/`--offset <n>` to page through a large registry —
  making it cheap to read `appduct tools` against an app that registers hundreds of tools. See the
  [`appduct` README](packages/appduct/README.md)'s "`appduct tools`: a signature per tool" section
  for details.
- The `appduct` agent skill now defaults its example commands to plain-text output, adding
  `--json` only where a script (not the agent itself) will parse the result.
- **Fixed:** a bad argument to `tools`, `invoke`, `revoke` or `events` (a missing `<tool>`, too
  many positionals, `--limit 0`) crashed the CLI with a stack trace instead of printing a usage
  error with exit code 64. A numeric flag given without a value (`--limit`, `--limit -1`,
  `--since`, `--ttl`, `--timeout`) is now a usage error; it used to be read as `1`.
- **Breaking: `--open android` / `target: "android"` now require the installed app's id** —
  including an Android device `appduct_connect` auto-detects, which now fails with
  `invalid_request` until an app id is configured.
  Previously `adb shell am start` was invoked with an implicit intent (no `-p`); when more than
  one installed app declared the deep-link scheme, Android showed an "Open with" chooser and
  `am start` still reported success, so `appduct_wait_for_session`/the CLI blocked its whole
  timeout with nothing explaining why (issue #63). Delivery now names the package explicitly
  (`am start ... -p <app-id>`) and requires an app id rather than falling back — for both
  `android` and the experimental `ios-device` target.
  - **Migration:** run `appduct init --scheme <s> --android-app-id <id> --ios-app-id <id>` in
    your app root once (writes `appId.android`/`appId.ios` into `.appduct/config.json`), or pass
    `--app-id <id>` on `appduct link` / `appId` on the MCP `appduct_connect` tool / `appId` on
    `mintLink`/`appduct/client`'s `link()` per call. `ios-sim` needs none of this — it is a usage
    error to pass one there.
  - **Removed:** `--bundle-id` (CLI), `bundleId` (MCP `appduct_connect`), `bundleId`
    (`mintLink`/`appduct/client`'s `link()`), and `config.json`'s `iosBundleId` — all replaced by
    `--app-id`/`appId`/`appId.<platform>` above, which now also covers `android`. There is no
    deprecation shim: a leftover `iosBundleId` in `config.json` is silently ignored (an unknown
    key just warns, and `loadConfig`'s `warn` defaults to a no-op), so the delivery-time error
    above is the only signal that it needs replacing.

## 0.10.0 (2026-09-16)

- **New: native SDKs for apps without React Native.** The same Appduct core the React Native
  package uses is now published on its own:
  - **iOS** — `AppductCore` via Swift Package Manager
    (`.package(url: "https://github.com/callstackincubator/appduct", from: "0.10.0")`) or CocoaPods
    (`pod 'AppductCore', :configurations => ['Debug']`). See `packages/native/ios/README.md`.
  - **Android** — `com.callstack.appduct:core` for debug builds and `com.callstack.appduct:core-noop`
    for release builds, on Maven Central. See `packages/native/android/README.md`.
- **Breaking (Android): the namespace moved from `com.callstackincubator.appduct` to
  `com.callstack.appduct`.** This covers the Kotlin package, the Android library namespace, and the
  `AndroidManifest.xml` meta-data keys.
  - **Expo and autolinked React Native apps:** nothing to do. The config plugin and autolinking pick
    up the new names on your next prebuild/build.
  - **If you set the meta-data keys by hand:** rename them. The old keys are no longer read, so an
    app still using them loses its configuration and falls back to the fail-closed defaults.
    - `com.callstackincubator.appduct.CLI_PINS` → `com.callstack.appduct.CLI_PINS`
    - `com.callstackincubator.appduct.TRUST` → `com.callstack.appduct.TRUST`
    - `com.callstackincubator.appduct.ALLOW_PRIVATE_LAN_ONLY` → `com.callstack.appduct.ALLOW_PRIVATE_LAN_ONLY`
  - **If you import Appduct's Kotlin classes directly:** update the imports to `com.callstack.appduct`.
- `appduct doctor` recognises both the new and the pre-0.10.0 Android namespace, so a release gate
  still detects Appduct in apps built against 0.9.0 or earlier.
- **Fix:** resolved Swift strict-concurrency warnings in the iOS core.
- **Fix:** CLI and MCP messages say "an Appduct" instead of "a Appduct".
- Docs: the README is scoped to React Native, with new guidance on the MCP and CLI ways to use
  Appduct with an agent.

## 0.8.0 (2026-09-08)

- **New:** `appduct init` scaffolds config from an existing `app.json`/`app.config.js`, discovering the scheme automatically.
- **New:** `mcp` accepts `--scheme`/`APPDUCT_SCHEME` to target a specific app scheme.
- **New (experimental):** `--open ios-device` delivers links to a physical iOS device via `xcrun devicectl`.
- **New:** elicitation consent channel for policy `"prompt"`.
- **New:** daemon audit log retention and `daemon.log` rotation.
- **New:** per-tool `timeoutMs` is carried through to the daemon and sizes MCP/CLI transport timeouts.
- **New:** the CLI and MCP server detect a daemon running an older version and restart it when no session/link state would be lost (`--daemon-restart`, `APPDUCT_DAEMON_RESTART`, `config.json`'s `restartDaemonOnVersionMismatch`). See `docs/ARCHITECTURE.md` §4.
- **New:** `inputSchema`/`outputSchema` accept a `{ schema, jsonSchema }` pair or a raw JSON Schema object, so zod 3 and plain valibot schemas publish a real shape.
- **Breaking (dev only):** a Standard Schema with no JSON Schema exporter now throws in `__DEV__` instead of registering a shapeless tool silently. Release builds still register with a warning.
- **Type change:** `AppductRuntimeSchema` is a union of the three accepted schema forms; internal `requireStandardSchema`/`validateStandardSchema` helpers are replaced by `normalizeToolSchema`/`validateToolSchema`.
- **Fix:** MCP server never emits a non-object `outputSchema` and guards `structuredContent`.
- **Fix:** `useAppductTool` registers once per mount and routes calls through a ref.
- **Fix:** `appduct_connect` and delivered deep links no longer silently strand a session.
- **Fix:** `ios/AppductTests` excluded from the npm package.
- Docs: five-minute READMEs, hardening guidance moved to `docs/`, new markdown link checker.

## 0.7.0 (2026-08-19)

- **Fix: a terminal daemon rejection (1008) now ends the session instead of retrying until
  grace.** `onSocketLost` previously treated only close code 1000 as terminal, so an
  unretryable rejection — `unknown_session` after a daemon restart, `invalid_resume_token`, a
  session revoked or expired while offline — kept the client in `reconnecting` for up to
  `grace_s` (600s default) before its `sessionChange: lost` listener ever fired. Every
  daemon-side rejection of this kind closes with 1008, so 1008 is now terminal wholesale rather
  than matched by reason string; transport-level closes (1011, 1001, 1006) stay retryable. A
  failed resume's close code now travels with the rejection via
  `AppductHandshakeClosedError` so it isn't thrown away before reaching `onSocketLost`.
- **Fix: `restoreSession()` is now a first-class export**, reachable without going through
  `installAppductDeepLinkBootstrap` or the `appductClient` proxy. An app that drives
  bootstrap itself (custom deep-link routing, QR scanning, a manual `connect()`) had nothing
  reading the native lease, so every Metro reload dropped a session native could still have
  resumed. Exported from the root and `./noop` entries and `CordierePublicApi`.
- **Breaking: `requirePrivateIp` is removed; `/auto` is now the only install path.**
  `allowPrivateLanOnly` was already native build config
  (`AppductAllowPrivateLanOnly` in Info.plist / the Android manifest) enforced by native
  `connect()` on both platforms — the JS `requirePrivateIp` option could only narrow what
  native already allowed, so setting it to `false` without also setting the native key did
  nothing. The deep-link handler now reads `allowPrivateLanOnly` from the same
  `getConstants()` path native enforces from, failing closed when it can't be read.
  `installAppductDeepLinkBootstrap` and `InstallAppductDeepLinkBootstrapOptions` are gone;
  `require("@appduct/react-native/auto")` is the only way to install the bootstrap listener
  now. See `packages/react-native/README.md` for the current surface.

## 0.6.0 (2026-08-18)

- **New: tool call cancellation.** A new `tools.cancel` RPC and `tool_cancel` wire frame let a
  caller cancel a still-pending `tools.call` instead of waiting it out. The RN SDK's
  `tool.handler(args, context)` now receives an `AbortSignal` on `context.signal`, aborted on a
  `tool_cancel` frame or when the session's transport is lost; a handler that ignores it keeps
  running as before, one that observes it and throws gets `tool_cancelled` reported (distinct from
  `tool_timeout`). `appduct invoke` cancels the in-flight call on SIGINT rather than leaving the
  app-side handler running for a caller that already exited. An MCP client's
  `notifications/cancelled` maps to `tools.cancel` automatically.
- **New: daemon-side event retention and a pull surface (`events.since`).** The daemon now keeps a
  per-session ring buffer (`eventBufferSize`, default 256) of recent events, including
  `app_event`s posted from the app. `events.since` drains it by sequence cursor, so a caller that
  wasn't subscribed at the moment an event fired can still retrieve it. Two new MCP tools expose
  this to agents: `appduct_events` (pull) and `appduct_wait_for_event` (block for a matching
  event, checking the retained buffer before falling back to a live wait).
- **New: minimal `"prompt"` policy value.** `policy.default`/`policy.destructive`/per-tool
  overrides now accept `"prompt"` in addition to `"allow"`/`"deny"`. The only implemented gate
  today is MCP: a compliant client (Claude Code ≥ v2.1.199) gets
  `_meta["anthropic/requiresUserInteraction"]` on `tools/list` for a `"prompt"` tool and echoes
  consent back on `tools/call`; every other caller (CLI, an older/non-compliant MCP client, CI) is
  denied with `policy_denied` — `"prompt"` fails closed rather than behaving like `allow`. See
  `docs/SECURITY.md` for what this does and doesn't guarantee.
- **New: `appduct/client` programmatic API for test runners.** A typed wrapper over the same
  daemon RPC the CLI and MCP server use, for a Jest/Vitest/Detox spec that wants to drive a
  running app without shelling out to `appduct invoke --json`: `connect()`, `link()` +
  `waitForSession()`, `app.call()`, `app.tools()`, `app.events()`/`app.waitForEvent()`. Errors
  surface as a `AppductError` whose `type` preserves the daemon's wire error type, so tests can
  assert on it directly. See `packages/appduct/README.md`'s "Programmatic use" section.

## 0.5.1 (2026-08-17)

- **Fix: release builds no longer carry Appduct's native module by default.** Previously,
  leaving `APPDUCT_ENABLED` unset shipped Appduct in every build variant, including
  release — the opposite of the intended dev-only default. Unset now links only `Debug`/`debug`,
  `1`/`true` links every variant (for a release-signed internal/QA build that still needs
  Appduct), and `0`/`false` excludes it everywhere, unchanged. iOS: `react-native.config.js`
  sets CocoaPods' `:configurations`, a real per-variant linking decision. Android: RNGP's
  generated `PackageList.java` is shared, unfiltered, across every variant, so the equivalent
  `buildTypes` restriction breaks compilation for a package with static Java registration
  instead — `android/build.gradle` instead swaps which Kotlin source set compiles for `release`
  (the real implementation, or a no-op `AppductPackage` at the same fully-qualified name),
  keyed on the same `APPDUCT_ENABLED`. Neither mechanism is a runtime check.
- **Fix: `appduct doctor`'s Android detection now requires the `AppductNativeMarker`
  keep-rule signal to report `present`.** The no-op stub introduced by the fix above compiles at
  the real implementation's exact package name, and the config plugin writes the same
  `AndroidManifest.xml` meta-data regardless of build variant — so the two other Android
  signals (dex package-string, manifest meta-data keys) could otherwise report a harmless
  default-release stub as "present." They're still reported for corroboration but no longer
  independently decide the verdict.
  See `packages/react-native/README.md`'s "Compiling Appduct out of production builds" for the
  updated matrix.

## 0.5.0 (2026-08-17)

A rewrite of the CLI/daemon/protocol layer, shipped as 0.5.0 rather than the originally planned
0.4.0 (see `docs/CI.md#release-policy`). Contains breaking changes for anyone on 0.3.x. Highlights
since 0.3.1:

- **Breaking: daemon-based architecture ("protocol v2").** The CLI is now a thin RPC client to a
  background daemon process instead of talking to devices directly; the wire protocol, session
  engine, and invocation RPC surface were all rewritten.
- **Breaking: `enableInReleaseBuilds` removed from the React Native config plugin, with no
  deprecation shim.** Passing it at all (`true` or `false`) now throws at prebuild, naming the
  replacement. Whether native code ships is decided by autolinking alone, driven by the
  `APPDUCT_ENABLED` environment variable: unset or empty means included (so a build that never
  mentions Appduct still gets it), `0`/`false` opts the package out of autolinking on both
  platforms, and any other value is a config error. The package ships its own
  `react-native.config.js` that reads it, and `@appduct/react-native/metro` reads the same
  variable to strip the JS, so one pipeline variable removes both surfaces with no app-side config.
  It must be set when autolinking resolves (`pod install` / gradle configure), not merely when the
  app compiles. What a build trusts is decided by `trust` — `"pin"` when `cliPins` is configured,
  `"link"` otherwise (trust the SPKI pin carried by the bootstrap link, per session) — and is no
  longer tied to whether the build is debuggable. A 0.3.x config that set `enableInReleaseBuilds`
  (either value) must simply delete that option; see `packages/react-native/README.md`'s
  "Hardening for production / internal builds" and "Compiling Appduct out of production builds"
  sections for the full migration.
- **When Appduct is linked, its podspec and `build.gradle` print `[appduct] native module
  INCLUDED in this build`** during pod install / gradle configure. Nothing prints when it is
  excluded, because nothing runs — the line exists to catch a release build that carries
  Appduct by mistake. `appduct doctor` remains the authority, since it inspects the built
  artifact rather than the build log.
- **New:** `appduct doctor <artifact>` — inspects a built `.app`/`.ipa`/`.apk`/`.aab` directly
  to assert whether Appduct is present or absent, replacing the old runtime `debuggable`/`#if
  DEBUG` check as the release-gate mechanism.
- **New:** `appduct mcp` — an MCP server exposing Appduct sessions to MCP-compatible tools.
- **New:** emulator/simulator fast path (`appduct link --open`).
- **New:** session recovery on iOS and Android — the native clients can resume a session across an
  app process restart (resume lease) instead of requiring a fresh bootstrap link.
- **New:** daemon-side policy engine and audit log.
- **Hardened:** iOS and Android native connection layers no longer contain any build-type
  (`debuggable`/`#if DEBUG`) check at all; whether Appduct's native code is present in a build
  is decided solely by autolinking, independent of debuggability, and is verifiable directly
  against a built artifact with `appduct doctor`.
- **Tooling:** migrated the workspace from bun to pnpm + vitest; CI now pins all GitHub Actions to
  full commit SHAs and publishes via npm trusted publishing (OIDC + provenance).

This list is a summary, not a full commit log — see `git log` for exact detail.

## 0.3.1 and earlier

Published to npm (0.1.0, 0.2.0, 0.3.0, 0.3.1) but not documented in a changelog. Consult the git
history predating the 0.4.0 rewrite (everything before `task(01): delete v1 host model and fix
repo hygiene`) for what shipped in those releases.
