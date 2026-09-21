---
name: appduct
description: Connect an Appduct-enabled React Native app to your machine and drive it from the terminal (or MCP) using tools the app registers — useful for agents, scripts, and dev automation. Reach for this when the user mentions Appduct, bootstrapping/pairing with the app, or invoking app-defined capabilities from the CLI or MCP.
---

# Appduct

Appduct is a CLI/daemon/MCP workflow for connecting to an Appduct-enabled React
Native app, discovering its registered tools, invoking those tools, and ending the
session cleanly after use. A single `appduct` daemon on this machine owns the
`wss://` listener and every device session; the CLI (and `appduct mcp`, if this
agent is invoked as an MCP client instead of a shell) are both thin RPC clients of it and
auto-spawn it on first use — there is no separate "start the host" step to manage.

## Agent workflow (CLI)

1. Run **`appduct ls`**. It lists sessions, each with a session id, alias, state,
   device, and tool count. An empty list means no device has claimed a session yet — go
   to **Establish a session** below.
2. Every session-targeting command takes an optional **selector** (a session id or
   `alias` from step 1) as its first positional argument. **Omit it** when exactly one
   session is active — the CLI picks it automatically; pass it explicitly when several
   sessions exist (the CLI errors with `ambiguous_session` and lists the aliases if you
   don't).
3. **`appduct tools [selector]`** — list tools registered in the app. Each line is a
   call signature (`name(params) -> result`) plus a one-line description, not a full
   schema — cheap to read even for an app with hundreds of tools. `...` anywhere in a
   signature means the CLI could not summarize that part of the schema; fetch the full
   tool (step 4) to see it. On a large app, run **`appduct tools --groups`** first: it
   lists the app's tool groups with counts (subgroups like `checkout/payment` indented
   under their parent). Then list one with **`--group <name>`** — `--group checkout`
   includes every `checkout/...` subgroup, `--group checkout/payment` only that one. When
   the app declares no groups, or you know a word to look for, narrow with
   `--filter <text>` (matches name or description) instead. Page with
   `--limit <n>`/`--offset <n>` if the listing says tools were left out; its footer names
   the groups to narrow to.
4. **`appduct tools [selector] <tool-name>`** — the tool's full input/output schema
   (`--full` is implied for a single tool, no need to pass it).
5. **`appduct invoke [selector] <tool-name> --input '{"key":"value"}'`** — invoke the
   tool with JSON args.
6. **`appduct events [selector]`** — stream session/tool events if you need to watch for
   `session_claimed`, `tools_changed`, or `app_event` without polling.

There is no `--session-id` flag in v2 — use the positional selector instead.

## Establish a session

If no session is active yet, mint a bootstrap link. **Run this from the app's root
directory and it needs no configuration at all** — the deep-link scheme is read from
`app.json`'s `expo.scheme`:

```bash
appduct link --json
```

You do not need to create a key first: the daemon generates one on its first start, and
`appduct link` carries its fingerprint on the deep link for an app with no `cliPins`
configured to trust for that session.

To generate one explicitly — non-interactive and safe to run from an agent or script:

```bash
appduct keygen --out ~/.appduct/key.pem
```

