<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct playground for iOS

A SwiftUI app that registers five demo tools and an event through `AppductCore`. It builds against the SDK in this checkout and uses the same tools and screens as the other playgrounds.

## Requirements

- Xcode 16.3 or newer and an iOS Simulator.
- XcodeGen: `brew install xcodegen`.
- Node 24 and pnpm 11 to build this checkout's CLI.

## Getting started

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
cd playground-native/ios
xcodegen generate
open AppductPlayground.xcodeproj
```

In Xcode, select the **AppductPlayground** scheme and an iOS Simulator, then Run the Debug configuration. Regenerate the project after changing `project.yml`.

In another terminal, from `playground-native`, connect using this checkout's CLI:

```bash
node ../packages/appduct/bin.js sessions link --open ios-sim
```

The scheme is already recorded in `.appduct/config.json`. The Status screen shows `active` after connecting.

## Try the tools

The app registers `sum`, `call_count`, `reset_counter`, `slow_task` and `throwing_tool`, plus the `playground_ping` event. After connecting:

```bash
node ../packages/appduct/bin.js tools ls
node ../packages/appduct/bin.js tools call sum --input '{"a":2,"b":3}'
node ../packages/appduct/bin.js tools call call_count --input '{}'
node ../packages/appduct/bin.js events ls
node ../packages/appduct/bin.js events tail --follow
```

`sum` returns `{"total":5}`. Open the Status screen and press **Send playground_ping** to see an event in the terminal. See the [playground contract](../../docs/internal/playground-contract.md) for all tool names, groups and screen identifiers.

## Things to know

- **Debug includes Appduct; Release uses an inert API.** Check a built app with `appduct doctor <path-to-app> --assert-present` or `--assert-absent`.
- **Short network drops resume the session.** Killing the app requires a new link.
- **The app supports a Status link.** `appduct-native:///status` opens the Status screen.
- **The project is generated.** `project.yml` defines the target and its local SwiftPM dependency. Tool registration is in `AppductPlayground/PlaygroundTools.swift`.

## Learn more

- [iOS SDK](../../packages/native/ios/README.md)
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/)
- [Device E2E suite](../../e2e-device/README.md)

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE). Made at [Callstack](https://callstack.com/).
