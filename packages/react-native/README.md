[![Appduct][appduct-banner]][repo]

### Drive app tools without shipping debug UI

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

`@appduct/react-native` is the app-side client for Appduct. Your app registers tools in JavaScript; a CLI, MCP client, or test suite invokes them once the app opens a bootstrap link and completes a pinned `wss://` handshake — no debug menu required.

## Requirements

You need a development build or a bare React Native app — Expo Go can't load native code, so it can't run Appduct.

## Getting started

### 1. Install

The app-side package plus a schema library:

```bash
npm install @appduct/react-native zod
```

The CLI, on the machine running the host:

```bash
npm install -g appduct
```

### 2. Nothing to configure yet

No key, no pins, and no config plugin are needed for a first run, in any build type. The daemon auto-generates a key on first start, and `appduct link` carries its `sha256/...` fingerprint on the deep link for the app to trust for that session.

Wire your deep-link scheme so the OS can open the app with that link. For an Expo app that's all: `appduct link` reads `expo.scheme` straight out of `app.json`. Otherwise (a dynamic `app.config.js`, which Appduct never executes, or bare React Native) name it with `appduct init --scheme <s>`, `--scheme`, or `APPDUCT_SCHEME` — the [CLI README](https://github.com/callstackincubator/appduct/blob/main/packages/appduct/README.md#the-deep-link-scheme) has the full resolution order. To make a build trust only pins you embedded ahead of time, see [Configuring trust](https://github.com/callstackincubator/appduct/blob/main/docs/SECURITY.md#configuring-trust).

