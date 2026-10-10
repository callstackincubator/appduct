# Playground contract

The playgrounds are the apps the device e2e suite drives. They must look the same to a script, so
each one implements this contract, and a test written against one runs on the others.

| Playground | Directory | Scheme | Tools and event | Screens and ids | `/status` link |
| --- | --- | --- | --- | --- | --- |
| Expo | `playground` | `playground` | yes | yes | yes |
| iOS native | `playground-native/ios` | `appduct-native` | yes | yes | yes |
| Android native | `playground-native/android` | `appduct-native` | yes | yes | no, see below |
| Flutter | `playground-flutter` | `appduct-flutter` | yes | yes, except two ids, see below | yes |
| web | `playground-web` | none | yes | no (the page keeps its `#count` and `#ping` ids) | no |

Schemes, bundle ids, application ids and each app's `.appduct/config.json` do not change with the
contract.

## Tools

Identical on every playground. The descriptions are the Expo app's.

| Tool | Group | Annotations | Input | Output | Behaviour |
| --- | --- | --- | --- | --- | --- |
| `sum` | none | none | `{a: number, b: number}`, both required | `{total: number}` | `a + b` as numbers (1.5 + 2 = 3.5); counts as a call |
| `call_count` | `counter` | readOnly | `{}` | `{count: number}` | current count |
| `reset_counter` | `counter` | destructive, idempotent | `{}` | `{count: number}` | sets the count to 0 |
| `slow_task` | `diagnostics/progress` | none; `timeoutMs` 5000 | `{}` | `{done: boolean}` | reports progress 0.33 "warming up", 0.66 "almost there", 1 "done", 500 ms apart; counts as a call after the last report |
| `throwing_tool` | `diagnostics` | readOnly | `{}` | none | fails with `tool_execution_error`, message exactly `throwing_tool always fails on purpose.` |

Descriptions, word for word:

- `sum`: `Adds two numbers. Counts as a call in call_count.`
- `call_count`: `Reports how many times the counted tools (sum, slow_task) have run. Read-only.`
- `reset_counter`: `Resets the call counter to zero. Destructive; a no-op when it is already zero.`
- `slow_task`: `Takes about 1.5 s and reports progress along the way. Counts as a call in call_count.`
- `throwing_tool`: `Always fails with tool_execution_error. Changes nothing.`

Fixing the error text is the playground's job, not the SDK's: Flutter's `throwing_tool` throws its
own exception type whose `toString()` is the message, so the SDK's error formatting stays as it is.

## Event

Declared at startup, before any link, so `events ls` lists it from the first launch.

- Name: `playground_ping`
- Description: `The Send playground_ping button on the Status screen was pressed.`
- Payload: `{at: number}`, `at` required (milliseconds since the epoch)

## Screens

Two screens, Tools and Status, switched by a tab bar. Each element below carries its id as
`testID` (React Native), `.accessibilityIdentifier` (SwiftUI), `Modifier.testTag` with
`testTagsAsResourceId = true` on the root (Compose) or `Semantics(identifier:)` (Flutter). The
element with the id holds only the value; its label is a separate element.

| Id | Screen | Value as read through accessibility |
| --- | --- | --- |
| `tab-tools`, `tab-status` | tab bar | pressable |
| `call-count` | Tools | the bare integer, `0` at launch |
| `connection-state` | Status | `idle`, `connecting`, `active`, `reconnecting` or `closed`, lowercase |
| `ping-button` | Status | posts `playground_ping` with `at` = now in epoch ms |
| `last-ping` | Status | the `at` of the last ping sent, or `none` |

Status shows the current `connection-state` as soon as it appears, not only after the next change:
a screen that mounts lazily reads the state synchronously on mount. Every element with an id is
visible without scrolling on an iPhone 17 Pro or a Pixel 8, since agent-device's snapshot leaves
out off-screen elements.

Extra UI (quick-start text, activity logs, Expo's build config and error feed) may stay, but must
not use these ids.

## Deep link

`<scheme>:///status` opens the Status screen and leaves an active session active. The Appduct
entry point ignores a link that is not an Appduct link, so the app routes it itself: Expo Router
and go_router match the path, and the iOS app opens Status for `/status` when
`Appduct.shared.handle` returns `false`.

## Known gaps

- **Android native has no `/status` link.** The core's `AppductLinkActivity` finishes on any
  non-Appduct link (`AppductLinkActivity.kt`), and changing that is an SDK decision.
## Checking a playground

- Unit: `playground/__tests__/playground-contract.test.ts` registers the Expo and web tools on a
  real client over a fake core (`pnpm --filter playground test`).
  `playground-flutter/test/playground_tools_test.dart` does the same for Flutter and also reads the
  ids through the semantics tree (`flutter test`).
- Device: the `e2e-device` skill reads the ids with agent-device and compares `tools ls --json`
  and `events ls` across the playgrounds. The two native apps have no unit tests; the device
  pass is their check.