Adding the printed `sha256/...` fingerprint to the app's `cliPins` is what switches a build
to pinned trust (see **Setup** below if you are wiring Appduct into an app for the first
time — that step needs a native rebuild, so it isn't a fast in-session action).

Pass `--scheme myapp` only when the scheme cannot be discovered — you are not in the app
directory, or the project uses a dynamic `app.config.js` (which is never executed).
`APPDUCT_SCHEME=myapp` does the same for a whole shell, and `appduct init` records
it once in the project (see **Setup** below). Full order: `--scheme` → `APPDUCT_SCHEME`
→ the nearest `.appduct/config.json` walking up from the working directory → the state
dir's `config.json` → `<cwd>/app.json`. If none of them has one, the error names every
location it tried.

From `link`'s JSON output, use:

- **`data.deepLinkPayload`** to compose the full URL yourself, or just print/relay
  **`data`**'s rendered deep link (`<scheme>:///?appduct=<deepLinkPayload>&pin=<sha256/...>`)
  for a human to open, or scan the QR from `appduct link --scheme myapp --qr` on a TTY.
  Relay the rendered link whole — the `pin` param is what lets a debug build with no embedded
  pins trust the daemon, and anything re-parsing the payload must stop at the `&`.
- **`data.sessionId`** — the selector to poll with in the next step.

For a simulator/emulator you control directly, skip the deep link entirely:

```bash
appduct link --open ios-sim                                   # no app id needed
appduct link --open android --app-id com.example.myapp        # app id required
```

**`--open android` needs `--app-id <id>`** (the installed app's package name) — without it
the command fails with a usage error before minting anything. This is not optional the way it
looks: without naming the package, more than one installed app declaring the same scheme pops
an ambiguous "Open with" chooser on the device, `adb` still reports success either way, and the
next step (`appduct_wait_for_session`/polling) then blocks its whole timeout with nothing
explaining why. Skip `--app-id` if `appduct init --android-app-id <id>` already recorded one in
this project's `.appduct/config.json` — it is picked up automatically. `--open ios-sim` is the
one target that needs no app id at all.

With more than one simulator booted (or several devices attached) this errors and lists
them rather than picking one — re-run with `--device <udid|serial>`.

A paired **physical iPhone/iPad** has an experimental path of its own, never auto-detected
and always opt-in — it needs `--app-id` too (the iOS bundle id, same flag as Android's):

```bash
appduct link --scheme myapp --open ios-device --app-id com.example.myapp
```

It goes through `xcrun devicectl`, so it needs iOS 17+, Xcode 15+, the device paired,
trusted and **connected** with Developer Mode on, a dev-signed build already installed, and
the phone on the same network as this machine (the address is on `link`'s `Endpoint` line).
If the app is already running and the link does not take, add `--relaunch` (it terminates the
running instance first). If it still fails, fall back to the QR flow above — that is still the
only option on iOS 16 and below.

Then poll (or use `appduct events <sessionId> --json` to avoid polling) until the
session shows `state: "active"` in `appduct ls --json` or
`appduct tools <sessionId>` stops erroring.

## Establish a session (MCP)

If this agent is talking to Appduct over MCP instead of a shell, use the built-in
management tools instead of the CLI commands above.

**Call `appduct_connect` with no arguments.** It auto-detects a booted iOS simulator or
attached Android device and delivers the link straight to it — no human involved. A result
with `delivered: true` is done; go on to `appduct_wait_for_session({ sessionId })`,
which blocks until the device connects (or returns immediately if it already has).

The app's own tools are not MCP tools of their own. Reach them through three built-ins that
mirror the CLI:

1. `appduct_list_tools` lists them as one-line signatures with each tool's group and policy
   (like `appduct tools`), and every result carries the app's `groups` with counts. On a large
   app, pick a group from that summary and list it with `group` (`"checkout"` includes
   `"checkout/payment"`), or narrow with `filter`, or page with `limit`/`offset`.
2. `appduct_describe_tool({ name })` shows one tool's full input and output schema (like
   `appduct tools <name>`).
3. `appduct_call_tool({ name, args })` runs it (like `appduct invoke`).

With more than one device connected, pass `selector` (the session alias or id) to each of them. A
tool with policy `"prompt"` asks the user to approve every call; if the user declines, don't
retry it on your own.

Pass `target: "android"` / `"ios-sim"` (plus `device` — an adb serial or simulator udid) only
to override that choice, e.g. when several devices are up and the result said so.

**Android delivery needs an `appId` too** — explicit `target: "android"` or the zero-argument
auto-detected path, either one. Pass it, or record `appId.android` once via `appduct init
--android-app-id <id>` in the project's `.appduct/config.json`; otherwise the call fails with a
clear `invalid_request` before anything is minted, rather than delivering to an ambiguous
"Open with" chooser that would leave `appduct_wait_for_session` hanging with no explanation.
`target: "ios-sim"` and `target: "none"` are the only ones that never need an `appId` — passing
one there is itself rejected.

`target: "ios-device"` reaches a paired **physical** iPhone/iPad and additionally needs
`appId` (the iOS bundle id, same argument Android uses); add `relaunch: true` if the app is
already running and the link does not take. It is experimental and is never picked
automatically — a paired iPhone may be someone's personal phone — so ask for it by name only
when the user has said that is where the app is running, and expect the same prerequisites as
the CLI flag above.

**If the result has a `qr` field instead of `delivered: true`, nothing was delivered and a
human has to act.** Do not call `appduct_wait_for_session` yet — it produces no output
while it waits, so calling it first looks like a hang and burns its whole timeout. Show the
user the `qr` value verbatim in a fenced code block, show `deepLink` under it, and ask them
to scan. The result's `instructions` field says exactly this; follow it. Read `note` to see
why delivery didn't happen — usually no device is booted, or several are and you should
re-call with an explicit `target`.

## Terminate the connection

**`appduct revoke [selector]`** ends one session (closes its socket, frees its
alias) without touching the daemon or any other session. There is normally no reason to
stop the daemon itself — `appduct daemon stop` only if you specifically need to free
the `wss://` port or the daemon's key is being rotated.

## Declaring tools

The app must register tools before `appduct tools` / `appduct invoke` (or MCP
`appduct_call_tool`) can do anything useful. Register with `registerTool` or `useAppductTool`:

```ts
import { registerTool } from "@appduct/react-native";
import { z } from "zod";

const echoInput = z.object({ value: z.unknown() });
const echoOutput = z.object({ echoed: z.unknown() });

registerTool({
  name: "echo",
  description: "Return the input unchanged",
  inputSchema: echoInput,
  outputSchema: echoOutput,
  handler: async (args) => ({ echoed: args.value }),
});
```

`inputSchema`/`outputSchema` accept three forms:

| Form | Validated app-side | Shape agents see |
| --- | --- | --- |
| Standard Schema with a JSON Schema exporter (**Zod v4**, arktype) | yes | its exporter's output |
| `{ schema, jsonSchema }` pair — for Zod 3 (`zod-to-json-schema`), valibot (`@valibot/to-json-schema`) | yes | the supplied JSON Schema |
| A raw JSON Schema object (no `~standard`, at least one JSON Schema keyword) | **no** — args pass through | the object, verbatim |

A bare Zod 3 / plain valibot schema (Standard Schema, no exporter) **throws in `__DEV__`**:
it would otherwise register a shapeless tool that `appduct tools` reports as taking any
object. Pair it, or pass raw JSON Schema.

An input schema must **accept a JSON object**, since a call's args always are one: a root
`type` of string, number or array can never be satisfied (issue #34). A root `anyOf`/`oneOf`
of objects works, but its signature shows as `(...)`, so read the full schema
(`appduct tools <name>`) before calling it.

Put every tool in a `group` once an app has more than a screenful of them
(`group: "cart"`, or `createToolGroup("cart")` to bind it for a whole feature module);
use a subgroup (`group: "checkout/payment"`, at most one level below the group) only
when a group itself outgrows a screen. Each part of a group uses tool-name characters
(`[a-zA-Z0-9_-]`, at most 64); anything else makes registration throw.

## Notes

- Plain text is the CLI's default output and is meant to be read, not parsed — its exact
  wording and layout may change between versions. Add **`--json`** only when a script (not
  you) will parse the output, and `--pretty` to indent it for readability. Runtime failures
  under `--json` are JSON on stderr, not bare text.
- `appduct init`, run once in an app root, records the scheme in
  `.appduct/config.json` and prints the MCP server entry to paste. Re-running it is
  always safe (it keeps the recorded scheme; `--force` re-adopts `app.json`'s), it never
  generates keys, and it never touches daemon state.
- `appduct keygen` is only for **hardening** (rotating the host key, or provisioning
  one in CI ahead of a release build) — the daemon auto-generates a key on first start,
  so a normal dev loop never needs it. It is non-interactive when given `--out`.
- Selectors (session id or alias), not `--session-id`, target a specific session; omit
  the selector when only one session is live.
- If `appduct ls` is empty or `tools`/`invoke` fail with `no_session` or
  `unknown_session`, establish a session first (see above).
- If the app registers no tools, `appduct tools` returns an empty list — that's not an
  error.
- The daemon serves **every** connected device on one process; there's no need to run
  more than one `appduct` daemon, and no `--port` flag to juggle between devices —
  use the selector instead.
- A denied call (production policy set to `"deny"` for that tool/class) surfaces as
  `policy_denied`, not a generic failure — if you see that error type, the fix is a
  policy/config change, not a retry.

## Setup

For project integration guidance, see [setup.md](./references/setup.md).