By default the native module ships in **debug** builds only: a release build has none, so the API is inert and `connect()` rejects with `appduct_disabled` (see [Build variants](https://github.com/callstackincubator/appduct/blob/main/docs/BUILD-VARIANTS.md)).

### 3. Import Appduct in the JS entry point

```ts
import "@appduct/react-native/auto";
```

`/auto` is the only entry that installs anything: the deep-link bootstrap listener and session recovery. To control when it installs — in `__DEV__`, behind a QA toggle — `require()` it there instead:

```ts
if (__DEV__) {
  require("@appduct/react-native/auto");
}
```

The default flow needs no `Linking` handler of your own, and sessions survive Metro reloads and network flaps — see [ARCHITECTURE.md §11](https://github.com/callstackincubator/appduct/blob/main/docs/ARCHITECTURE.md#11-react-native-sdk) for lease, resume, and reconnect rules.

If you drive bootstrap yourself and never import `/auto`, call `restoreSession()` before your own bootstrap handling — it's then the only reader of the native resume lease.

### 4. Define tools in app startup code

Call `registerTool({ ... })` with `inputSchema`/`outputSchema` values and a `handler`. Zod v4 works out of the box — its JSON Schema exporter is what lets agents see a real tool shape. A library without one (zod 3, plain valibot) needs a `{ schema, jsonSchema }` pair, and a raw JSON Schema object works with no validation library at all — see [Accepted schema forms](https://github.com/callstackincubator/appduct/blob/main/docs/TOOLS.md#accepted-schema-forms).

`useAppductTool` wraps `registerTool` in a `useEffect`, so registration follows the component's lifecycle, remounts and Fast Refresh included:

```ts
import "@appduct/react-native/auto";
import { useAppductTool } from "@appduct/react-native";
import { z } from "zod";

export function AppductBootstrap() {
  useAppductTool(
    {
      name: "sum",
      description: "Add two numeric values",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ total: z.number() }),
      handler: async ({ a, b }) => ({ total: a + b }),
    },
    []
  );

  return null;
}
```

Mount it near app startup, or register from a module that loads then. The host can only invoke tools your app already registered.

The hook registers once per mount and re-registers only when the registration itself changes, routing every call through the latest render's handler — so `deps` is an optional override, not something each call site has to get right. See [Registration is per mount, not per render](https://github.com/callstackincubator/appduct/blob/main/docs/TOOLS.md#registration-is-per-mount-not-per-render).

Keep both schemas object-rooted: MCP requires it, and a schema that isn't degrades gracefully rather than taking your whole tool list down — see [Keep both schemas object-rooted](https://github.com/callstackincubator/appduct/blob/main/docs/TOOLS.md#keep-both-schemas-object-rooted). A call gets 10 seconds unless the registration declares `timeoutMs` — see [Long-running tools](https://github.com/callstackincubator/appduct/blob/main/docs/TOOLS.md#long-running-tools).

To keep a destructive tool out of some build variants, pass `{ enabled }` rather than wrapping the hook in an `if` — see [Gating a tool by build variant](https://github.com/callstackincubator/appduct/blob/main/docs/SECURITY.md#gating-a-tool-by-build-variant).

### 5. Start the daemon and test the flow

`appduct` auto-spawns its daemon. `link` needs your app's deep-link scheme: pass `--scheme` (matching `expo.scheme`), or set `scheme` once in `~/.appduct/config.json`:

```bash
appduct link --scheme myapp --qr
```

Scan the QR (or open the link) in the app, then list and invoke tools:

```bash
appduct tools
appduct invoke sum --input '{"a":2,"b":3}'
```

Omit the session selector when only one session is active; pass an alias or session id when several are (`appduct ls`).

## API reference

### Entry points

| Entry | Behavior |
| --- | --- |
| `@appduct/react-native` | Side-effect-free. The native module is looked up lazily, on the first native call, so importing it (even in Expo Go) never crashes. |
| `@appduct/react-native/auto` | Same exports plus one side effect: installs the deep-link bootstrap listener and starts lease recovery — the only entry that installs anything. |
| `@appduct/react-native/noop` | Same public API, fully inert — for [compiling Appduct out of production builds](https://github.com/callstackincubator/appduct/blob/main/docs/BUILD-VARIANTS.md#compiling-appduct-out-of-production-builds). |
| `@appduct/react-native/metro` | `withAppduct(config, { include })` — swaps the real entries for `/noop` at bundle time. |

### Exports

| Export | Signature / notes |
| --- | --- |
| `registerTool` | `({ name, description, inputSchema?, outputSchema?, annotations?, handler })` → `{ remove() }`. The disposer removes only its own registration. |
| `useAppductTool` | `(definition, deps?, { enabled? })`. Registers once per mount, re-registering only when the descriptor changes; `deps` overrides that derivation. `enabled` defaults to `true`; `false` never registers, and removes any registration that hook owns. |
| `handler` | `(args, context)`. `context.signal` is an `AbortSignal`, aborted when the caller cancels or the connection drops mid-call. Forward it (`fetch(url, { signal })`), check `signal.aborted`, or listen for `"abort"` — ignoring it is fine, the handler replies normally. |
| `postEvent` | `(name, payload?)` — pushes an app event, read by `appduct events` and the MCP event tools. |
| `addAppductListener` | `(kind, callback)` → `{ remove() }`. Kinds `"stateChange"`, `"sessionChange"`, `"error"` — the last one is a unified channel for bootstrap-parse, connect, socket, and tool-handler failures. |
| `getRegisteredTools` | → `ToolDescriptor[]`, the current registry. |
| `getAppductState` | → the client's connection state (`"idle"` with no session). |
| `restoreSession` | → `Promise<boolean>`. Recovers the native resume lease; also on `appductClient`. |
| `connect` | `(input)` → `Promise<void>`. Claims a parsed bootstrap payload; rejects with `AppductDisabledError` (`code: "appduct_disabled"`) when native is absent. |
| `parseBootstrapUrl` | Parses a v2 bootstrap deep link (and its sibling `pin` param) for `connect`. |
| `getAppductBuildConfig` | → `{ trust, hasEmbeddedPins, allowPrivateLanOnly }`, this build's [effective trust configuration](https://github.com/callstackincubator/appduct/blob/main/docs/SECURITY.md#reading-the-effective-configuration-at-runtime). |

## Platform compatibility

| Platform | Support |
| --- | --- |
| **iOS** | 15.1+ (`Appduct.podspec`), New Architecture |
| **Android** | Autolinked, New Architecture |
| **Web** | Stub only |

## Going further

- [Trust modes](https://github.com/callstackincubator/appduct/blob/main/docs/SECURITY.md#trust-modes) and [Configuring trust](https://github.com/callstackincubator/appduct/blob/main/docs/SECURITY.md#configuring-trust) — pins, plugin options, bare-RN native keys.
- [Registering tools](https://github.com/callstackincubator/appduct/blob/main/docs/TOOLS.md) — schema forms, what re-registers, MCP's object-rooted requirement, `timeoutMs`.
- [Gating a tool by build variant](https://github.com/callstackincubator/appduct/blob/main/docs/SECURITY.md#gating-a-tool-by-build-variant) — `enabled`, and why `__DEV__` is wrong here.
- [Build variants](https://github.com/callstackincubator/appduct/blob/main/docs/BUILD-VARIANTS.md) — `APPDUCT_ENABLED`, autolinking exclusion, compiling Appduct out of production builds.
- [What a build without the native module does](https://github.com/callstackincubator/appduct/blob/main/docs/SECURITY.md#what-a-build-without-the-native-module-does).
- [Release gate: `appduct doctor`](https://github.com/callstackincubator/appduct/blob/main/docs/CI.md#release-gate-appduct-doctor).
- [ARCHITECTURE.md §11](https://github.com/callstackincubator/appduct/blob/main/docs/ARCHITECTURE.md#11-react-native-sdk) — resume lease, reconnect, cancellation.
- [`appduct` CLI and MCP server](https://github.com/callstackincubator/appduct/blob/main/packages/appduct/README.md).

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[appduct-banner]: https://img.shields.io/badge/Appduct-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/appduct
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
[license-badge]: https://img.shields.io/npm/l/appduct?style=for-the-badge
[license]: https://github.com/callstackincubator/appduct/blob/main/LICENSE
[npm-downloads-badge]: https://img.shields.io/npm/dm/appduct?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/appduct
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/appduct/pulls
[chat-badge]: https://img.shields.io/discord/426714625279524876.svg?style=for-the-badge
[chat]: https://discord.gg/xgGt7KAjxv
