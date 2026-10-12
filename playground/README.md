<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct playground for React Native

An Expo app that registers five demo tools and an event through `@appduct/react-native`. Run it to try calling app functions from the CLI or an agent before adding Appduct to your own app.

## Requirements

- Node 24 and pnpm 11, plus Xcode for iOS or the Android SDK for Android.
- An Expo development build; Expo Go doesn't run Appduct's native module.

## Getting started

From the repository root, install dependencies and build the packages:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Run the app from `playground`:

```bash
cd playground
pnpm exec expo run:ios
# or: pnpm exec expo run:android
```

In another terminal, from the repository root, connect to the running app:

```bash
pnpm playground:appduct -- sessions link --open ios-sim
# or: pnpm playground:appduct -- sessions link --open android
```

The script runs this checkout's CLI from the playground directory, where the scheme and app ids are already recorded. The Status screen shows `active` after connecting.

## Try the tools

The app registers `sum`, `call_count`, `reset_counter`, `slow_task` and `throwing_tool`, plus the `playground_ping` event. After connecting:

```bash
pnpm playground:appduct -- tools ls
pnpm playground:appduct -- tools call sum --input '{"a":2,"b":3}'
pnpm playground:appduct -- tools call call_count --input '{}'
pnpm playground:appduct -- events ls
pnpm playground:appduct -- events tail --follow
```

`sum` returns `{"total":5}`. Open the Status screen and press **Send playground_ping** to see an event in the terminal. See the [playground contract](../docs/internal/playground-contract.md) for all tool names, groups and screen identifiers.

## Things to know

- **Try a reload.** Press `r` in Metro with an active session. The session resumes with the same alias. Killing the native app requires a new link.
- **Use QR for a physical device.** Run `pnpm playground:appduct -- sessions link --qr`; the device must be on the same local network as your computer.
- **Debug includes Appduct.** For internal release builds or JavaScript stripping, see [Build variants](https://callstackincubator.github.io/appduct/guides/build-variants/).
- **This example targets iOS and Android.** For a browser example, use the [Web playground](../playground-web/README.md). The SDK also supports [Web builds](https://callstackincubator.github.io/appduct/install/react-native/).

## Learn more

- [React Native SDK](../packages/react-native/README.md)
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/)
- [Device E2E suite](../e2e-device/README.md)

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE). Made at [Callstack](https://callstack.com/).
