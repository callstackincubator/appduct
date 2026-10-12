<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct playground for Flutter

A Flutter app for Android, iOS and macOS that registers five demo tools and an event through the local `appduct` plugin. It uses the same tools and screens as the other playgrounds and receives links through go_router.

## Requirements

- Flutter 3.38 or newer, plus the toolchain for your target platform.
- Node 24 and pnpm 11 to build this checkout's CLI.

## Getting started

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
cd playground-flutter
flutter pub get
flutter run -d <device>
```

In another terminal, from the repository root, connect to the running app:

```bash
pnpm playground-flutter:appduct -- sessions link --open android
# or: pnpm playground-flutter:appduct -- sessions link --open ios-sim
```

The script uses this checkout's CLI. The scheme, app ids and required platform permissions are already configured. For macOS, follow [Connect a desktop app](https://callstackincubator.github.io/appduct/install/flutter/#connect-a-desktop-app) using the scheme `appduct-flutter`.

## Try the tools

The app registers `sum`, `call_count`, `reset_counter`, `slow_task` and `throwing_tool`, plus the `playground_ping` event. After connecting:

```bash
pnpm playground-flutter:appduct -- tools ls
pnpm playground-flutter:appduct -- tools call sum --input '{"a":2,"b":3}'
pnpm playground-flutter:appduct -- tools call call_count --input '{}'
pnpm playground-flutter:appduct -- events ls
pnpm playground-flutter:appduct -- events tail --follow
```

`sum` returns `{"total":5}`. Open the Status screen and press **Send playground_ping** to see an event in the terminal. See the [playground contract](../docs/internal/playground-contract.md) for all tool names, groups and screen identifiers.

## Things to know

- **Hot restart resumes the session.** Killing the app requires a new link.
- **Debug and profile include Appduct.** Release leaves it out unless you set `--dart-define=APPDUCT_ENABLED=true`; see [Flutter build variants](https://callstackincubator.github.io/appduct/guides/build-variants/#flutter-the-appduct_enabled-define).
- **Run tool tests locally.** From this directory, `flutter test` checks the tools against in-memory fakes. The [device suite](../e2e-device/README.md) exercises the running app.

## Learn more

- [Flutter SDK](../packages/flutter/README.md)
- [Flutter setup](https://callstackincubator.github.io/appduct/install/flutter/)
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/)

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE). Made at [Callstack](https://callstack.com/).
