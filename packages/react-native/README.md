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

No key, no pins, and no config plugin are needed for a first run, in any build type. The daemon auto-generates a key on first start, and `appduct sessions link` carries its `sha256/...` fingerprint on the deep link for the app to trust for that session.

Wire your deep-link scheme so the OS can open the app with that link. That's all the CLI needs: `appduct sessions link` reads `expo.scheme` from `app.json`, or, in bare React Native, the scheme your `Info.plist` or `AndroidManifest.xml` already declares. If the scheme lives only in a dynamic `app.config.js`, which Appduct never executes, name it with `appduct init --scheme <s>`, `--scheme`, or `APPDUCT_SCHEME` — the [CLI README](https://github.com/callstackincubator/appduct/blob/main/packages/appduct/README.md#the-deep-link-scheme) has the full resolution order. To make a build trust only pins you embedded ahead of time, see [Configuring trust](https://callstackincubator.github.io/appduct/guides/security/#pin-a-build-to-your-key).

By default the native module ships in **debug** builds only: a release build has none, so the API is inert and `connect()` rejects with `appduct_disabled` (see [Build variants](https://callstackincubator.github.io/appduct/guides/build-variants/)).

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

The default flow needs no `Linking` handler of your own. A session survives Metro reloads and network drops: the app reconnects by itself and picks up the same session, as long as it comes back within the daemon's grace period (10 minutes by default).

If you drive bootstrap yourself and never import `/auto`, call `restoreSession()` before your own bootstrap handling — it's then the only reader of the native resume lease.

### 4. Define tools in app startup code

Call `registerTool({ ... })` with `inputSchema`/`outputSchema` values and a `handler`. Zod v4 works out of the box — its JSON Schema exporter is what lets agents see a real tool shape. A library without one (zod 3, plain valibot) needs a `{ schema, jsonSchema }` pair, and a raw JSON Schema object works with no validation library at all — see [Accepted schema forms](https://callstackincubator.github.io/appduct/guides/writing-tools/#choose-a-schema-form).

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
    }
  );

  return null;
}
```

Mount it near app startup, or register from a module that loads then. The host can only invoke tools your app already registered.

The hook registers once per mount and re-registers only when the registration itself changes, routing every call through the latest render's handler — so `deps` is an optional override, not something each call site has to get right. See [Registration is per mount, not per render](https://callstackincubator.github.io/appduct/guides/writing-tools/#advanced-the-hooks-deps-argument).

Make `inputSchema` accept an object: a call's arguments are always a JSON object — see [Make the input schema accept an object](https://callstackincubator.github.io/appduct/guides/writing-tools/#make-the-input-schema-accept-an-object). A call gets 10 seconds unless the registration declares `timeoutMs` — see [Long-running tools](https://callstackincubator.github.io/appduct/guides/writing-tools/#long-running-tools).

To keep a destructive tool out of some build variants, pass `{ enabled }` rather than wrapping the hook in an `if` — see [Gating a tool by build variant](https://callstackincubator.github.io/appduct/guides/security/#keep-a-tool-out-of-some-builds).

An agent picks a tool from one signature line and the first line of its description, so name tools by intent, set `annotations` (`readOnlyHint`, `destructiveHint`), declare an `outputSchema`, and describe each parameter — see [Designing tools for agents](https://callstackincubator.github.io/appduct/guides/writing-tools/#design-tools-for-the-agent-that-calls-them).

### 5. Link the app and call a tool

Run this from your app's directory. The daemon starts on its own, and the scheme is read from `app.json` or the native project files, as in step 2; pass `--scheme <s>` to override it:

```bash
appduct sessions link --qr
```

Scan the QR (or open the link) in the app, then list and invoke tools:

```bash
appduct tools ls
appduct tools call sum --input '{"a":2,"b":3}'
```

Omit the session selector when only one session is active; pass an alias or session id when several are (`appduct sessions ls`).

## API reference

### Entry points

| Entry | Behavior |
| --- | --- |
| `@appduct/react-native` | Side-effect-free. The native module is looked up lazily, on the first native call, so importing it (even in Expo Go) never crashes. |
| `@appduct/react-native/auto` | Same exports plus one side effect: installs the deep-link bootstrap listener and starts lease recovery — the only entry that installs anything. |
| `@appduct/react-native/noop` | Same public API, fully inert — for [compiling Appduct out of production builds](https://callstackincubator.github.io/appduct/guides/build-variants/#strip-appducts-javascript-too). |
| `@appduct/react-native/metro` | `withAppduct(config, { include })` — swaps the real entries for `/noop` at bundle time. |

### Exports

| Export | Signature / notes |
| --- | --- |
| `registerTool` | `({ name, description, inputSchema?, outputSchema?, annotations?, timeoutMs?, group?, handler })` → `{ remove() }`. The disposer removes only its own registration. `group` (`"cart"`, or a subgroup like `"checkout/payment"`) lets agents list your tools one area at a time — see [Group tools in a large app](https://callstackincubator.github.io/appduct/guides/writing-tools/#group-tools-in-a-large-app). |
| `createToolGroup` | `(group)` → a `registerTool` that puts every tool it registers in `group`. |
| `useAppductTool` | `(definition, deps?, { enabled? })`. Registers once per mount, re-registering only when the descriptor changes; `deps` overrides that derivation. `enabled` defaults to `true`; `false` never registers, and removes any registration that hook owns. |
| `handler` | `(args, context)`. `context.signal` is an `AbortSignal`, aborted when the caller cancels or the connection drops mid-call. Forward it (`fetch(url, { signal })`), check `signal.aborted`, or listen for `"abort"` — ignoring it is fine, the handler replies normally. |
| `registerEvent` | `({ name, description, payloadSchema? })` → `{ remove() }`. Lists an event you post, so `appduct events ls` and `appduct_list_events` show it before an agent waits on it. `payloadSchema` is a Standard Schema or raw JSON Schema, as for a tool; see [Declare the events you post](https://callstackincubator.github.io/appduct/guides/writing-tools/#tell-callers-something-happened). |
| `postEvent` | `(name, payload?)` — pushes an app event, read by `appduct events tail` and the MCP event tools. |
| `addAppductListener` | `(kind, callback)` → `{ remove() }`. Kinds `"stateChange"`, `"sessionChange"`, `"error"` — the last one is a unified channel for bootstrap-parse, connect, socket, and tool-handler failures. |
| `getRegisteredTools` | → `ToolDescriptor[]`, the current registry. |
| `getAppductState` | → the client's connection state (`"idle"` with no session). |
| `restoreSession` | → `Promise<boolean>`. Recovers the native resume lease; also on `appductClient`. |
| `connect` | `(input)` → `Promise<void>`. Claims a parsed bootstrap payload; rejects with `AppductDisabledError` (`code: "appduct_disabled"`) when native is absent. |
| `parseBootstrapUrl` | Parses a v2 bootstrap deep link (and its sibling `pin` param) for `connect`. |
| `getAppductBuildConfig` | → `{ trust, hasEmbeddedPins, allowPrivateLanOnly }`, this build's [effective trust configuration](https://callstackincubator.github.io/appduct/reference/react-native-api/#getappductbuildconfig). |

## Platform compatibility

| Platform | Support |
| --- | --- |
| **iOS** | 15.1+ (`Appduct.podspec`), New Architecture |
| **Android** | Autolinked, New Architecture |
| **Web** | The same tools work in your web build. Open the link from `appduct sessions link --open web <url>` and the page connects; see [Security](https://callstackincubator.github.io/appduct/guides/security/#web-pages). |

## Going further

- [Trust modes](https://callstackincubator.github.io/appduct/guides/security/#choose-what-a-build-trusts) and [Configuring trust](https://callstackincubator.github.io/appduct/guides/security/#pin-a-build-to-your-key) — pins, plugin options, bare-RN native keys.
- [Registering tools](https://callstackincubator.github.io/appduct/guides/writing-tools/) — schema forms, what re-registers, tool groups, input schemas that accept an object, `timeoutMs`, and [designing tools for agents](https://callstackincubator.github.io/appduct/guides/writing-tools/#design-tools-for-the-agent-that-calls-them).
- [Gating a tool by build variant](https://callstackincubator.github.io/appduct/guides/security/#keep-a-tool-out-of-some-builds) — `enabled`, and why `__DEV__` is wrong here.
- [Build variants](https://callstackincubator.github.io/appduct/guides/build-variants/) — `APPDUCT_ENABLED`, autolinking exclusion, compiling Appduct out of production builds.
- [What a build without the native module does](https://callstackincubator.github.io/appduct/guides/build-variants/#what-a-build-without-appduct-does).
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
