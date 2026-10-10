---
name: e2e-device
description: Build and run a playground app on an iOS simulator or Android emulator, connect it to this repo's Appduct daemon and run the device suite in e2e-device/ against it, plus the calls that prove a specific change works. Use when a PR needs device E2E evidence, when asked to test on a simulator, or when a work-issue orchestrator delegates E2E.
model: sonnet
effort: low
context: fork
---

# E2E on a device

You produce evidence, you do not fix things. If something fails, report it precisely and stop.

Read the `e2e-device` section of `.agents/memory/LESSONS.md` before starting, plus General.

## Which targets

Pick from the paths the PR changes. Run every row that matches.

| Changed path | Target | Suite target |
| --- | --- | --- |
| anything (always) | Expo playground on iOS simulator | `expo-ios` |
| `packages/react-native/android/**`, `packages/native/android/**`, `playground/android/**` | Expo playground on Android emulator | `expo-android` |
| `packages/native/ios/**` | `playground-native/ios` on iOS simulator | `native-ios` |
| `packages/native/android/**` | `playground-native/android` on Android emulator | `native-android` |
| `packages/flutter/ios/**`, `packages/flutter/darwin/**`, `packages/flutter/lib/**`, `playground-flutter/**` | `playground-flutter` on iOS simulator | `flutter-ios` |
| `packages/flutter/android/**`, `packages/flutter/lib/**`, `playground-flutter/android/**` | `playground-flutter` on Android emulator | `flutter-android` |
| `packages/flutter/**` and the PR names L3, L4, L5 or C5 | the device checks in "Flutter device checks"; L5 and C5 on iOS need a physical iPhone | none |
| `packages/appduct/**`, `packages/shared/**` only | iOS row only | `expo-ios` |

## Run the suite

For every suite target picked above, from the repo root after `pnpm build`:

```bash
APPDUCT_E2E_TARGET=<suite target> pnpm e2e:device
```

The suite boots the device, builds and installs the playground, starts Metro for Expo, gives each
case its own daemon, and runs the cases listed in `e2e-device/README.md`: cold and warm links, the
five tools, a UI event, the status deep link, background and resume, reloads, and a killed app. A
pass is every case passed or skipped with a reason. Add `APPDUCT_E2E_RELEASE=1` on `expo-android`
or `flutter-android` when the PR touches release builds. On a failure, report the case, the
assertion, and the log in `e2e-device/.artifacts/`.

The manual setup sections below are for feature evidence and the remaining Flutter checks, which
need a connected app outside the suite.

## Three traps

- **Metro.** `expo run:ios` and `expo run:android` start Metro in the foreground and never
  return, so a run that "waits for the build" is actually waiting on Metro. Start Metro
  yourself in the background and pass `--no-bundler`.
- **`expo run:ios`.** It can build the app and then hang at install until the tool times out.
  Do not use it. Build, install and launch in separate steps as below, each under `timeout`.
- **The shared daemon.** The daemon in `~/.appduct` may be running another branch's code and
  will answer for this one. Always run against a state dir of your own.

If any command here hangs or errors, run it with `--help` before improvising.

## Set up, every target

```bash
export LANG=en_US.UTF-8                                   # `pod install` fails without it
export APPDUCT_STATE_DIR=/tmp/appduct-e2e-$$              # this branch's daemon, not the shared one
mkdir -p "$APPDUCT_STATE_DIR" && echo '{"wssPort": 0}' > "$APPDUCT_STATE_DIR/config.json"   # 0 picks a free port
pnpm install --frozen-lockfile && pnpm build              # repo root; builds the CLI and SDK
```

Shell state does not carry over between commands, so write the state dir's path down and
export both variables again in every command that runs the CLI or a build.

## iOS, Expo playground

```bash
udid=$(xcrun simctl list devices available -j | jq -r '[.devices[][] | select(.name | startswith("iPhone"))][0].udid')
xcrun simctl boot "$udid" 2>/dev/null || true
timeout 120 xcrun simctl bootstatus "$udid" -b
cd playground
[ -d ios ] || pnpm exec expo prebuild --platform ios      # generates ios/ and runs `pod install`
pnpm exec expo start --dev-client --port 8081 > /tmp/metro.log 2>&1 &
timeout 900 xcodebuild -workspace ios/playground.xcworkspace -scheme playground -configuration Debug \
  -sdk iphonesimulator -destination "id=$udid" -derivedDataPath ios/build build | tail -3   # about 2 min warm
timeout 120 xcrun simctl install "$udid" ios/build/Build/Products/Debug-iphonesimulator/playground.app
xcrun simctl openurl "$udid" "playground://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"   # launches into Metro, no tapping
cd ..
```

