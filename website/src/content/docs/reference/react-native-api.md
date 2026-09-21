---
title: React Native API
description: Entry points, functions, the useAppductTool hook, events, the Expo config plugin, and the Metro helper in @appduct/react-native.
sidebar:
  order: 2
---

Reference for `@appduct/react-native`. For setup, see [React Native setup](/appduct/install/react-native/); for how to design tools, see [Write tools](/appduct/guides/writing-tools/).

## Entry points

| Import | What it does |
| --- | --- |
| `@appduct/react-native` | The API below. Importing it does nothing on its own, and never crashes, even in Expo Go. |
| `@appduct/react-native/auto` | Same API, plus: listens for connection links and restores the session after a reload. Import it once at startup. Importing twice installs once. |
| `@appduct/react-native/noop` | Same API and types, with nothing running. Used when [stripping Appduct from a build](/appduct/guides/build-variants/#strip-appducts-javascript-too). |
| `@appduct/react-native/metro` | `withAppduct(config, options?)` for `metro.config.js`. |

If the native module isn't in the build, every function behaves like `/noop`: it does nothing, never throws, and logs one warning.

## Tools

### `useAppductTool`

```ts
useAppductTool(definition, deps?, options?)
```

Registers a tool while the component is mounted. Registers once per mount, and again only when the registration changes: `name`, `description`, the schemas' JSON Schema, `annotations`, `timeoutMs`, `group`, or `enabled`. Calls always run the handler from the latest render.

| Argument | Description |
| --- | --- |
| `definition` | The same object as [`registerTool`](#registertool). |
| `deps` | Optional. Replaces the automatic change detection with your own dependency list. Rarely needed. |
| `options.enabled` | Default `true`. `false` doesn't register the tool, and removes an existing registration. Use this instead of wrapping the hook in `if`. |

### `registerTool`

```ts
const registration = registerTool({
  name,
  description,
  inputSchema?,
  outputSchema?,
  annotations?,
  timeoutMs?,
  group?,
  handler,
});

registration.remove();
```

| Field | Description |
| --- | --- |
| `name` | Required. Letters, digits, `_`, `-`; 1–64 characters. Unique per app: registering the same name again replaces the tool, with a warning in development. |
| `description` | Required. 1–4,096 characters. |
| `inputSchema` | Arguments schema. Must accept a JSON object. See [schema forms](#schema-forms). |
| `outputSchema` | Result schema. Any JSON value. |
| `annotations` | `{ readOnlyHint?, destructiveHint?, idempotentHint? }`. `destructiveHint` routes calls through the `destructive` [policy](/appduct/guides/security/#limit-what-callers-can-run). |
| `timeoutMs` | Time limit per call. Default 10,000. Clamped to 1,000–600,000. |
| `group` | `"cart"` or `"checkout/payment"`: one or two `/`-separated parts using name characters. |
| `handler` | `(args, context) => result`, sync or async. |

`remove()` removes only this registration, even if the same name was registered again later. A malformed name or group throws.

### `createToolGroup`

```ts
const registerCartTool = createToolGroup("cart");
registerCartTool({ name: "add_item", description: "Add a product to the cart.", handler });
```

Returns a `registerTool` that puts every tool it registers in the given group.

### Handler context

The handler's second argument:

| Field | Description |
| --- | --- |
| `signal` | An `AbortSignal`, aborted when the call times out, the caller cancels, or the connection drops. Uses `aborted` and the `"abort"` event. |
| `reportProgress(progress?, message?)` | Sends a progress update. Never throws; failures go to the `error` listener. |
| `sessionId` | The calling session. |
| `invocationId` | This call's id. |
| `receivedAt` | When the call arrived. |

A thrown error fails the call with `tool_execution_error`. Results that fail `outputSchema` fail with `tool_output_validation_error`; arguments that fail `inputSchema` fail with `tool_input_validation_error` before the handler runs.

### Schema forms

| Form | Example | Validated |
| --- | --- | --- |
| Standard Schema with JSON Schema export | Zod 4, ArkType | Yes |
| `{ schema, jsonSchema }` pair | Zod 3 + `zod-to-json-schema`, Valibot + `@valibot/to-json-schema` | Yes |
| Raw JSON Schema (a plain object) | `{ type: "object", properties: { … } }` | No |

`jsonSchema` in a pair can also be a converter `{ input, output }`. A Standard Schema with no JSON Schema export throws in development and registers without a schema in release builds.

### `jsonSchema<T>()`

```ts
inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } } })
```

Types a raw JSON Schema object so the handler gets typed arguments. Doesn't validate.

### `getRegisteredTools`

Returns the tool descriptors currently registered, for example to show them in your app's UI.

## Events

### `postEvent`

```ts
await postEvent("checkout_completed", { orderId: "ord_4821" });
```

Sends an app event to connected callers (`appduct events`, `appduct_wait_for_event`, `app.waitForEvent`). Dropped, with a warning in development, when no session is connected.

### `addAppductListener`

```ts
const subscription = addAppductListener("stateChange", ({ state, reason }) => {
  console.log(state, reason);
});

subscription.remove();
```

| Kind | Event |
| --- | --- |
| `"stateChange"` | `{ state, reason? }`. `reason` is set on moves to `closed` or `reconnecting`, such as `revoked`, `grace_expired`, `socket_error`, or `background`. |
| `"sessionChange"` | `{ type, sessionId, alias, reason? }`. `type` is `"claimed"`, `"resumed"`, or `"lost"`; `sessionId` and `alias` are `null` once the session is gone. |
| `"error"` | `{ phase, message, code?, hint?, toolName?, … }`. `phase` is `"bootstrap"`, `"connect"`, `"socket"`, or `"tool"`: one channel for link parsing, connection, and handler failures. |

## Connection

### `getAppductState`

Returns `"idle"`, `"connecting"`, `"active"`, `"reconnecting"`, or `"closed"`. `"idle"` when there's no session, and always in a build without Appduct.

### `restoreSession`

```ts
const restored = await restoreSession();
```

Resumes a session that survived a JavaScript reload. `/auto` already calls it. If you don't use `/auto`, call it once at startup, before your own link handling, or every Metro reload drops the session. Resolves `true` when a resume started. A killed app process can't be restored.

### `connect`

```ts
import { connect, parseBootstrapUrl } from "@appduct/react-native";

await connect(parseBootstrapUrl(url));
```

Connects from a link you received yourself. Most apps don't need this: `/auto` does it. `parseBootstrapUrl` throws `AppductBootstrapParseError` with `code` `invalid_url`, `missing_payload`, `invalid_payload`, or `expired_payload`. `connect` rejects with `AppductDisabledError` (`code: "appduct_disabled"`) in a build without Appduct.

### `getAppductBuildConfig`

Returns `{ trust, hasEmbeddedPins, allowPrivateLanOnly }`: the trust settings this build actually uses. `trust` is `"pin"` whenever pins are embedded, `"link"` otherwise, and `"absent"` in a build without Appduct. Never exposes the pins.

## Expo config plugin

Optional. Add it only to [pin a build to your key](/appduct/guides/security/#pin-a-build-to-your-key) or change the network setting:

```json title="app.json"
{
  "expo": {
    "scheme": "myapp",
    "plugins": [
      ["@appduct/react-native", { "cliPins": ["sha256/REPLACE_WITH_KEYGEN_OUTPUT"] }]
    ]
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `cliPins` | none | Array of `sha256/...` fingerprints from `appduct keygen`. Setting it makes `trust` default to `"pin"`. |
| `trust` | `"pin"` with `cliPins`, else `"link"` | `"link"` or `"pin"`. `"pin"` requires non-empty `cliPins`. Anything else fails prebuild. |
| `allowPrivateLanOnly` | `true` | Only follow links that point to a local IPv4 address. |
| `deepLinkScheme` | none | Warns at prebuild if this scheme isn't in `expo.scheme`. |

Run prebuild again after changing these. The removed options `include` and `enableInReleaseBuilds` fail prebuild with a message naming the replacement, `APPDUCT_ENABLED`.

For bare React Native, set the equivalent native keys: see [Security](/appduct/guides/security/#pin-a-build-to-your-key).

## Metro helper

```js title="metro.config.js"
const { withAppduct } = require("@appduct/react-native/metro");

module.exports = withAppduct(config, { include: false });
```

| Option | Default | Description |
| --- | --- | --- |
| `include` | from `APPDUCT_ENABLED` | `false` resolves every `@appduct/react-native` import to `/noop`. |

Call it last in `metro.config.js`. See [Build variants](/appduct/guides/build-variants/#strip-appducts-javascript-too).

## Advanced exports

`appductClient` is the default client the functions above use, and `createAppductClient` creates another. Most apps don't need either. The package also exports its TypeScript types, such as `AppductToolDefinition`, `AppductToolExecutionContext`, and `AppductClientState`.
