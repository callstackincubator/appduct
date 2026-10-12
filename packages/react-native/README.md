<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct for React Native

Call functions inside your running React Native app from a terminal, a test runner or an AI agent. Register tools in JavaScript with `@appduct/react-native`; only the tools you register are reachable.

## Requirements

- React Native with the New Architecture. iOS requires 15.1 or newer.
- An Expo development build or a bare React Native app. Expo Go doesn't run Appduct's native module.
- The `appduct` CLI on your computer: `npm install -g appduct` (Node 20 or newer).

## Getting started

Install the SDK and Zod 4:

```bash
npm install @appduct/react-native zod@^4
```

For an Expo app, set a URL scheme in `app.json`:

```json
{
  "expo": {
    "scheme": "myapp"
  }
}
```

For bare React Native, complete the [native link setup](https://callstackincubator.github.io/appduct/install/react-native/#set-up-the-app) before connecting.

Import `/auto` once in your JS entry file to receive links and restore sessions:

```ts
import "@appduct/react-native/auto";
```

Register a tool in a component mounted near your app's root:

```tsx
import { useAppductTool } from "@appduct/react-native";
import { z } from "zod";

export function AppductTools() {
  useAppductTool({
    name: "seed_cart",
    description: "Fill the cart with test items.",
    inputSchema: z.object({ items: z.number() }),
    outputSchema: z.object({ added: z.number() }),
    handler: async ({ items }) => ({ added: items }),
  });

  return null;
}
```

Mount `<AppductTools />` in your existing app. Rebuild and run the Expo development client:

```bash
npx expo run:ios
```

For bare React Native, install pods on iOS and rebuild as usual. In another terminal, from your app's project root:

```bash
appduct sessions link --scheme myapp --open ios-sim
appduct tools ls
appduct tools call seed_cart --input '{"items":3}'
```

The tool returns `{"added":3}`. For Android, use `npx expo run:android` and record your installed build's id with `appduct init --scheme myapp --android-app-id com.example.shop`, then use `--open android`.

## Things to know

- **Mount the component that registers the tool.** `useAppductTool` registers while mounted and calls the latest handler. Use `registerTool` outside React; see the [API reference](https://callstackincubator.github.io/appduct/reference/react-native-api/).
- **Choose a schema form.** Zod 4 works directly. Other validators may need a `{ schema, jsonSchema }` pair; raw JSON Schema works without runtime validation. Inputs must accept an object. See [Schemas](https://callstackincubator.github.io/appduct/guides/writing-tools/#choose-a-schema-form).
- **Give slow tools a timeout.** Calls get 10 seconds unless registration declares `timeoutMs`. See [Long-running tools](https://callstackincubator.github.io/appduct/guides/writing-tools/#long-running-tools).
- **Reconnect after process death.** `/auto` resumes sessions after Metro reloads and short network drops. Killing the app requires a new link. If you handle links yourself, call `restoreSession()`; see [Manual link handling](https://callstackincubator.github.io/appduct/install/react-native/#handle-links-yourself).
- **Configure Metro for Web builds.** Wrap your Metro config in `withAppduct` to use the same tools on Web; see [Build variants](https://callstackincubator.github.io/appduct/guides/build-variants/#strip-appducts-javascript-too).

## Release builds

Appduct's native module is included in debug builds by default. When it is absent, registration is inert and `connect()` rejects with `appduct_disabled`. To include it in an internal release build or strip its JavaScript too, follow [Build variants](https://callstackincubator.github.io/appduct/guides/build-variants/). Use the hook's `{ enabled }` option to gate individual tools.

Pin an included build to your key before distributing it. Check a built app that should exclude Appduct:

```bash
appduct doctor build/Shop.ipa --assert-absent
```

## Learn more

- [React Native setup](https://callstackincubator.github.io/appduct/install/react-native/): Expo, bare apps and troubleshooting
- [API reference](https://callstackincubator.github.io/appduct/reference/react-native-api/): entry points, hooks, events and config
- [Write tools](https://callstackincubator.github.io/appduct/guides/writing-tools/): annotations, groups and cancellation
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/) over MCP
- [Security](https://callstackincubator.github.io/appduct/guides/security/): trust and key pinning
- [React Native playground](https://github.com/callstackincubator/appduct/blob/main/playground/README.md): a runnable example

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE). Made at [Callstack](https://callstack.com/).
