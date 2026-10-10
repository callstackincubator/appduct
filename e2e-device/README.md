# Device e2e suite

Drives a playground app on an iOS simulator or Android emulator. agent-device presses and reads the
screen; `appduct/client`, the CLI and the MCP server assert on the daemon side. One file per case,
run serially against one device. The playgrounds follow the contract in #227; the cases read only
its ids.

```bash
pnpm build                                     # the suite runs this checkout's CLI
APPDUCT_E2E_TARGET=expo-ios pnpm e2e:device    # build, install, run every case that applies
APPDUCT_E2E_TARGET=expo-ios pnpm e2e:device -- cases/app-killed.device.test.ts   # one case
```

| Variable | Meaning |
| --- | --- |
| `APPDUCT_E2E_TARGET` | Required. `expo-ios`, `expo-android`, `native-ios`, `native-android`, `flutter-ios` or `flutter-android`. |
| `APPDUCT_E2E_DEVICE` | Simulator udid or emulator serial. Default: the first iPhone on the newest iOS runtime, or the one running emulator. |
| `APPDUCT_E2E_SKIP_BUILD=1` | Install the last build instead of building again. |
| `APPDUCT_E2E_RELEASE=1` | Also run `release-opt-in`, which builds the opted-in release variant (`expo-android`, `flutter-android`). |

Needs agent-device's prerequisites (Xcode, or the Android SDK with `ANDROID_HOME` set and an
emulator already running), `flutter` on `PATH` for the Flutter targets, and `xcodegen` for
`native-ios`. An Expo target starts
its own Metro on port 8081 and refuses to run when something already listens there.

Each case file gets its own daemon in a fresh state dir. Build, Metro and `flutter run` output lands
in `e2e-device/.artifacts/`.

## Cases

| File | Proves | Targets |
| --- | --- | --- |
| `cold-link` | a link launches the stopped app into an active session that reports the real device | all |
| `warm-link` | a second link replaces the session and suspends the first | all |
| `tools-round-trip` | the five tools match the contract, and the counter on screen follows them | all |
| `ui-event` | a press on the ping button reaches `waitForEvent` | all |
| `status-deep-link` | `<scheme>:///status` opens Status and leaves the session active | all but `native-android` |
| `background-resume` | home suspends as `app_backgrounded`, and reopening resumes the same session | all |
| `js-reload` | a Metro reload or hot restart resumes the same session with fresh state | Expo, Flutter |
| `reload-in-flight` | a call running during the reload fails at once with `session_suspended` | Expo |
| `app-killed` | a killed app relaunched without a link stays idle; a new link connects | all |
| `release-opt-in` | an opted-in release build connects | `expo-android`, `flutter-android` |

## Rules for a new case

- No fixed sleeps. Wait on a condition with a deadline (`until`, `waitForText`, `waitForSessionState`).
- Prove a negative ("stays idle") only after a positive state shows on screen.
- Always pass the session id. Suspended sessions from earlier in the file stay listed for 600 s.
- A case that passes only on a rerun is a flake. Report it; never add a retry.
