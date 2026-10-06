# Appduct native playground (Android)

A plain Jetpack Compose app that exercises `packages/native/android`'s `Appduct` facade with
no React Native anywhere in the stack -- the Android counterpart to `playground/`'s Expo app.
It registers the same five
tools the Expo playground does (`sum`, `call_count`, `reset_counter`, `slow_task`,
`throwing_tool`), shows the current connection state/session/call count, logs recent
state/session/error events, and has a button that posts an app event.

## Layout

```
playground-native/android/
  settings.gradle   includeBuild("../../packages/native/android") with dependency substitution
  build.gradle       root build script (AGP/Kotlin versions match packages/native/android's)
  app/
    build.gradle     debugImplementation(core) / releaseImplementation(core-noop)
    src/main/
      AndroidManifest.xml
      java/com/callstack/appduct/playground/
        PlaygroundApplication.kt   registers tools in Application.onCreate()
        PlaygroundState.kt         Compose-observable connection state / event log
        MainActivity.kt            the one screen
```

This is **not** a published-artifact consumer: `settings.gradle`'s `includeBuild` substitutes
`com.callstack.appduct:core`/`:core-noop` with the local Gradle projects from
`packages/native/android`, so the playground always builds against whatever is in this worktree,
with no publish-then-consume round trip. A real consumer app instead depends on the published
Maven coordinates -- see `packages/native/android/README.md`.

## Requirements

Java 17, the Android SDK (`ANDROID_HOME`), and `packages/native/android`'s own Gradle wrapper
distribution (this project's `gradle/wrapper` is a copy of that one, kept in sync by hand since
the two are not otherwise linked).

## Commands

From this directory:

```bash
./gradlew :app:assembleDebug           # debugImplementation(core) -- the real Appduct core
./gradlew :app:assembleRelease         # releaseImplementation(core-noop) -- inert, no network code
```

Verify the split against the built artifacts, from the repo root, with the workspace's own
`appduct` build (see the note at the end):

```bash
node packages/appduct/dist/bin.js doctor \
  playground-native/android/app/build/outputs/apk/debug/app-debug.apk --assert-present

node packages/appduct/dist/bin.js doctor \
  playground-native/android/app/build/outputs/apk/release/app-release-unsigned.apk --assert-absent
```

Install and run on a booted emulator or device:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.callstack.appduct.playground/.MainActivity
```

Then drive it from the `appduct` CLI. Run these from inside `playground-native/`, where
`.appduct/config.json` records the app's scheme and app id, so no `--scheme` or `--app-id` is
needed:

```bash
appduct sessions link --open android
appduct tools ls
appduct tools call sum --input '{"a":2,"b":3}'
appduct events tail
```

## Use the workspace's own `appduct` build

If `appduct` is also installed globally, `pnpm exec appduct` can run that global copy instead of
this workspace's build. Run `node packages/appduct/dist/bin.js ...` from the repo root when the
two might differ, or check which one runs with `pnpm exec which appduct`.
