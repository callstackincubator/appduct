# Appduct CLI reference

Read this when `appduct ls` is empty, when you need a command the main skill file does not
cover, or when a test suite should drive the app without shelling out.

## Connect a device

A device connects by opening a one-time deep link in the app. `appduct link` mints the link;
run it **from the app's root directory** so the scheme is discovered from the project's own
files (`app.json`'s `expo.scheme`, else the Android `build.gradle`/`AndroidManifest.xml`, else
the iOS `Info.plist`/`project.yml`). No key, pin or config file is needed for a dev loop.

| Device | Command |
| --- | --- |
| Booted iOS Simulator | `appduct link --open ios-sim` |
| Android emulator or USB device | `appduct link --open android --app-id <package>` |
| Any device on the same network (a human scans) | `appduct link --qr` |
| Wired iPhone/iPad, experimental | `appduct link --open ios-device --app-id <bundle-id>` |

- **`--open android` needs the app's package name.** Without it, another installed app
  declaring the same scheme can pop an "Open with" chooser, `adb` still reports success, and
  the session is never claimed. `appduct init --android-app-id <id> --ios-app-id <id>` records
  both ids in the project's `.appduct/config.json` so no flag is needed afterwards. `ios-sim`
  takes no app id.
- Several simulators booted or devices attached: `--open` lists them and stops. Re-run with
  `--device <udid|serial>`.
- `--open ios-device` needs iOS 17+, Xcode 15+, the device paired and connected with Developer
  Mode on, a dev build installed, and the phone on this machine's network. If the link does not
  take on a running app add `--relaunch`. If it fails, fall back to `--qr`. It is never picked
  automatically; use it only when the user says the app runs on a physical iPhone.
- No device you can reach: `appduct link --json` and relay `data.deepLink` **whole** to a human
  (the trailing `&pin=sha256/...` is what lets a build with no embedded pins trust the daemon,
  in any build type), or use `--qr`
  on a TTY.

Then wait for the app to claim the session: poll `appduct ls --json` until the session shows
`"state": "active"`, or run `appduct events <sessionId> --json` and stop at `session_claimed`
(`data.sessionId` from `link --json`). The link expires after 5 minutes and works once.

**Scheme not found.** Pass `--scheme <s>` (or set `APPDUCT_SCHEME`) when you are not in the app
root or the project uses a dynamic `app.config.js`, which Appduct never executes. `appduct init
--scheme <s>` records it once. Resolution order: `--scheme`, `APPDUCT_SCHEME`, the nearest
`.appduct/config.json` walking up, the state dir's `config.json`, then the project files. Two
native probes that disagree are an error, never a guess; the error names every location tried.

### Over MCP

Call `appduct_connect` with no arguments. It detects a booted simulator or attached Android
device and delivers the link there. On `delivered: true`, call
`appduct_wait_for_session({ sessionId })`, which blocks until the app connects.

- Android delivery needs `appId` (or the id recorded by `appduct init --android-app-id`), same
  reason as the CLI flag. `target: "ios-sim"` and `"none"` reject an `appId`.
- Pass `target` (`"android"`, `"ios-sim"`, `"ios-device"`, `"none"`) and `device` only to
  override detection, for example when the result said several devices are up.
- **A result with a `qr` field means nothing was delivered.** Do not call
  `appduct_wait_for_session` yet: it prints nothing while waiting and looks like a hang. Show the
  user `qr` verbatim in a fenced code block, `deepLink` under it, and ask them to scan. `note`
  says why delivery did not happen.

## Commands

