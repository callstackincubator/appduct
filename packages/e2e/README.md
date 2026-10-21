<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct for e2e

Call your app's Appduct tools from [e2e](https://github.com/tester-army/e2e) tests, and let e2e's agent call them during agent steps. Set up state without tapping through the UI, and check what the app holds instead of only what it shows.

## Requirements

- An app that registers tools with an Appduct SDK, in a debug build. Web pages load `@appduct/web` from a development build.
- e2e 0.21 or newer, with its web or mobile engine.
- Web, iOS simulator or Android emulator targets.
- For iOS and Android, the app's URL scheme in `.appduct/config.json` at your e2e project root, as the `appduct` CLI reads it.

## Getting started

```bash
npm install -D @appduct/e2e
```

Add the `appduct` fixture to your `test` in one place:

```ts
// tests/fixtures.ts
import { test as base } from "e2e";
import { withAppduct } from "@appduct/e2e";

export const test = withAppduct(base);
```

`base` can also be an engine's `test`, such as the one from `@e2e-dev/mobile`, or a `test` you already extended with fixtures of your own. Then write tests with it:

```ts
// tests/cart.e2e.ts
import { expect } from "e2e";
import { test } from "./fixtures.ts";

test("a seeded cart checks out", async ({ app, appduct, screen }) => {
  await app.open();
  await appduct.call("seed_cart", { items: 3 });

  await screen.getByRole("button", { name: "Check out" }).tap();

  expect(await appduct.call("order_status")).toEqual({ status: "paid" });
});
```

The first `appduct` call in a test connects to the app the test opened. A test that never uses `appduct` doesn't connect.

## Let the agent call your tools

Add `appductTools()` to an agent's `tools` in `e2e.config.ts`:

```ts
import type { E2EConfig } from "e2e";
import { appductTools } from "@appduct/e2e";

export default {
  // targets: …
  agents: { default: { model, tools: appductTools() } },
} satisfies E2EConfig;
```

The agent gets `appduct_tools`, which lists the app's tools, and `appduct_call`, which calls one. They work in tests written with a `test` from `withAppduct`.

## The `appduct` fixture

| Member | What it does |
| --- | --- |
| `call(name, args?, options?)` | Calls a tool and returns its result. Waits up to 10 seconds for a tool the app hasn't registered yet. |
| `tools()` | Lists the app's tools. Waits up to 10 seconds for the app to register its first. |
| `waitForEvent(name, options?)` | Resolves with the next event the app posts under `name`. |

Errors are `AppductError`s from `appduct/client`, with the same `type` the CLI reports.

## Things to know

- **The connection lasts as long as the app does.** A test that keeps the app running, such as the next test in a `serial` group, reuses the previous test's connection. After `app.open()`, `app.restart()` or a reload, the next call connects to the new app and ends the old connection, so `appduct sessions ls` doesn't fill up with dead sessions.
- **iOS asks before opening a link when several simulators are booted.** With one booted simulator, the link goes straight to the app. With several, or a phone, e2e opens the link and accepts iOS's "Open in …?" question, which adds a few seconds and shows a failed `device.alert` step in the report even though the link opened.
- **On an iPhone, shut down any booted simulator.** With exactly one simulator booted, the link goes to that simulator, and the test times out waiting for the phone.
- **Agent steps that call `appduct_call` run live.** e2e can't replay a call that may change app state from its cache.
- **Tests that run on a device pool connect only through e2e.** Each connection still goes to the device the test runs on, at the slower speed above.

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
