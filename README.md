### Let agents and tests reach into your running app — without shipping a debug menu

[![MIT license][license-badge]][license] [![npm downloads][npm-downloads-badge]][npm-downloads] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

Appduct lets a terminal, a test runner, or an AI agent call functions inside your app while it's running — React Native, iOS, or Android. You pick what's callable — a few functions you write yourself — and nothing else is reachable.

## Why you'd want this

**Your E2E tests stop tapping through setup.** Most of an end-to-end test isn't the thing you're testing. It's logging in, dismissing onboarding, seeding a cart, waiting for a spinner. With Appduct, the test calls `login(userId)` or `seedCart(items)` directly and jumps straight to the part that matters. Faster runs, less flakiness, and fewer screenshots for an agent to burn tokens on.

**Agents can drive your app.** Add one line to Claude Code's or Cursor's config and your app's functions show up as tools the agent can call. It can flip a feature flag, jump to a screen, or check some state without you wiring up a single prompt.

**No hidden debug UI.** No secret gestures, no long-press-the-logo admin panel, nothing extra in the app for someone to go find. The only things reachable are functions you deliberately registered.

**Nothing ships in your release build by default.** Appduct is included in debug builds only — a release build compiles it out entirely, not just switches it off. Want it in a TestFlight or other internal build too? You can opt in per build — see [Build variants](docs/BUILD-VARIANTS.md).

**Your dev loop doesn't fight you.** Reloads, backgrounding the app, flaky Wi-Fi — the session survives all of it and picks back up on its own. One background service handles as many devices as you've got plugged in.

## What it looks like

Register something you want reachable:

```ts
import { useAppductTool } from "@appduct/react-native";
import { z } from "zod";

useAppductTool({
  name: "seed_cart",
  description: "Fill the cart with test items.",
  inputSchema: z.object({ items: z.number() }),
  handler: async ({ items }) => ({ added: items }),
});
```

The hook registers once per mount — re-rendering costs nothing, and the handler always sees the latest state it closes over. Apps without React Native register tools from Swift or Kotlin instead — see [Getting started](#getting-started).

Call it from your terminal:

```bash
appduct tools call seed_cart --input '{"items":3}'
```

Or hand it to an agent — see [Use it with an agent](#use-it-with-an-agent). The CLI and the MCP server both read your app's deep-link scheme from its project files — `app.json` in an Expo app, `Info.plist` on iOS, `build.gradle` on Android — so there's nothing to configure.

That's the whole idea. Everything else is about which builds include it and what they trust.

## Is this safe to ship?

By default, yes — nothing here ships in a release build, so there's no code on the device to attack in the first place. If you opt into carrying Appduct in a build that reaches people outside your team (see [Build variants](docs/BUILD-VARIANTS.md)), the connection is still encrypted, your app checks the identity of the machine on the other end rather than trusting whoever's on the network, and a link someone intercepts isn't a way in.

[`docs/SECURITY.md`](docs/SECURITY.md) walks through what it protects against, what it doesn't, and how to configure and rotate keys for that case.

## Getting started

Install the CLI on the machine you'll run it from:

```bash
npm install -g appduct
```

The [CLI guide](packages/appduct/README.md) covers connecting to a device, listing and calling tools, and checking a built artifact. Then add Appduct to your app.

### React Native

```bash
npm install @appduct/react-native zod
```

- **[Set up your app](packages/react-native/README.md)** — registering tools, deep-link setup, and the API reference.
- **[Try the playground](playground/README.md)** — a working app you can run end to end in a few minutes. Fastest way to see whether this fits your project.

You'll need a development build or a bare React Native app — Expo Go can't do it.

### iOS or Android, without React Native

Call Appduct directly from Swift or Kotlin. You get the same tools, deep links, and reconnect behavior as the React Native package, with nothing from React Native in your app.

- **[Set up an iOS app](packages/native/ios/README.md)** — install with Swift Package Manager or CocoaPods.
- **[Set up an Android app](packages/native/android/README.md)** — install from Maven Central.
- **Try the native playgrounds** — a [SwiftUI app](playground-native/ios/README.md) and a [Jetpack Compose app](playground-native/android/README.md) that register the same tools as the React Native playground.

## Use it with an agent

There are two ways to connect an agent. Pick whichever fits how your agent works.

**Over MCP.** Add Appduct to your agent's MCP config — Claude Code, Cursor, or any other MCP client. Your app's tools aren't registered as MCP tools of their own: the agent reaches them through `appduct_list_tools`, `appduct_describe_tool` and `appduct_call_tool`, so a registry of hundreds costs the client three fixed tool definitions. Those tools and the connection tools explain themselves, so there's nothing else to install:

```json
{
  "mcpServers": {
    "appduct": { "command": "appduct", "args": ["mcp"] }
  }
}
```

**Through the CLI.** For agents that work in a shell, and for scripts or CI. Install the Appduct skill so the agent knows the commands:

```bash
npx skills add callstackincubator/appduct --skill appduct
```

Asking an agent to add Appduct to your app or write its tools? Install the skill either way — it covers setup and the rules your tool schemas have to follow.

## Packages

| Package | What it is |
| --- | --- |
| [`appduct`](packages/appduct/README.md) | The CLI, the background service, and the MCP server |
| [`@appduct/react-native`](packages/react-native/README.md) | The app-side library and Expo config plugin |
| [`@appduct/shared`](packages/shared/README.md) | Types shared by the CLI and the React Native library |
| [`AppductCore`](packages/native/ios/README.md) | The iOS library, for apps without React Native (Swift Package Manager or CocoaPods) |
| [`com.callstack.appduct:core`](packages/native/android/README.md) | The Android library, for apps without React Native, paired with `core-noop` for release builds (Maven Central) |

## Support

- **React Native:** iOS 15.1+ and Android, both on the New Architecture. Web gets a no-op stub so shared code doesn't break.
- **iOS without React Native:** iOS 15.1+. Installing with Swift Package Manager needs Xcode 16.3 or newer.
- **Android without React Native:** Android 7.0 (API 24) or newer.
- **CLI:** Node 20 or newer. Windows should work but hasn't been verified.

## Docs

- [`docs/SECURITY.md`](docs/SECURITY.md) — what it protects against, configuring trust, and key rotation
- [`docs/BUILD-VARIANTS.md`](docs/BUILD-VARIANTS.md) — which builds carry Appduct, and how to compile it out
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pieces fit together
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the wire protocol, if you're implementing a client

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

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
