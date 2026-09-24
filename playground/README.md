[![Appduct][appduct-banner]][repo]

### Reference app: tools from the CLI—no debug UI

[![MIT license][license-badge]][license] [![PRs Welcome][prs-welcome-badge]][prs-welcome]

The playground is an Expo **development build** that demonstrates Appduct's v2 model: an
always-on **daemon** on your machine, an app that claims a **pinned `wss://`** session from a
bootstrap deep link that carries the daemon's key pin, and a thin **CLI/MCP** surface driving tools registered in JS—no extra debug
screens in the app, same ideas as in **production** builds.

## Why it's here

- **Zero-config path**: no keys or pins to set up. The app trusts the key pin carried by the
  bootstrap link (`trust: "link"`, the default without `cliPins`), and uses the same shared daemon
  in `~/.appduct` as any other app, while tools run from the **CLI** (or an MCP client), not
  in-app menus.
- **Safe local defaults**: `allowPrivateLanOnly` stays enabled while iterating—same knob as
  production, not a statement that Appduct only works offline or on one subnet.
- **Resume smoke test**: the app uses `@appduct/react-native/auto`, so a Metro reload suspends
  and resumes the session automatically with the same alias—no new deep link needed while the
  native app process stays alive.
- **UI sandbox** (Expo Router) with two tabs: **Tools** (registers demo tools, renders the live
  registry) and **Status** (connection state, alias, error feed, and a manual event post).

## Getting started

Everything below runs from the monorepo root unless noted. Use a **development build**, not Expo
Go—this app ships native pinning code.

### 1. Nothing to configure

The deep-link scheme and the app's id on each platform are recorded in `.appduct/config.json`,
so no `--scheme` or `--app-id` flags are needed. The `playground:appduct` script below runs this
repository's own CLI build from the playground directory; the daemon it talks to is the shared
one in `~/.appduct`.

### 2. Build and run the dev client

From the `playground` directory (`expo` is a dependency of this app, not of the monorepo root):

```sh
pnpm exec expo run:ios
# or
pnpm exec expo run:android
```

This also starts Metro. The daemon auto-spawns on first CLI/MCP use—no separate `daemon start`
step required for the smoke test below.

### 3. Bootstrap a session

- **iOS Simulator**: `pnpm run playground:appduct -- sessions link --open ios-sim`
- **Android emulator**: `pnpm run playground:appduct -- sessions link --open android`
- **Physical device**: `pnpm run playground:appduct -- sessions link --qr`, then scan the QR code with the device's camera (it
  must be on the same LAN as the daemon, or `allowPrivateLanOnly` will reject it)

The **Status** tab should flip to `active` with an alias once the app claims the session.

### 4. Drive it from the CLI

```sh
pnpm run playground:appduct -- sessions ls
pnpm run playground:appduct -- tools ls
pnpm run playground:appduct -- tools call sum --input '{"a":1,"b":2}'
pnpm run playground:appduct -- tools call call_count --input '{}'      # reads state a handler closes over
pnpm run playground:appduct -- tools call reset_counter --input '{}'   # destructive; denied if policy.destructive=deny
pnpm run playground:appduct -- tools call slow_task --input '{}'       # watch progress with events tail --follow
pnpm run playground:appduct -- tools call throwing_tool --input '{}'   # exercises tool_execution_error
pnpm run playground:appduct -- events tail --follow
```

Tap **Send playground_ping** on the Status tab while `events tail --follow` is running to see the
`app_event` show up on the stream.

### 5. Try the resume behavior

With a session active, trigger a Metro reload (press `r` in the Metro terminal, or shake the
device and choose Reload). The Status tab should show `reconnecting` then `active` again with the
**same alias**—no new `appduct sessions link` needed. Keep the native app process alive: the resume
lease exists only in native process memory, so killing/relaunching the app requires a new link.
The daemon-side session grace window (`graceSeconds` in `config.json`) starts when the transport
suspends/disconnects.

## Platform compatibility

- **iOS** and **Android** development builds, New Architecture.
- **Web**: Appduct client is a stub; this app is not targeting web sessions.

## Documentation

- [Monorepo README](../README.md)
- [Architecture](../docs/ARCHITECTURE.md)
- [@appduct/react-native](../packages/react-native/README.md)
- [appduct (CLI/daemon/MCP)](../packages/appduct/README.md)

## Authors

Ships with [Appduct][repo] · [Callstack][callstack-readme-with-love].

[appduct-banner]: https://img.shields.io/badge/Appduct-callstack%2Fincubator-111827?style=for-the-badge&logo=github&logoColor=white
[repo]: https://github.com/callstackincubator/appduct
[license-badge]: https://img.shields.io/npm/l/%40appduct%2Freact-native?style=for-the-badge
[license]: https://github.com/callstackincubator/appduct/blob/main/LICENSE
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/callstackincubator/appduct/pulls
[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
