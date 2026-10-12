<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct for Web

Call functions inside your running web page from a terminal, a test runner or an AI agent. Register tools with `@appduct/web`; only the tools you register are reachable. Works with any framework or plain JavaScript.

## Requirements

- A browser on the same computer as the Appduct CLI.
- A local development page, such as `http://localhost:5173/`. For HTTPS pages, check the [browser and transport guide](https://callstackincubator.github.io/appduct/guides/web-pages/).
- The `appduct` CLI: `npm install -g appduct` (Node 20 or newer).

## Getting started

Install the SDK:

```bash
npm install @appduct/web
```

Register a tool in your page's startup code:

```ts
import { registerTool } from "@appduct/web";

registerTool({
  name: "seed_cart",
  description: "Fill the cart with test items.",
  inputSchema: {
    type: "object",
    properties: { items: { type: "number" } },
    required: ["items"],
  },
  handler: async ({ items }) => ({ added: items }),
});
```

Run your development server, then connect the page using its URL:

```bash
appduct sessions link --open web http://localhost:5173/
```

Open the URL the CLI prints in your browser, then:

```bash
appduct tools ls
appduct tools call seed_cart --input '{"items":3}'
```

The tool returns `{"added":3}`.

<a id="browser-support"></a>

## Things to know

- **Reloads resume the session; new tabs don't.** The page removes the connection link from its address bar after claiming it.
- **Raw schemas don't validate arguments.** Check inputs in the handler, or use a [supported schema library](https://callstackincubator.github.io/appduct/guides/writing-tools/#choose-a-schema-form).
- **React has a hook entry.** Import `useAppductTool` from `@appduct/web/react` to register a tool while a component is mounted.
- **An agent can connect without reloading.** `appduct_connect` returns a script it can run in the page. DevTools and Playwright connections are covered in [Drive a web page](https://callstackincubator.github.io/appduct/guides/web-pages/).
- **Check the build if nothing connects.** The default import needs your bundler's `development` condition. Otherwise it uses an inert entry; see [Web setup](https://callstackincubator.github.io/appduct/install/web/).

## Release builds

The default entry is inert outside the `development` export condition: it registers nothing, opens no connection and doesn't define `window.__APPDUCT__`. To include Appduct in a staging build, import the enabled entry:

```ts
import { registerTool } from "@appduct/web/enabled";
```

Use it only in builds you control. Web pages don't pin the daemon's key; review [Web security](https://callstackincubator.github.io/appduct/guides/security/#web-pages), including allowed origins, before enabling a hosted page. See [Build variants](https://callstackincubator.github.io/appduct/guides/build-variants/#web-production-builds).

## Learn more

- [Web setup](https://callstackincubator.github.io/appduct/install/web/)
- [Drive a web page](https://callstackincubator.github.io/appduct/guides/web-pages/): browser support, DevTools and Playwright
- [Write tools](https://callstackincubator.github.io/appduct/guides/writing-tools/): schemas, timeouts, groups and events
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/) over MCP
- [Web playground](https://github.com/callstackincubator/appduct/blob/main/playground-web/README.md): a runnable example

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
