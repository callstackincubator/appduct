<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct playground for Android

A Jetpack Compose app that registers five demo tools and an event through the native Android SDK. It builds against the SDK in this checkout and uses the same tools and screens as the other playgrounds.

## Requirements

- Java 17, the Android SDK with `ANDROID_HOME` set, and an emulator or USB device.
- Node 24 and pnpm 11 to build this checkout's CLI.

## Getting started

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
cd playground-native/android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.callstack.appduct.playground/.MainActivity
```

From `playground-native`, connect using this checkout's CLI:

```bash
node ../packages/appduct/bin.js sessions link --open android
```

The scheme and app id are already recorded in `.appduct/config.json`. The Status screen shows `active` after connecting.

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

- **Debug includes `core`; Release uses `core-noop`.** Build Release with `./gradlew :app:assembleRelease` from this directory. From the repository root, verify it with `node packages/appduct/bin.js doctor playground-native/android/app/build/outputs/apk/release/app-release-unsigned.apk --assert-absent`.
- **Short network drops resume the session.** Killing the app requires a new link.
- **Use the Tools and Status tabs.** This playground doesn't handle a `/status` navigation link.
- **Dependencies are local.** `settings.gradle` substitutes the published SDK coordinates with `packages/native/android`. Tool registration is in `app/src/main/java/com/callstack/appduct/playground/PlaygroundApplication.kt`.

## Learn more

- [Android SDK](../../packages/native/android/README.md)
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/)
- [Device E2E suite](../../e2e-device/README.md)

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
