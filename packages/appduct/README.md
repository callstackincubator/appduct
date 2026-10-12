<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct CLI, MCP server and test client

Call tools inside a running iOS, Android, React Native, Flutter or Web app from your terminal, an AI agent or a test suite. The `appduct` package connects to apps that have an Appduct SDK installed and tools registered.

## Requirements

- Node 20 or newer.
- An Appduct-enabled app. Choose an [SDK setup guide](https://callstackincubator.github.io/appduct/start/introduction/#packages), or [try a playground](https://callstackincubator.github.io/appduct/start/playground/).
- For automatic device delivery: Xcode for an iOS Simulator, or `adb` for Android. Physical devices can use a QR code; Web pages use their URL.

## Getting started

Install the CLI:

```bash
npm install -g appduct
```

With your app running, connect from its project directory:

```bash
appduct sessions link --qr
```

Scan the QR code with the device's camera. The app needs a URL scheme, which the CLI can discover from static project files; use `--scheme myapp` if needed. A physical device must be on the same local network as your computer.

For a simulator, Android device or Web page, choose one of these paths instead:

```bash
appduct sessions link --open ios-sim
appduct sessions link --open android --app-id com.example.shop
appduct sessions link --open web http://localhost:5173/
```

The Web command prints a URL to open. Once connected, list tools and call one your app registered:

```bash
appduct tools ls
appduct tools call seed_cart --input '{"items":3}'
```

The SDK quick starts register this example tool, which returns `{"added":3}`. Appduct starts its background service automatically.

## Common commands

| Command | What you can do |
| --- | --- |
| `appduct init` | Record your project's scheme and app ids, and print MCP configuration. |
| `appduct sessions ls` | Find connected sessions and their aliases. |
| `appduct tools ls` | Find registered tools; use `--groups` or `--group cart` for larger registries. |
| `appduct tools describe seed_cart` | Read a tool's full schema. |
| `appduct tools call seed_cart --input '{"items":3}'` | Call a tool. |
| `appduct events ls` | Find the events the app declares. |
| `appduct events tail --follow` | Watch events the app posts. |
| `appduct sessions revoke` | Disconnect a session. |
| `appduct daemon status` | Inspect the background service. |
| `appduct doctor build/Shop.ipa --assert-absent` | Check that a built app excludes Appduct. |

Run `appduct <command> --help` for flags, or read the [CLI reference](https://callstackincubator.github.io/appduct/reference/cli/). Use `--json` for scripts.

## Connect an agent

Add this entry to your agent's MCP configuration, replacing `myapp` with your app's scheme:

```json
{
  "mcpServers": {
    "appduct": {
      "command": "appduct",
      "args": ["mcp", "--scheme", "myapp"]
    }
  }
}
```

The agent can connect a device, list your app's tools, inspect their schemas and call them. App tools are reached through `appduct_list_tools`, `appduct_describe_tool` and `appduct_call_tool`; event and connection tools are available too. See [Use Appduct with an agent](https://callstackincubator.github.io/appduct/guides/agents/) for client setup and approval policy.

## Call tools from tests

<a id="test-runners-appductclient"></a>

Install `appduct` as a dev dependency of your test project. With the app connected:

```ts
import { connect } from "appduct/client";

const app = await connect();
try {
  const result = await app.call("seed_cart", { items: 3 });
  // result: { added: 3 }
} finally {
  app.close();
}
```

The client also pairs devices, waits for sessions, reads events and supports a typed tool map. Failures reject with an `AppductError` whose `type` names the error. See [Test setup](https://callstackincubator.github.io/appduct/guides/cli/#drive-the-app-from-a-test-suite) and the [client reference](https://callstackincubator.github.io/appduct/reference/cli/#appductclient).

<a id="the-deep-link-scheme"></a>

## Things to know

- **Select a session when several are connected.** Pass an alias or session id from `appduct sessions ls`; the CLI won't guess.
- **Declare longer timeouts in the app.** `tools call --timeout` can shorten a deadline, but it can't extend the app's timer. See [Long-running tools](https://callstackincubator.github.io/appduct/guides/writing-tools/#long-running-tools).
- **Keep project settings and private state separate.** `appduct init` writes project settings to `.appduct/config.json`. The daemon keeps its key and logs in `~/.appduct`; don't commit that directory.
- **Pin builds you distribute.** `appduct keygen` prints a pin to embed in the app. See [Security](https://callstackincubator.github.io/appduct/guides/security/) for trust, policy and key rotation.
- **Reconnect after stopping the daemon.** `appduct daemon stop` disconnects apps. Config changes require a restart; see [Service configuration](https://callstackincubator.github.io/appduct/reference/cli/#background-service-state-dirconfigjson).

## Learn more

- [CLI guide](https://callstackincubator.github.io/appduct/guides/cli/): devices, events and scripting
- [CLI reference](https://callstackincubator.github.io/appduct/reference/cli/): commands, configuration, MCP tools and client API
- SDKs: [iOS](https://callstackincubator.github.io/appduct/install/ios/), [Android](https://callstackincubator.github.io/appduct/install/android/), [React Native](https://callstackincubator.github.io/appduct/install/react-native/), [Flutter](https://callstackincubator.github.io/appduct/install/flutter/), [Web](https://callstackincubator.github.io/appduct/install/web/)
- [Build variants](https://callstackincubator.github.io/appduct/guides/build-variants/): inclusion and artifact checks

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE).

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
