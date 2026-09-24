# Appduct Playground (native iOS)

A plain SwiftUI app -- no React Native, no Expo -- that consumes `AppductCore`
(`packages/native/ios`) directly through the `Appduct` facade
(`packages/native/ios/Sources/AppductCore/Real/AppductAPI.swift`). It registers the same five
tools the Expo playground (`playground/`) registers, so `appduct tools ls` reports an equivalent
surface regardless of which playground app answered the link.

See [`packages/native/ios/README.md`](../../packages/native/ios/README.md) for the SDK itself;
[`docs/tasks/18-ios-entry-points.md`](../../docs/tasks/18-ios-entry-points.md) for why this app is
built the way it is.

## Run it

Three commands, from this directory (`playground-native/ios`):

```bash
# 1. Generate the Xcode project from project.yml (installs xcodegen with brew if you don't have it).
#    Re-run this after editing project.yml; the .xcodeproj itself is gitignored.
brew install xcodegen  # once, if you don't already have it
xcodegen generate

# 2. Build and run on a booted simulator (swap the destination for whatever
#    `xcrun simctl list devices available` shows on your machine).
xcodebuild build -project AppductPlayground.xcodeproj -scheme AppductPlayground \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO
xcrun simctl install booted \
  ~/Library/Developer/Xcode/DerivedData/AppductPlayground-*/Build/Products/Debug-iphonesimulator/AppductPlayground.app
xcrun simctl launch booted com.callstack.appduct.playgroundnative

# 3. Point the CLI at it. playground-native/.appduct/config.json records the app's
#    `appduct-native` URL scheme, so no --scheme is needed.
appduct sessions link --open ios-sim
appduct tools ls
appduct tools call sum --input '{"a":2,"b":3}'
```

Opening the project in Xcode (`open AppductPlayground.xcodeproj`) and hitting Run works exactly
the same way; the three commands above are just the scriptable/CI-friendly equivalent.

## Why xcodegen

The `.xcodeproj` is generated from `project.yml` rather than committed, so there is one source of
truth for the target's settings (matching how `packages/native/ios`'s own `Package.swift` is the
single source of truth for the Swift package) and no `.pbxproj` merge conflicts. `project.yml`
declares a local SwiftPM dependency on the repo-root `Package.swift`
(`packages: { AppductCore: { path: ../../ } }`), so this app always builds against the worktree's
own `AppductCore` sources -- there is nothing to vendor or publish first.

## Debug ships the real core, Release ships the stub

This target sets no `APPDUCT_ENABLED` define of its own. Xcode passes the configuration name
straight through to SwiftPM, and `Package.swift`'s `.when(configuration: .debug)` does the rest
(Decision 2, [`docs/tasks/14-native-core-extraction.md`](../../docs/tasks/14-native-core-extraction.md)):
a `Debug` build links the real `AppductCore` implementation, a `Release` build links the
same-API `Stub/` implementation, and neither configuration needed a build setting naming
`APPDUCT_ENABLED` explicitly. Verify this against the built artifact rather than trusting the
build log:

```bash
appduct doctor path/to/Debug-iphonesimulator/AppductPlayground.app --assert-present
appduct doctor path/to/Release-iphonesimulator/AppductPlayground.app --assert-absent
```

## Layout

- `project.yml` -- the xcodegen project spec (targets, settings, the local package dependency).
- `AppductPlayground/AppductPlaygroundApp.swift` -- the `@main` entry point:
  `PlaygroundTools.registerAll()` at startup, `.onOpenURL { Appduct.shared.handle($0) }` on the
  root scene.
- `AppductPlayground/PlaygroundTools.swift` -- registers `sum`, `call_count`, `reset_counter`,
  `slow_task`, `throwing_tool` -- the same names/descriptions/schemas
  `playground/app/(tabs)/index.tsx` registers on the Expo side.
- `AppductPlayground/PlaygroundViewModel.swift` -- the `@MainActor` observable store backing the
  UI: call counter, connection state/session id (via `Appduct.shared.addListener`), and a short
  rolling activity log.
- `AppductPlayground/ContentView.swift` -- the single screen: connection state, call counter, a
  button that calls `Appduct.shared.postEvent(...)`, and the activity log.
- `AppductPlayground/Info.plist` -- declares the `appduct-native` URL scheme
  (`CFBundleURLTypes`). No `AppductTrust`/`AppductCliPins` keys: this playground is the
  zero-config example, so it trusts whatever pin `appduct sessions link` puts on the deep link for that
  session (`trust: "link"`) -- see [`docs/SECURITY.md`](../../docs/SECURITY.md#trust-modes).
