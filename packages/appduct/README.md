[![Appduct][appduct-banner]][repo]

### Drive app tools without shipping debug UI

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

The `appduct` package is the operator/agent side of Appduct: a CLI and an MCP server, backed by a long-lived background daemon that holds your device sessions. You use it to list and call the tools a connected app has registered — from a terminal, from an agent, or from a test suite — instead of driving the app through a hidden debug menu.

## Why use this package

- **One daemon, many devices.** It auto-spawns on first use, serves every device on one `wss://` port, and survives Metro reloads, backgrounding, and network flaps by suspending and resuming sessions instead of dying with them.
- **Same surface for humans and agents.** The CLI (`tools`, `invoke`, `events`, ...) and `appduct mcp` use the same RPC methods, so an agent sees the tools a human operator does.
- **Hardened control plane.** The CLI and MCP server never touch sockets, keys, or state files directly — everything goes through a Unix-domain-socket RPC surface gated by filesystem permissions (see [`docs/SECURITY.md`][security]).
- **Fits production-minded apps.** The app only exposes what you register; trust boundaries are pins and TLS, and production deployments can gate tools with policy and audit every call.

## Getting started

```bash
npm install -g appduct
appduct link --scheme myapp --qr
```

`link` needs your app's deep-link scheme: pass `--scheme` (the app's `expo.scheme`, or its bare-RN equivalent), or set `"scheme"` once in `~/.appduct/config.json` and omit the flag. Without either, the command exits with a usage error.

Scan the QR (or open the deep link) in an Appduct-enabled app, then:

```bash
appduct tools
appduct invoke sum --input '{"a":2,"b":3}'
```

That's the whole loop. There is no host process to start — `appduct` auto-spawns its daemon the first time any command needs it.

## Commands

| Command | Role |
| --- | --- |
| `appduct init [--scheme <s>] [--ios-app-id <id>] [--android-app-id <id>] [--force]` | set up an app directory: write `.appduct/config.json`, print the MCP snippet |
| `appduct keygen [--out <path>] [--force]` | generate a daemon private key, print its app pin |
| `appduct link [--ttl <s>] [--qr] [--open android\|ios-sim\|ios-device] [--device <id>] [--app-id <id>] [--scheme <s>]` | mint a pending session and print its deep link |
| `appduct ls` | list sessions: alias, state, device, tool count |
| `appduct tools [selector] [name] [--full] [--filter <text>] [--limit <n>] [--offset <n>]` | list a session's tools (one call signature + description per line), or show one tool's full schema |
| `appduct invoke [selector] <tool> --input '<json>' [--timeout <ms>]` | call a tool |
| `appduct events [selector] [--follow] [--since <cursor>]` | stream session/tool events (default), or one-shot pull everything retained since `<cursor>` (`--since`); `--json` emits NDJSON |
| `appduct revoke [selector]` | revoke a session |
| `appduct daemon run\|start\|stop\|status` | daemon lifecycle |
| `appduct mcp [--scheme <s>]` | start a stdio MCP server proxying connected apps' tools to MCP clients |
| `appduct doctor <artifact> [--assert-present\|--assert-absent]` | release-gate step: report or assert whether a built `.app`/`.ipa`/`.apk`/`.aab` contains Appduct |

