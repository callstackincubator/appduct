---
title: CLI reference
description: Every appduct command, flag, environment variable, config file key, exit code, MCP tool, and the appduct/client API.
sidebar:
  order: 1
---

For task-based instructions, see [Use the CLI](/appduct/guides/cli/). Run `appduct <command> --help` for a command's flags on your installed version.

Every command is `appduct <noun> <verb> [selector] [args]` — `sessions`, `tools`, and `events`
each work like `appduct daemon run|start|stop|status` already does. Commands that target a device
take an optional `[selector]`: a session alias or id from `appduct sessions ls`. Leave it out when
exactly one device is connected.

## Commands

### `appduct init`

Sets up the current app directory: writes `.appduct/config.json` (mode `0600`) and prints an MCP config entry for this app. Safe to re-run. Never creates keys.

| Flag | Description |
| --- | --- |
| `--scheme <scheme>` | Scheme to record. Without it, `init` looks in `app.json` and your native project files, never in `APPDUCT_SCHEME` or a parent directory. |
| `--ios-app-id <id>` | iOS bundle id, recorded as `appId.ios`. Needed for `--open ios-device`. |
| `--android-app-id <id>` | Android package name, recorded as `appId.android`. Needed for `--open android`. |
| `--force` | Replace a value that's already recorded. On its own, re-reads the scheme from your project files. Merges into the existing file rather than overwriting it. |

A plain re-run keeps the recorded scheme and adds a note if your project files now declare a different one.

### `appduct sessions ls`

Lists sessions with alias, state, device, and tool count.

### `appduct sessions link`

Creates a one-time connection link and prints it.

