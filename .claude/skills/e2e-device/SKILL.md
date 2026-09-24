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

## The Metro trap

`expo run:ios` and `expo run:android` start Metro in the foreground and never return, so a
run that "waits for the build" is actually waiting on Metro. Always pass `--no-bundler` and
start Metro yourself in the background. If any command here hangs or errors, run it with
`--help` before improvising.

## iOS, Expo playground

```bash
pnpm install --frozen-lockfile && pnpm build             # repo root; builds the CLI and SDK
udid=$(xcrun simctl list devices available -j | jq -r '[.devices[][] | select(.name | startswith("iPhone"))][0].udid')
xcrun simctl boot "$udid" 2>/dev/null || true
cd playground
pnpm exec expo start --dev-client --port 8081 > /tmp/metro.log 2>&1 &
pnpm exec expo run:ios --no-bundler --device "$udid"     # builds, installs, launches
cd ..
```

Connect and wait until the session is active:

```bash
pnpm playground:appduct -- link --open ios-sim
until pnpm playground:appduct -- ls --json | jq -e '.data[] | select(.state=="active")' >/dev/null; do sleep 2; done
```

## Android, Expo playground

```bash
emulator -list-avds                                       # pick one
emulator -avd <name> -no-snapshot-load > /tmp/emulator.log 2>&1 &
adb wait-for-device
cd playground
pnpm exec expo start --dev-client --port 8081 > /tmp/metro.log 2>&1 &
pnpm exec expo run:android --no-bundler
cd ..
pnpm playground:appduct -- link --open android            # app id comes from playground/.appduct/config.json
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
$a invoke reset_counter --input '{}' --json | jq -e '.data.count == 0' \
&& $a invoke sum --input '{"a":1,"b":2}' --json | jq -e '.data.total == 3' \
&& $a invoke call_count --input '{}' --json | jq -e '.data.count == 1' \
&& $a invoke slow_task --input '{}' --json | jq -e '.data.done == true' \
&& $a invoke call_count --input '{}' --json | jq -e '.data.count == 2' \
&& echo SMOKE_OK
$a invoke throwing_tool --input '{}' --json; echo "exit=$? (non-zero expected, type tool_execution_error)"
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
$ pnpm playground:appduct -- invoke <tool> --input '{...}'
<output>
```

Shut down what you started: kill Metro, `xcrun simctl shutdown "$udid"` or
`adb emu kill`.

## Report

```
Target(s): <list>  Commit: <sha>
Smoke: pass | fail (<which step>)
Feature: pass | fail (<what differed>)
Evidence: recorded in PR #N | not recorded (<why>)
```