Every command that targets a session accepts an optional `selector` (a session id or an alias from `appduct ls`); omit it when exactly one session is active. Global flags: `--json` (machine-readable output; compact by default, one line), `--pretty` (indent `--json` output, and JSON values embedded in human output, 2 spaces — never NDJSON event lines), `--verbose` (include the `meta` block — `command`, `timestamp`, `duration_ms` — omitted by default in both human and `--json` output), `--no-color`, `--state-dir <path>` (default `~/.appduct`), `--daemon-restart` (on a daemon/CLI version mismatch, restart the daemon even though that drops live sessions and unclaimed links — `APPDUCT_DAEMON_RESTART=1` and `config.json`'s `restartDaemonOnVersionMismatch` do the same for every command, and `--no-daemon-restart` overrules both for one). Run `appduct <command> --help` for the exact flags of any command.

`--timeout` on `invoke` is clamped to 1,000–600,000 ms and can only **shorten** the deadline, never extend it past the app's own timer: the app aborts the handler at the tool's declared `timeoutMs`, or 10 seconds for a tool that declares none, regardless of what the caller asks for. If a tool needs more room, declare `timeoutMs` on its registration.

### `appduct tools`: a signature per tool

`appduct tools` prints one call signature plus a one-line description per tool, not the full schema — cheap to read even against an app that registers hundreds of tools:

```
Tools
  seed_cart(items: int, sku?: string, clear?: bool = true) -> { added: int, cartId: string }
    Fill the cart with test items for the current user.
  set_flag(name: "dark_mode" | "new_checkout", enabled: bool)  [prompt]
    Toggle a feature flag.

Run `appduct tools <name>` for a tool's full schema.
```

A signature is derived straight from the tool's JSON Schema: required params are `name: type`, optional ones `name?: type` (with `= <default>` when the schema declares a short one), and `-> type` is the result when the tool declares an `output_schema`. `...` anywhere means the schema shape wasn't one this renderer could summarize — the tool's full schema (`appduct tools <name>`) still has it. A `[prompt]`/`[deny]` tag follows a tool whose effective policy isn't `"allow"`.

Use `--filter <text>` to narrow the listing to tools whose name or description contains `<text>` (case-insensitive), and `--limit <n>`/`--offset <n>` to page through it; a truncated listing prints a trailing `Showing n of total tools (offset o). Narrow with --filter <text> or page with --offset <n>.` line so you know more were left out. `appduct tools --json` returns `{ tools, total }` — `total` is the count after `--filter` but before `--limit`/`--offset`. `appduct tools <name>` (a single tool) is unaffected by any of this and always returns the bare tool descriptor.

### The deep-link scheme

`appduct link`, `appduct mcp`, and the MCP `appduct_connect` tool all resolve the scheme the same way, first match wins:

1. `--scheme <s>`
2. the `APPDUCT_SCHEME` environment variable
3. the nearest `.appduct/config.json` that declares a `scheme`, walking up from the working directory (a file without that key doesn't stop the walk; the walk skips `~/.appduct` and the active state dir, so global config is never mistaken for a project's)
4. `scheme` in `<state-dir>/config.json`
5. a static-file project probe, tried in this order (no walk-up — an app root is where you run these commands):
   1. `<cwd>/app.json`'s `expo.scheme` — a string, or the first entry of an array
   2. **Android**: `app/build.gradle.kts` or `app/build.gradle`'s `appductScheme` manifest placeholder (`manifestPlaceholders["appductScheme"] = "myapp"` or `manifestPlaceholders.appductScheme = "myapp"`), then `app/src/main/AndroidManifest.xml`'s first `<data android:scheme>` inside an intent filter that also declares `android.intent.action.VIEW`
   3. **iOS**: any `Info.plist` up to two levels below the app root (excluding `Pods`, `build`, `node_modules`, `DerivedData`) for the first `CFBundleURLSchemes` entry, then xcodegen's `project.yml` for the same key under `info.properties.CFBundleURLTypes`
6. otherwise an error naming every location above

In an Expo app root, none of this needs configuring; a plain Xcode or Gradle app root doesn't either, once its `Info.plist`/`AndroidManifest.xml`/`build.gradle` already declares deep links. These probes never execute `app.config.js`/`app.config.ts`, `xcodebuild`, `plutil`, or a Gradle evaluation — each is a plain, defensively-parsed read of a static project file. If your project uses dynamic config, or the probes can't make sense of your setup, use `--scheme`, `APPDUCT_SCHEME`, or `appduct init --scheme <s>` instead.

**Disagreement is never guessed away.** If more than one native probe resolves to a different scheme (say, an `android/` and an `ios/` tree in the same repo declaring different values), resolution fails with a usage error naming every conflicting source instead of picking one.

`appduct init`, run in an app root, writes `.appduct/config.json` (mode `0600`, in a `0700` directory) with the discovered scheme and prints the MCP server entry to paste, plus the `import "@appduct/react-native/auto"` reminder. It never generates keys or touches daemon state.

`init` only looks at `--scheme` and the static-file discovery in step 5 above (`app.json`, then the native probes), plus whatever the file already records — it deliberately ignores `APPDUCT_SCHEME` and does not walk up to a parent `.appduct/config.json`, since baking either into a committed file would be wrong (a shell variable that happened to be exported, or a parent project's scheme silently copied into a sub-package). `--json`'s `source` field reports which input won: `"--scheme"`, `"app.json"`, one of the four native-probe names (`"android-gradle"`, `"android-manifest"`, `"ios-info-plist"`, `"ios-project-yml"`), or `"already-recorded"`.

It's idempotent and safe to re-run:

- A plain re-run keeps whatever scheme is already recorded. If discovery has since found a different value, the result carries a `note` rather than failing.
- `--scheme <different>` needs `--force` to replace a recorded scheme; `--force` on its own re-adopts `app.json`'s value.
- `--force` merges into the existing JSON rather than truncating it.

`--ios-app-id <id>` and `--android-app-id <id>` write `appId.ios` and `appId.android` into the same file — the installed app ids that `--open android`, `--open ios-device` and `appduct_connect` need (see [Delivering the link to a device](#delivering-the-link-to-a-device)). They're two flags rather than one because the platforms' ids don't always match, and `init` never guesses one from the other. Like `--scheme`, replacing an id that's already recorded needs `--force`.

A project `.appduct/config.json` holds client-side settings only — it can never redirect the state directory, key, or policy (`--state-dir` / `APPDUCT_STATE_DIR` do that). **Do not point `--state-dir` at a project `.appduct/` directory you commit** — the state dir is where the daemon keeps `key.pem` and its audit log, and a committed one would publish a private key. The two directories share a name and nothing else.

`appduct mcp` is the one exception to step 6: it starts even with no scheme, because it's still useful for proxying tools to a session paired another way. Only `appduct_connect` fails, and its error names every location tried.

### Delivering the link to a device

`--open` hands the freshly minted deep link straight to a device, so nothing has to scan a QR code:

| `--open` | Mechanism | Address in the link |
| --- | --- | --- |
| `android` | `adb reverse tcp:<port> tcp:<port>`, then `adb shell am start -a android.intent.action.VIEW -d '<link>' -p <app-id>` | `127.0.0.1` (the port is forwarded onto the device) |
| `ios-sim` | `xcrun simctl openurl <udid> <link>` | `127.0.0.1` (the simulator shares the host's network) |
| `ios-device` **(experimental)** | `xcrun devicectl device process launch --device <udid> [--terminate-existing] --payload-url <link> <app-id>` | the machine's detected LAN address — there's no `adb reverse` equivalent on iOS |

With no `--device`, every target requires exactly one device and errors naming each candidate rather than picking one arbitrarily: `android` counts attached devices (`ANDROID_SERIAL` disambiguates), `ios-sim` counts booted simulators, and `ios-device` counts connected iOS devices only — `devicectl` lists every device the Mac has ever paired, so disconnected phones and non-iOS ones are filtered out first.

**`android` and `ios-device` need the installed app's id** — the Android package name or the iOS bundle id. Pass `--app-id <id>` (`appId` over MCP), or record it once in `.appduct/config.json` with `appduct init --android-app-id <id> --ios-app-id <id>`. Without one the command fails before minting anything. Naming the app is what keeps Android from showing an "Open with" chooser when more than one installed app declares your scheme — `adb` would report success, and the session would never be claimed. `ios-sim` needs no app id (`simctl openurl` has no equivalent), and passing one with it is an error. The id may contain only letters, digits, `.`, `_` and `-`, and must start with a letter or digit.

#### `--open ios-device` (experimental)

This is the only automated path for a wired iPhone or iPad — otherwise you're scanning a QR code by hand. It relies on `xcrun devicectl`'s undocumented `--payload-url` flag, which can't be verified in CI, so treat a failure here as a reason to fall back to the QR flow rather than as a bug in your app.

It needs all of:

- **iOS 17 or newer** on the device, and **Xcode 15 or newer** on the host (`devicectl` doesn't exist before that). For iOS 16 and below, use the QR/deep-link flow instead.
- The device **paired and trusted** by this Mac, with **Developer Mode** enabled on it (Settings → Privacy & Security → Developer Mode).
- A **development-signed build of your app already installed** — `devicectl` launches an installed app, it doesn't install one.
- The phone and this machine **on the same network**, reachable at the address the link advertises. `appduct link` prints it on its `Endpoint` line (`--json`: `endpoint.address`); `advertisedIp` in `config.json` overrides detection. If no routable address is found, detection falls back to `127.0.0.1` — which a phone can't reach — so `ios-device` refuses to deliver such a link and tells you to set `advertisedIp`.
- The app's **bundle id** — see [Delivering the link to a device](#delivering-the-link-to-a-device) for how to supply it.

```bash
appduct link --scheme myapp --open ios-device --app-id com.example.myapp
```

Two things worth knowing before you rely on this:

- **What happens when the app is already running hasn't been verified on hardware.** If delivery to an already-running app does nothing, pass **`--relaunch`** (`relaunch: true` over MCP) — it kills the running instance first. Appduct copes with the restart either way; a delivered link supersedes a held session.
- **A physical iPhone is never auto-detected.** `appduct_connect` called without a `target` only considers booted simulators and attached Android devices, and `appduct link` without `--open` doesn't look for a device at all — a paired iPhone is often someone's personal phone, so it has to be asked for explicitly.

## MCP setup (Claude Code, Cursor, and similar)

Add `appduct mcp` to the agent's MCP server config — no separate server process to manage, it auto-spawns the daemon the same way the CLI does:

```json
{
  "mcpServers": {
    "appduct": {
      "command": "appduct",
      "args": ["mcp"]
    }
  }
}
```

An MCP server is usually launched with a working directory you don't control, so `app.json` discovery may not apply. On a machine with more than one app, make the entry self-contained by naming the scheme in it — which is exactly what `appduct init` prints:

```json
{
  "mcpServers": {
    "appduct": {
      "command": "appduct",
      "args": ["mcp", "--scheme", "myapp"]
    }
  }
}
```

Once configured, an agent reaches the connected app's tools through three built-in tools that work like the CLI:

| Tool | Does what | CLI equivalent |
| --- | --- | --- |
| `appduct_list_tools` | Lists the app's tools as one-line signatures, with each tool's policy. Takes `filter`, `limit` and `offset`. | `appduct tools` |
| `appduct_describe_tool` | Shows one tool's full input and output schema. | `appduct tools <name>` |
| `appduct_call_tool` | Calls a tool by `name` with `args`, with progress and errors preserved. | `appduct invoke` |

The app's tools don't show up as MCP tools of their own. An app with hundreds of tools still adds only these three to the agent's tool list, and that list doesn't change when tools register or a device connects. With more than one device connected, each of the three needs `selector`, the session alias from `appduct ls`.

Four more built-in tools cover what the app's own tools can't. `appduct_connect` mints a link and, by default, delivers it to whichever `android`/`ios-sim` device it detects — pass `target`/`device` to choose, or `target: "none"` to force the human flow — falling back to a QR code, plus instructions to show it, only when there's nothing to deliver to. Delivering to `android` (chosen or detected) needs `appId`, resolved the same way as `--app-id` (see [Delivering the link to a device](#delivering-the-link-to-a-device)); passing it with `target: "ios-sim"` or `"none"` is an error. `appduct_wait_for_session` then waits for that session to be claimed. `target: "ios-device"` reaches a paired physical iPhone or iPad, with `appId` and the [prerequisites above](#--open-ios-device-experimental) — it's experimental and never auto-detected, so an agent has to ask for it by name.

The other two give an agent a pull surface over `postEvent()`-pushed app events: `appduct_events` drains everything retained since a cursor, and `appduct_wait_for_event` blocks for a matching event (checking what's already retained before waiting live), rejecting with `tool_timeout` if none arrives in time.

## Test runners: `appduct/client`

A thin typed wrapper over the same daemon RPC the CLI and MCP server use — for a Jest/Vitest/Detox spec that drives a running app without spawning `appduct invoke ... --json` and parsing stdout:

```ts
import { connect } from "appduct/client";

// auto-spawns the daemon and picks the single session, or pass { selector: "pixel-8" } to target one explicitly
const app = await connect();

await app.tools();                                  // ToolDescriptor[]
const { total } = await app.call("sum", { a: 2, b: 3 });
const { payload } = await app.waitForEvent("checkout_done", { timeoutMs: 5_000 });
app.close();
```

Errors surface as an `AppductError` whose `type` preserves the daemon's wire error type verbatim, so a test can assert on it directly instead of string-matching stderr:

```ts
await expect(app.call("checkout", {})).rejects.toMatchObject({ type: "policy_denied" });
```

Pair a simulator/emulator in a `globalSetup` without shelling out, via `link`/`waitForSession`:

```ts
import { link, waitForSession } from "appduct/client";

const { sessionId } = await link({ target: "ios-sim" });
const app = await waitForSession(sessionId, { timeoutMs: 60_000 });
```

`app.call`'s tool name and args/result types can't be inferred automatically — tools are registered by the connected app at runtime — so declare your own tool map once for typed calls throughout a suite:

```ts
type Tools = {
  sum: { args: { a: number; b: number }; result: { total: number } };
};

const app = await connect<Tools>();
const { total } = await app.call("sum", { a: 2, b: 3 }); // typed
```

`waitForEvent` first drains the daemon's per-session retained buffer for an already-arrived match before falling back to a live wait, so it's safe to call after the action that emits the event. Pass `since` (the `cursor` from a previous `app.events()`/`waitForEvent()` call) to skip events already handled:

```ts
const { events, cursor } = await app.events();               // pull: what already happened
const next = await app.waitForEvent("checkout_done", { since: cursor });
```

For everything else, the package exports `runCli` and the command handlers from [`src/index.ts`](https://github.com/callstackincubator/appduct/blob/main/packages/appduct/src/index.ts), so you can embed the same behavior in Node or Bun scripts without shelling out.

## Keys and pins

You can skip this entirely while your app has no `cliPins` configured — the zero-config default, in any build type. The daemon auto-generates its own `key.pem` the first time it starts if one isn't already there (mode `0600`) and prints its `sha256/...` fingerprint on that first run; `appduct link` carries that fingerprint on the deep link for the app to pick up. See [`docs/SECURITY.md`][security]'s "Trust modes" for what that does and doesn't protect.

For a build that should trust only a key you embedded ahead of time, generate one explicitly:

```bash
appduct keygen
```

This writes an unencrypted PEM private key (PKCS#8) to `<state-dir>/key.pem` by default (override with `--out`; add `--force` to overwrite) and prints the exact `sha256/...` SPKI fingerprint your app should place into `cliPins`. It runs non-interactively, so it's safe to call from CI or a setup script.

`appduct link`'s deep link is `<scheme>:///?appduct=<payload>&pin=<sha256/...>`. The `appduct` param is the binary v2 bootstrap payload (address, session id, token, expiry); `pin` is a separate, out-of-band query param carrying the daemon's current SPKI fingerprint for apps that want to pick it up. An app build with embedded `cliPins` ignores `pin` outright — embedded pins always win, in every build type. A build with no embedded pins trusts it for that one session.

## Daemon lifecycle

The daemon auto-starts the first time any CLI or MCP command needs it — you don't normally run `appduct daemon start` yourself. It writes state to `<state-dir>/` (`daemon.sock`, `daemon.pid`, `daemon.log`, `daemon.log.1`, `key.pem`, `config.json`, `audit/`), holds a single-instance lock via the pidfile, and runs independently of any one device's connection, so a reload or crash on the device side never costs you the daemon process.

Use `appduct daemon status` to see what's running (version, pid, `wssPort`, pinned keys, live sessions, effective policy, and the audit log's retention window, file count, size, and failure counters) and `appduct daemon stop` to shut it down explicitly.

Because the daemon outlives the CLI that started it, upgrading Appduct would otherwise leave the old daemon serving your commands. Every CLI/MCP process compares its version with the daemon's on its first command and replaces a stale daemon when nothing would be lost; when there is something at stake — connected sessions, or an unexpired link nobody has scanned yet — the command stops instead, naming both versions, until you run `appduct daemon stop` or pass `--daemon-restart`. A daemon newer than your CLI is left alone with a warning, so a project-local install never downgrades a global one's daemon.

Neither log grows without bound: `audit/<YYYY-MM-DD>.jsonl` files older than `auditRetentionDays` (default 30) are pruned at daemon start and once a day after, and a `daemon.log` over `daemonLogMaxBytes` (default 10 MiB) is rotated to `daemon.log.1` when a daemon is next spawned. Both are `config.json` keys — see [`ARCHITECTURE.md` §3][architecture].

## Release gate: `appduct doctor`

Appduct's inclusion in a build is controlled entirely by autolinking exclusion (see [`docs/BUILD-VARIANTS.md`][build-variants]) — there's no runtime `debuggable` check to catch a pipeline that forgot to exclude the package. `doctor` checks the built artifact itself, not the config you think produced it:

```bash
appduct doctor ./build/MyApp.ipa --assert-absent
appduct doctor ./build/app-release.apk --assert-absent
```

Exit codes, what it inspects per platform, and the marker-only detection rules on both platforms are documented in `appduct doctor --help`; CI wiring lives in `.github/workflows/test.yaml`.

## Related packages

- **[@appduct/react-native](https://github.com/callstackincubator/appduct/blob/main/packages/react-native/README.md)** — native app client + Expo plugin.
- **[@appduct/shared](https://github.com/callstackincubator/appduct/blob/main/packages/shared/README.md)** — wire protocol v2 types used by this package and the React Native client.

## Documentation

- [Architecture][architecture]
- [Wire protocol][protocol]
- [Security model & key rotation][security]
- [Build variants][build-variants]
- [Monorepo README](https://github.com/callstackincubator/appduct/blob/main/README.md)

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[appduct-banner]: https://img.shields.io/badge/Appduct-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/appduct
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
[architecture]: https://github.com/callstackincubator/appduct/blob/main/docs/ARCHITECTURE.md
[protocol]: https://github.com/callstackincubator/appduct/blob/main/docs/PROTOCOL.md
[security]: https://github.com/callstackincubator/appduct/blob/main/docs/SECURITY.md
[build-variants]: https://github.com/callstackincubator/appduct/blob/main/docs/BUILD-VARIANTS.md
[license-badge]: https://img.shields.io/npm/l/appduct?style=for-the-badge
[license]: https://github.com/callstackincubator/appduct/blob/main/LICENSE
[npm-downloads-badge]: https://img.shields.io/npm/dm/appduct?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/appduct
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/appduct/pulls
[chat-badge]: https://img.shields.io/discord/426714625279524876.svg?style=for-the-badge
[chat]: https://discord.gg/xgGt7KAjxv