| Command | Does |
| --- | --- |
| `appduct ls` | sessions: alias, state, device, tool count |
| `appduct tools [selector] [name] [--groups] [--group <g>] [--filter <text>] [--limit <n>] [--offset <n>] [--full]` | list tools, or one tool's full schema and annotations |
| `appduct invoke [selector] <tool> --input '<json>' [--timeout <ms>]` | call a tool; `--input` is required and must be a JSON object |
| `appduct events [selector] [--since <cursor>]` | stream `session_claimed`, `session_suspended`, `session_resumed`, `session_revoked`, `tools_changed`, `app_event`, and tool-call events; `--since` pulls what is retained since a cursor and exits; `--json` emits NDJSON |
| `appduct revoke [selector]` | end one session without touching the daemon or other sessions |
| `appduct link [--open …] [--app-id <id>] [--device <id>] [--qr] [--scheme <s>] [--ttl <s>]` | mint a session and its deep link |
| `appduct init [--scheme <s>] [--android-app-id <id>] [--ios-app-id <id>] [--force]` | record scheme and app ids in `.appduct/config.json`; prints the MCP server entry; safe to re-run |
| `appduct daemon status\|stop` | inspect or stop the daemon; `stop` disconnects every device, so only for a port or key rotation |
| `appduct keygen [--out <path>]` | hardening only: the daemon generates its own key on first start |
| `appduct doctor <artifact> --assert-absent\|--assert-present` | release gate: does a built `.ipa`/`.apk`/`.aab`/`.app` contain Appduct |
| `appduct mcp [--scheme <s>]` | stdio MCP server; what an agent's MCP config runs |

Global flags: `--json`, `--pretty`, `--verbose` (adds `meta` with duration), `--no-color`,
`--state-dir <path>` (default `~/.appduct`; never point it at a project's `.appduct/`, the state
dir holds the private key), `--daemon-restart` (accept dropping live sessions to replace a daemon
from an older version).

Exit codes are non-zero on every failure: 64 usage, 65 invalid input, 70 daemon unreachable,
71 session errors, 72 tool errors (`tool_not_found`, validation, execution, timeout), 77
`policy_denied`.

## Timeouts

A call gets 10 s unless the app registered the tool with `timeoutMs` (the daemon then uses that
deadline by default). `--timeout <ms>` is clamped to 1,000–600,000 and can only shorten the
deadline; the app aborts the handler at its own timer regardless. If a tool needs longer, the fix
is in the app's registration, not the call.

## Scripts and test suites: `appduct/client`

The same daemon RPC the CLI uses, without spawning a process per call. Use it from a short
`.mjs` script for a sequence with a loop, a branch or a wait, and from a test suite for anything
the user keeps. The `appduct` package must be a dependency of the project (`npm i -D appduct`);
a globally installed CLI cannot be imported.

```js
// seed.mjs — run with: node seed.mjs
import { connect } from "appduct/client";

const app = await connect(); // the single connected device; connect({ selector: "pixel-8" }) names one
try {
  const { cartId } = await app.call("create_cart", {});
  for (const sku of ["SKU-1042", "SKU-2077"]) {
    await app.call("add_item", { cartId, sku });
  }
  await app.call("place_order", { paymentMethod: "card" });
  const { payload } = await app.waitForEvent("checkout_completed", { timeoutMs: 15_000 });
  console.log(JSON.stringify(payload));
} finally {
  app.close();
}
```

A failed call rejects with an `AppductError` whose `type` is the wire error type (`policy_denied`,
`tool_timeout`, `tool_execution_error`, …), so a test can assert on it:

```ts
import { link, waitForSession } from "appduct/client";

const { sessionId } = await link({ target: "ios-sim" });                 // globalSetup
const app = await waitForSession(sessionId, { timeoutMs: 60_000 });
await expect(app.call("wipe_data", {})).rejects.toMatchObject({ type: "policy_denied" });
```

Declare a tool map type (`connect<Tools>()`) for typed `call`s.

## Notes

- One daemon serves every device; there is no `--port` and no reason to run a second one.
- `appduct init` never generates keys or touches daemon state. `appduct keygen` is for pinned
  builds that leave the machine; a dev loop never needs it.
- The daemon reads `~/.appduct/config.json` (policy, retention) only at start; a change needs
  `appduct daemon stop`, which disconnects every device.
- After upgrading Appduct, a command may stop with a version mismatch naming both versions:
  the old daemon still holds sessions. `appduct daemon stop` or `--daemon-restart` replaces it.
