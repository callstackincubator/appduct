# Cordierite native playground (Android)

A plain Jetpack Compose app that exercises `packages/native/android`'s `Cordierite` facade with
no React Native anywhere in the stack -- the Android counterpart to `playground/`'s Expo app
(docs/tasks/19-android-entry-points.md, GitHub issue #48 phase 3). It registers the same five
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
      java/com/callstackincubator/cordierite/playground/
        PlaygroundApplication.kt   registers tools in Application.onCreate()
        PlaygroundState.kt         Compose-observable connection state / event log
        MainActivity.kt            the one screen
```

This is **not** a published-artifact consumer: `settings.gradle`'s `includeBuild` substitutes
`com.callstackincubator.cordierite:core`/`:core-noop` with the local Gradle projects from
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
./gradlew :app:assembleDebug           # debugImplementation(core) -- the real Cordierite core
./gradlew :app:assembleRelease         # releaseImplementation(core-noop) -- inert, no network code
```

Verify the split against the built artifacts (from the repo root, with the workspace's own
`cordierite` build -- see the note below about `pnpm exec` picking up a stale global install
instead):

```bash
node packages/cordierite/dist/bin.js doctor \
  playground-native/android/app/build/outputs/apk/debug/app-debug.apk --assert-present

node packages/cordierite/dist/bin.js doctor \
  playground-native/android/app/build/outputs/apk/release/app-release-unsigned.apk --assert-absent
```

Install and run on a booted emulator or device:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.callstackincubator.cordierite.playground/.MainActivity
```

Then drive it from the `cordierite` CLI, pointed at a daemon whose state directory this build's
scheme can reach (see `packages/native/android/README.md`'s live-check section for the full
sequence):

```bash
cordierite link --open android --scheme cordierite-native
cordierite tools
cordierite invoke sum --input '{"a":2,"b":3}'
cordierite events
```

## `pnpm exec cordierite` can resolve the wrong binary

If this machine also has `cordierite` installed globally (`npm install -g cordierite`, or a shell
plugin manager's fnm/nvm shim), `pnpm exec cordierite ...` can silently run that global install
instead of this workspace's own build -- `pnpm exec` falls back to `PATH` resolution when it
finds no locally-linked binary, and a global install is still on `PATH`. This surfaced during this
task's own verification: `pnpm exec cordierite doctor <release apk> --assert-absent` failed with a
stale global build's detection logic, while `node packages/cordierite/dist/bin.js doctor ... `
correctly held. Prefer invoking the workspace build directly
(`node packages/cordierite/dist/bin.js ...`) when the two might disagree, or confirm first with
`pnpm exec which cordierite` / `pnpm exec node -e "console.log(require.resolve('cordierite/package.json'))"`.