| Flag | Description |
| --- | --- |
| `--open <target>` | Open the link on a device: `android`, `ios-sim`, or `ios-device` (experimental). |
| `--device <id>` | adb serial, simulator UDID, or device UDID, when more than one is available. |
| `--app-id <id>` | Installed app id for `android` and `ios-device`. Defaults to `appId.<platform>` in `.appduct/config.json`. Not allowed with `ios-sim`. |
| `--relaunch` | With `ios-device`: stop a running instance of the app first. |
| `--qr` | Also print the link as a QR code. |
| `--scheme <scheme>` | Deep-link scheme. See [scheme resolution](#scheme-resolution). |
| `--ttl <seconds>` | How long the link stays valid. Default: `linkTtlSeconds`, 300. |

How each `--open` target delivers the link:

| Target | Delivered with | Address in the link |
| --- | --- | --- |
| `android` | `adb reverse`, then `adb shell am start` for your app | `127.0.0.1`, forwarded to the device |
| `ios-sim` | `xcrun simctl openurl` | `127.0.0.1` |
| `ios-device` | `xcrun devicectl device process launch` | Your computer's local network address |

Without `--device`, each target requires exactly one candidate and lists them otherwise. `ios-device` requires iOS 17+, Xcode 15+, a connected, trusted device with Developer Mode on, and your app installed. App ids may contain letters, digits, `.`, `_`, and `-`, and must start with a letter or digit.

The link has the form `<scheme>:///?appduct=<payload>&pin=<sha256/...>`. Pass it on whole.

### `appduct sessions revoke [selector]`

Ends one session and frees its alias.

### `appduct tools ls [selector]`

Lists a device's tools as one-line signatures.

| Flag | Description |
| --- | --- |
| `--groups` | List groups with tool counts instead of tools. |
| `--group <name>` | Only tools in this group. `checkout` includes `checkout/payment`. Case-sensitive. |
| `--filter <text>` | Only tools whose name or description contains the text (case-insensitive). |
| `--limit <n>` | Show at most `n` tools. |
| `--offset <n>` | Skip the first `n` tools of the name-sorted list. |
| `--full` | Print full schemas for every listed tool. |

With `--json`, the listing is `{ tools, total, groups }`, where `total` counts matches before `--limit` and `--offset`. Every listed tool carries a `group` — its group name, or `null` when it has none, which is also how `groups` spells its ungrouped row.

Signature syntax: `name: type` for a required argument, `name?: type` for an optional one, `= value` for a default, `-> type` for the result. `...` marks a part the signature can't summarize. `[prompt]` or `[deny]` marks a tool whose policy isn't `"allow"`.

### `appduct tools describe [selector] <name>`

Shows one tool's full schema. `--groups`, `--group`, `--filter`, `--limit`, and `--offset` are `tools ls`-only flags and can't be combined with `describe`.

### `appduct tools call [selector] <name>`

Calls a tool.

| Flag | Description |
| --- | --- |
| `--input <json>` | **Required.** Arguments as a JSON object. |
| `--timeout <ms>` | Shorten the call's time limit. Clamped to 1,000–600,000. Can't extend past the tool's own limit (its `timeoutMs`, or 10,000). |

Ctrl-C cancels the call in the app.

### `appduct events tail [selector]`

Streams the events your app posts with `postEvent` until you stop it. With `--json`, prints one JSON object per line, each with `kind: "app_event"`.

| Flag | Description |
| --- | --- |
| `--follow` | Accepted for readability; streaming is the default. |

Device connections and tool calls are not printed. To see when a device connects, use `appduct sessions ls`.

Each device keeps its last 256 app events (`eventBufferSize`), however many tool calls run in between. They're discarded when the session ends.

### `appduct events since [selector] <cursor>`

Prints the app events retained since `<cursor>`, then exits. With `--json`, prints one JSON object per event line plus a trailing `{ "cursor": n }` line to resume from.

### `appduct mcp`

Starts an MCP server over stdio. See [MCP tools](#mcp-tools).

| Flag | Description |
| --- | --- |
| `--scheme <scheme>` | Scheme for `appduct_connect`. |

Unlike `sessions link`, it starts even when no scheme is found; only `appduct_connect` fails.

### `appduct doctor <artifact>`

Reports whether a `.app`, `.ipa`, `.apk`, or `.aab` contains Appduct. Doesn't contact the background service.

| Flag | Description |
| --- | --- |
| `--assert-present` | Exit `3` if Appduct isn't in the artifact. |
| `--assert-absent` | Exit `3` if Appduct is in the artifact. |

### `appduct keygen`

Generates a private key for the background service and prints the `sha256/...` fingerprint to put in `cliPins`. Runs without prompts.

| Flag | Description |
| --- | --- |
| `--out <path>` | Where to write the key. Default: `<state-dir>/key.pem`. |
| `--force` | Overwrite an existing key. |

### `appduct daemon <action>`

Manages the background service. It starts on its own, so you rarely need these.

| Action | Description |
| --- | --- |
| `status` | Version, process id, port, pinned keys, sessions, policy, and audit log size. |
| `stop` | Stops it and disconnects every device. |
| `start` | Starts it in the background. |
| `run` | Runs it in the foreground, for launchd or systemd. |

## Global flags

| Flag | Description |
| --- | --- |
| `--json` | Machine-readable output: one compact JSON line, or one line per event for streams. Errors go to stderr as JSON. |
| `--pretty` | Indent JSON output. Never applies to event lines. |
| `--verbose` | Include a `meta` block: command, timestamp, duration. |
| `--no-color` | Disable color. |
| `--state-dir <path>` | Use a different state directory. Default: `~/.appduct`. |
| `--daemon-restart` | After an upgrade, replace the running background service even if devices are connected. `--no-daemon-restart` overrides the variable and config setting for one command. |

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| `0` | Success | |
| `1` | Unexpected error | |
| `3` | `doctor` assertion failed | |
| `64` | Usage error | Missing `--input`, unknown scheme, missing app id |
| `65` | Invalid input | `--input` isn't a JSON object, `invalid_request` |
| `66` | `doctor` couldn't inspect the artifact | |
| `70` | Couldn't reach the background service | Version mismatch with connected devices |
| `71` | Session problem | `no_session`, `ambiguous_session`, `unknown_session`, `session_suspended` |
| `72` | Tool error | `tool_not_found`, `tool_execution_error`, `tool_timeout` |
| `77` | Call denied | `policy_denied` |

With `--json`, the error's `type` field names the exact error. See [Error types](/appduct/reference/protocol/#error-types).

## Environment variables

| Variable | Description |
| --- | --- |
| `APPDUCT_SCHEME` | Deep-link scheme, for every command in the shell. |
| `APPDUCT_STATE_DIR` | State directory. Same as `--state-dir`. |
| `APPDUCT_DAEMON_RESTART` | `1` behaves like `--daemon-restart` on every command. |
| `ANDROID_SERIAL` | Picks the Android device for `--open android`. |
| `APPDUCT_ENABLED` | Build-time only: which builds include Appduct. See [Build variants](/appduct/guides/build-variants/). |

## Scheme resolution

`sessions link`, `mcp`, `appduct_connect`, and `appduct/client`'s `link()` use the first of:

1. `--scheme` (or the `scheme` option).
2. `APPDUCT_SCHEME`.
3. The nearest `.appduct/config.json` with a `scheme`, searching up from the current directory.
4. `scheme` in `<state-dir>/config.json`.
5. Project files in the current directory, in order:
   1. `app.json`: `expo.scheme` (a string, or the first entry of an array).
   2. Android: the `appductScheme` manifest placeholder in `app/build.gradle.kts` or `app/build.gradle`, then the first `<data android:scheme>` in an intent filter with `android.intent.action.VIEW` in `app/src/main/AndroidManifest.xml`.
   3. iOS: the first `CFBundleURLSchemes` entry in any `Info.plist` up to two levels down (skipping `Pods`, `build`, `node_modules`, `DerivedData`), then XcodeGen's `project.yml`.

All of these paths are relative to the current directory. From a React Native root, the Android files sit under `android/`, so only `app.json` and the iOS files are read there.

If nothing is found, the error lists every location. If two of these files declare different schemes, the command fails and names both. Dynamic config (`app.config.js`, Gradle scripts) is never run.

## Config files

### Project: `.appduct/config.json`

Written by `appduct init`, and meant to be committed. It holds only these keys; it can't change the state directory, key, or policy.

```json
{
  "scheme": "myapp",
  "appId": { "ios": "com.example.shop", "android": "com.example.shop" }
}
```

### Background service: `<state-dir>/config.json`

Default location `~/.appduct/config.json`. Every key is optional. Read when the background service starts: after changing it, run `appduct daemon stop`.

| Key | Default | Description |
| --- | --- | --- |
| `wssPort` | `8443` | Port devices connect to. `0` picks a free port. |
| `keyPath` | `<state-dir>/key.pem` | Private key file. Must be mode `0600`. |
| `graceSeconds` | `600` | How long a disconnected session can resume. |
| `linkTtlSeconds` | `300` | How long a new link stays valid. |
| `keepaliveIntervalSeconds` | `15` | Keepalive interval; two missed replies count as a disconnect. |
| `eventBufferSize` | `256` | Events kept per session. |
| `auditRetentionDays` | `30` | Days of audit log to keep. |
| `daemonLogMaxBytes` | `10485760` | Size at which `daemon.log` is rotated. |
| `eventsLogMaxBytes` | `10485760` | Size at which `events.log` is rotated. |
| `policy` | `{ "default": "allow", "destructive": "allow" }` | See [Limit what callers can run](/appduct/guides/security/#limit-what-callers-can-run). |
| `advertisedIp` | detected | Address put in links for physical devices. |
| `scheme` | none | Fallback scheme. |
| `restartDaemonOnVersionMismatch` | `false` | Always replace an outdated background service, even with devices connected. |

### State directory contents

`~/.appduct/` (mode `0700`) holds `daemon.sock`, `daemon.pid`, `daemon.log`, `daemon.log.1`, `events.log`, `events.log.1`, `key.pem`, `config.json`, and `audit/<YYYY-MM-DD>.jsonl`, each mode `0600`. `events.log` records Appduct's own events (links, sessions, tool calls), one JSON line each, for debugging Appduct; your app's events never go there.

## MCP tools

`appduct mcp` exposes these tools. Every tool that targets a device takes an optional `selector`.

| Tool | Arguments | Result |
| --- | --- | --- |
| `appduct_list_tools` | `selector?`, `group?`, `filter?`, `limit?` (default 50), `offset?` | Tool signatures with group and policy, `total`, and the app's `groups` |
| `appduct_describe_tool` | `selector?`, `name` | One tool's full descriptor and policy |
| `appduct_call_tool` | `selector?`, `name`, `args?`, `timeoutMs?` (1,000–600,000; can only shorten) | The tool's result |
| `appduct_connect` | `target?` (`android`, `ios-sim`, `ios-device`, `none`), `device?`, `appId?`, `relaunch?`, `ttlSeconds?` | `{ sessionId, delivered: true }`, or a `qr`, `deepLink`, and `instructions` for a person |
| `appduct_wait_for_session` | `sessionId`, `timeoutMs?` | Resolves when the device connects |
| `appduct_events` | `selector?`, `since?`, `limit?` (default 50), `name?` (glob, e.g. `"cart.*"`), `payloadMaxBytes?` (default 4096) | `{ events, cursor, dropped, remaining }`, each event `{ name, payload, ts, seq, sessionId, alias }`, or, once truncated, `{ name, payloadPreview, truncated: true, payloadBytes, ts, seq, sessionId, alias }` |
| `appduct_wait_for_event` | `selector?`, `name`, `match?`, `since?`, `timeoutMs?` (default 120,000; max 1,500,000) | The matching event |

Unknown arguments are rejected. A tool with policy `"prompt"` asks for approval through MCP elicitation.

## `appduct/client`

A typed Node API for test runners, over the same background service. Install `appduct` as a dev dependency.

```ts
import { connect, link, waitForSession, AppductError } from "appduct/client";
```

| Function | Description |
| --- | --- |
| `link(options?)` | Creates a link, and opens it when `target` is set. Options: `target`, `device`, `appId`, `relaunch`, `scheme`, `ttlSeconds`, `cwd`, `stateDir`. Returns `{ sessionId, deepLink, endpoint, expiresAt, pin, delivered? }`. |
| `waitForSession(sessionId, options?)` | Resolves with an `AppClient` once the device connects. Option: `timeoutMs`. |
| `connect<Tools>(options?)` | Returns an `AppClient` for a connected device. Options: `selector`, `stateDir`. |

`AppClient`:

| Member | Description |
| --- | --- |
| `sessionId` | The session this client targets. |
| `tools()` | The device's tool descriptors. |
| `call(name, args, { timeoutMs? })` | Calls a tool and returns its result. |
| `events({ since?, limit? })` | App events retained since a cursor: `{ events, cursor, dropped, remaining }`. |
| `events({ since?, limit?, payloadMaxBytes })` | Same, but a payload over `payloadMaxBytes` bytes comes back as `payloadPreview`/`payloadBytes` instead of `payload` — check `truncated` before reading it. |
| `waitForEvent(name, { timeoutMs?, match?, since? })` | Waits for an app event. Checks retained events first. `timeoutMs` defaults to 30,000. |
| `close()` | Closes the connection. |

Failures reject with `AppductError`, whose `type` is the [error type](/appduct/reference/protocol/#error-types).