If `simctl install` times out, shut the simulator down, boot it again and repeat the install.

Connect and wait until the session is active:

```bash
pnpm playground:appduct -- sessions link --open ios-sim --device "$udid"
until pnpm playground:appduct -- sessions ls --json | jq -e '.data[] | select(.state=="active")' >/dev/null; do sleep 2; done
```

## Android, Expo playground

```bash
emulator -list-avds                                       # pick one
emulator -avd <name> -no-snapshot-load > /tmp/emulator.log 2>&1 &
adb wait-for-device
cd playground
pnpm exec expo start --dev-client --port 8081 > /tmp/metro.log 2>&1 &
timeout 900 pnpm exec expo run:android --no-bundler
cd ..
pnpm playground:appduct -- sessions link --open android   # app id comes from playground/.appduct/config.json
```

## Native playgrounds

Follow `playground-native/ios/README.md` (xcodegen, xcodebuild, `simctl install` and
`launch`) and `playground-native/android/README.md`. They register the same five tools and the
`playground_ping` event. Run the CLI from that playground's directory so the scheme
is discovered, or pass `--scheme`.

## Flutter playground

`playground-flutter` is a Flutter app (Android, iOS, macOS) that depends on `packages/flutter` by
path and registers the same five tools and the `playground_ping` event. Its scheme is
`appduct-flutter`; the ids are `com.callstack.appduct.playgroundFlutter` (iOS) and
`com.callstack.appduct.playground_flutter` (Android), recorded in `playground-flutter/.appduct/config.json`.
Drive it with `pnpm playground-flutter:appduct -- <cli args>`.

`flutter run` stays in the foreground like Metro, so build, install and launch in separate steps
and start `flutter run` only where a check needs a hot restart.

```bash
cd playground-flutter && flutter pub get && cd ..
```

iOS simulator (boot `$udid` as in the Expo section):

```bash
cd playground-flutter
timeout 900 flutter build ios --simulator --debug
timeout 120 xcrun simctl install "$udid" build/ios/iphonesimulator/Runner.app
xcrun simctl launch "$udid" com.callstack.appduct.playgroundFlutter
cd ..
pnpm playground-flutter:appduct -- sessions link --open ios-sim --device "$udid"
until pnpm playground-flutter:appduct -- sessions ls --json | jq -e '.data[] | select(.state=="active")' >/dev/null; do sleep 2; done
```

Android emulator (start it as in the Expo section):

```bash
cd playground-flutter
timeout 900 flutter build apk --debug
adb install -r build/app/outputs/flutter-apk/app-debug.apk
adb shell am start -n com.callstack.appduct.playground_flutter/.MainActivity
cd ..
pnpm playground-flutter:appduct -- sessions link --open android
```

The app registers its tools before the first frame, so `tools ls` lists all five as soon as the
session is active.

## Flutter device checks

Run the ones the PR names. Every command uses `a="pnpm playground-flutter:appduct --"`, your state
dir exported, and the app built and connected as above. Record each as command and output.

A replaced or reinstalled session stays in `sessions ls` as `suspended` for 600 s, so never take
`.data[0]` and never call a tool without a selector (it fails with `ambiguous_session`). Pick the
active session and pass its id as the selector:

```bash
active() { $a sessions ls --json | jq -r '[.data[] | select(.state=="active")][0].sessionId // empty'; }
until id=$(active) && [ -n "$id" ]; do sleep 2; done
```

T6 (device names), L1 (a link leaves the route alone), R2 and R3 (hot restart) and L4's UIScene
runs are cases in the suite: `cold-link`, `warm-link`, `js-reload`, `reload-in-flight` and
`status-deep-link`.

**L3, links through the shim with Flutter deep linking off (Android).** In
`playground-flutter/android/app/src/main/AndroidManifest.xml` add
`<meta-data android:name="flutter_deeplinking_enabled" android:value="false"/>` inside `<activity>`,
rebuild and install, then:

