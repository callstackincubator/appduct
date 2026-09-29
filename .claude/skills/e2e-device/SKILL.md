---
name: e2e-device
description: Build and run a playground app on an iOS simulator or Android emulator, connect it to this repo's Appduct daemon and drive it through the CLI - a smoke pass over the five demo tools plus the calls that prove a specific change works. Use when a PR needs device E2E evidence, when asked to test on a simulator, or when a work-issue orchestrator delegates E2E.
model: sonnet
effort: low
context: fork
---

# E2E on a device

You produce evidence, you do not fix things. If something fails, report it precisely and stop.

Read the `e2e-device` section of `.agents/memory/LESSONS.md` before starting, plus General.

## Which targets

Pick from the paths the PR changes. Run every row that matches.

| Changed path | Target |
| --- | --- |
| anything (always) | Expo playground on iOS simulator |
| `packages/react-native/android/**`, `packages/native/android/**`, `playground/android/**` | Expo playground on Android emulator |
| `packages/native/ios/**` | `playground-native/ios` on iOS simulator |
| `packages/native/android/**` | `playground-native/android` on Android emulator |
| `packages/appduct/**`, `packages/shared/**` only | iOS row only |

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
`launch`) and `playground-native/android/README.md`. They register the same five tools, so
the smoke pass below is identical. Run the CLI from that playground's directory so the scheme
is discovered, or pass `--scheme`.

## Smoke pass

All five tools, one chain. Expected values are on the right.

```bash
a="pnpm playground:appduct --"
$a tools call reset_counter --input '{}' --json | jq -e '.data.count == 0' \
&& $a tools call sum --input '{"a":1,"b":2}' --json | jq -e '.data.total == 3' \
&& $a tools call call_count --input '{}' --json | jq -e '.data.count == 1' \
&& $a tools call slow_task --input '{}' --json | jq -e '.data.done == true' \
&& $a tools call call_count --input '{}' --json | jq -e '.data.count == 2' \
&& echo SMOKE_OK
$a tools call throwing_tool --input '{}' --json; echo "exit=$? (non-zero expected, type tool_execution_error)"
```

A checked-in script for this pass is planned; until it exists, this chain is the suite.

A step that fails and passes on one immediate rerun is a flake: report it as "flaky" with the
step, do not rerun a third time, and file it with `file-issue` if no issue exists.

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
Smoke: SMOKE_OK
Feature:
$ pnpm playground:appduct -- tools call <tool> --input '{...}'
<output>
```

Shut down what you started: kill Metro, `pnpm playground:appduct -- daemon stop` with your
state dir still exported, `xcrun simctl shutdown "$udid"` or `adb emu kill`.

## Report

```
Target(s): <list>  Commit: <sha>
Smoke: pass | fail (<which step>)
Feature: pass | fail (<what differed>)
Evidence: recorded in PR #N | not recorded (<why>)
```
