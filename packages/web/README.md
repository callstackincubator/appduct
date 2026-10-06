[![Appduct][appduct-banner]][repo]

### Drive app tools in a web page

[![MIT license][license-badge]][license] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

`@appduct/web` lets a terminal, a test runner or an AI agent call functions inside a web page you're running. You register tools in the page; the `appduct` CLI, the MCP server and `appduct/client` call them. Works with any framework or none.

## Requirements

The browser runs on the same computer as the Appduct CLI. A page on `http://localhost` works in Chrome, Firefox and Safari. A page on `https://` has limits; see [Browser support](#browser-support).

## Getting started

Install the package in your app, and the CLI on your computer:

```bash
npm install @appduct/web
npm install -g appduct
```

Register a tool:

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

Connect the page. The CLI prints a URL; open it in the browser:

```bash
appduct sessions link --open web http://localhost:5173/
```

The page claims the session and removes the link from the address bar. `appduct sessions ls` now lists it, and `appduct tools call seed_cart --input '{"items":3}'` calls your tool.

An agent that is already driving the tab can connect without a reload. `appduct_connect` with `target: "web"` and a `url` returns both the URL and a script such as `window.__APPDUCT__.connect("...")`. Run the script in the page and it keeps its state. A link works once and expires after 5 minutes.

Reloading the page resumes the session. Opening the page in a new tab doesn't.

`registerEvent`, `postEvent` and `disconnect` work as in the other SDKs; see [Registering tools](https://callstackincubator.github.io/appduct/guides/writing-tools/).

## Production builds

Your production bundle leaves Appduct out by default. `@appduct/web` has two entries, and your bundler picks one by export condition:

- Under the `development` condition, which Vite, webpack and Next.js set for development builds, you get the real entry.
- Under any other condition, such as a production build, you get an inert entry with the same API. It registers nothing, opens no connection and doesn't define `window.__APPDUCT__`.

You don't change your code. Calls to `registerTool` in a production build do nothing, and the session client isn't in the bundle.

If you call `connect()` in a build that got the inert entry, it logs one warning and does nothing. That also happens when your bundler sets no `development` condition, as plain esbuild does. Either set the condition, or import `@appduct/web/enabled`.

To include Appduct in a build that isn't `development`, such as a staging build, import the real entry explicitly:

```ts
import { registerTool } from "@appduct/web/enabled";
```

Only import `@appduct/web/enabled` in builds you control: a page that includes it can be driven by anything that has a link. Read [Security](https://callstackincubator.github.io/appduct/guides/security/#web-pages) first, and see [Build variants](https://callstackincubator.github.io/appduct/guides/build-variants/#web-production-builds) for the details.

## Browser support

| Page | Chrome | Firefox | Safari |
| --- | --- | --- | --- |
| `http://localhost` dev server | Works | Works | Works |
| `https://` staging | Works once you grant the local network access permission | Works | Not supported: Safari blocks `ws://127.0.0.1` from `https` pages |

Chrome asks for the local network access permission the first time an `https` page connects. In a browser a test runner launches, grant it up front. In Playwright:

```ts
await context.grantPermissions(["local-network-access"], { origin: "https://app.example.test" });
```

For an `https` page that isn't on localhost, add its origin to `webOrigins` in `~/.appduct/config.json`; see [Security](https://callstackincubator.github.io/appduct/guides/security/#web-pages).

## What it doesn't do

- A browser on another computer, or a cloud browser, can't connect.
- The page can't check that it's talking to your Appduct daemon, as a native app can. It connects to a port that only your computer can reach, and the daemon only accepts pages from allowed origins.

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

[appduct-banner]: https://img.shields.io/badge/Appduct-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/appduct
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
[license-badge]: https://img.shields.io/github/license/callstackincubator/appduct?style=for-the-badge
[license]: https://github.com/callstackincubator/appduct/blob/main/LICENSE
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/appduct/pulls