- Cold start: `adb shell am force-stop com.callstack.appduct.playground_flutter`, then
  `$a sessions link --open android`. The app launches and the session becomes active.
- Warm start: with the app in the foreground, run `$a sessions link --open android` again. A new
  active session replaces the first.

Restore the manifest afterwards with `git checkout -- playground-flutter/android`.

**L4, iOS links under the app delegate, cold and warm.** The suite covers the UIScene template as
checked in; this check covers an app with no scene manifest.

- Cold: `xcrun simctl terminate "$udid" com.callstack.appduct.playgroundFlutter`, then
  `$a sessions link --open ios-sim --device "$udid"`; the app launches and a session becomes
  active. Warm: with the app running, deliver another link; the session is replaced and active.
- Set up the app delegate only: Remove the scene manifest and rebuild:
  `/usr/libexec/PlistBuddy -c "Delete :UIApplicationSceneManifest" playground-flutter/ios/Runner/Info.plist`,
  then build and install as above and repeat the cold and warm deliveries. Restore with
  `git checkout -- playground-flutter/ios`.
- A URL that is not an Appduct link reaches the router:
  `xcrun simctl openurl "$udid" "appduct-flutter:///status"` shows the Status tab (screenshot) and
  the existing session stays active.

**L5, profile build on a physical iPhone with no debugger.** Needs a paired iPhone `$dev`
(`xcrun devicectl list devices`), a signing team set once in
`playground-flutter/ios/Runner.xcworkspace`, and the iPhone on the same network as the daemon.

```bash
cd playground-flutter
timeout 1200 flutter build ios --profile
xcrun devicectl device install app --device "$dev" build/ios/iphoneos/Runner.app
cd ..
$a sessions link --open ios-device --device "$dev" --app-id com.callstack.appduct.playgroundFlutter --relaunch
```

Do not run `flutter run`, `flutter attach` or open Xcode's debugger: the app must be launched by
the link alone. An active session that answers `sum` is the pass. The first launch asks for
the local network permission; allow it.

**C5, an opted-in release build connects with the permissions `appduct init` prints.** Build with
`--dart-define=APPDUCT_ENABLED=true`:

- Android: `flutter build apk --release --dart-define=APPDUCT_ENABLED=true`, install
  `build/app/outputs/flutter-apk/app-release.apk` on the emulator, launch, `$a sessions link --open android`.
- iOS (physical iPhone only, Flutter has no release simulator build):
  `flutter build ios --release --dart-define=APPDUCT_ENABLED=true`, install and link as in L5.
- macOS: `flutter build macos --release --dart-define=APPDUCT_ENABLED=true`, then
  `open -n build/macos/Build/Products/Release/playground_flutter.app` and
  `open "$($a sessions link --json | jq -r '.data.deepLink')"`.

Each connects and answers `$a tools call "$id" sum --input '{"a":1,"b":2}'` with a total of 3. Without the define, the same release build must not
connect (`node packages/appduct/bin.js doctor <artifact> --assert-absent`, from the repo root).

## Flakes

A case or step that fails and passes on one immediate rerun is a flake: report it as "flaky" with
the case, do not rerun a third time, and file it with `file-issue` if no issue exists.

## Feature evidence

Then the one to three CLI or MCP calls that exercise the change under test. Read the PR's
criteria table and pick the ones a device can observe. Capture command and output verbatim.

## Record

Fill the PR's "E2E evidence" section:

```bash
gh pr edit <N> --body-file <updated body>
```

```
### E2E evidence
Target: iOS simulator (iPhone 17, iOS 26), Expo playground, commit <sha>
Suite: 9 passed, 1 skipped (release-opt-in: APPDUCT_E2E_RELEASE unset)
Feature:
$ pnpm playground:appduct -- tools call <tool> --input '{...}'
<output>
```

Shut down what you started (the suite stops its own Metro and daemons): kill any Metro you started, `pnpm playground:appduct -- daemon stop` with your
state dir still exported, `xcrun simctl shutdown "$udid"` or `adb emu kill`.

## Report

```
Target(s): <list>  Commit: <sha>
Suite: pass | fail (<which case>)
Feature: pass | fail (<what differed>)
Evidence: recorded in PR #N | not recorded (<why>)
```
