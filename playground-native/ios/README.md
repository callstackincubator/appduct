# Cordierite Playground (native iOS)

A plain SwiftUI app -- no React Native, no Expo -- that consumes `CordieriteCore`
(`packages/native/ios`) directly through the `Cordierite` facade
(`packages/native/ios/Sources/CordieriteCore/Real/CordieriteAPI.swift`). It registers the same five
tools the Expo playground (`playground/`) registers, so `cordierite tools` reports an equivalent
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
xcodebuild build -project CordieritePlayground.xcodeproj -scheme CordieritePlayground \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO
xcrun simctl install booted \
  ~/Library/Developer/Xcode/DerivedData/CordieritePlayground-*/Build/Products/Debug-iphonesimulator/CordieritePlayground.app
xcrun simctl launch booted com.callstackincubator.cordierite.playgroundnative

# 3. Point the CLI at it -- the app registers the `cordierite-native` URL scheme.
cordierite link --scheme cordierite-native --open ios-sim
cordierite tools
cordierite invoke sum --input '{"a":2,"b":3}'
```

Opening the project in Xcode (`open CordieritePlayground.xcodeproj`) and hitting Run works exactly
the same way; the three commands above are just the scriptable/CI-friendly equivalent.

## Why xcodegen

The `.xcodeproj` is generated from `project.yml` rather than committed, so there is one source of
truth for the target's settings (matching how `packages/native/ios`'s own `Package.swift` is the
single source of truth for the Swift package) and no `.pbxproj` merge conflicts. `project.yml`
declares a local SwiftPM dependency on the repo-root `Package.swift`
(`packages: { CordieriteCore: { path: ../../ } }`), so this app always builds against the worktree's
own `CordieriteCore` sources -- there is nothing to vendor or publish first.

## Debug ships the real core, Release ships the stub

This target sets no `CORDIERITE_ENABLED` define of its own. Xcode passes the configuration name
straight through to SwiftPM, and `Package.swift`'s `.when(configuration: .debug)` does the rest
(Decision 2, [`docs/tasks/14-native-core-extraction.md`](../../docs/tasks/14-native-core-extraction.md)):
a `Debug` build links the real `CordieriteCore` implementation, a `Release` build links the
same-API `Stub/` implementation, and neither configuration needed a build setting naming
`CORDIERITE_ENABLED` explicitly. Verify this against the built artifact rather than trusting the
build log:

```bash
cordierite doctor path/to/Debug-iphonesimulator/CordieritePlayground.app --assert-present
cordierite doctor path/to/Release-iphonesimulator/CordieritePlayground.app --assert-absent
```

## Layout

- `project.yml` -- the xcodegen project spec (targets, settings, the local package dependency).
- `CordieritePlayground/CordieritePlaygroundApp.swift` -- the `@main` entry point:
  `PlaygroundTools.registerAll()` at startup, `.onOpenURL { Cordierite.shared.handle($0) }` on the
  root scene.
- `CordieritePlayground/PlaygroundTools.swift` -- registers `sum`, `call_count`, `reset_counter`,
  `slow_task`, `throwing_tool` -- the same names/descriptions/schemas
  `playground/app/(tabs)/index.tsx` registers on the Expo side.
- `CordieritePlayground/PlaygroundViewModel.swift` -- the `@MainActor` observable store backing the
  UI: call counter, connection state/session id (via `Cordierite.shared.addListener`), and a short
  rolling activity log.
- `CordieritePlayground/ContentView.swift` -- the single screen: connection state, call counter, a
  button that calls `Cordierite.shared.postEvent(...)`, and the activity log.
- `CordieritePlayground/Info.plist` -- declares the `cordierite-native` URL scheme
  (`CFBundleURLTypes`). No `CordieriteTrust`/`CordieriteCliPins` keys: this playground is the
  zero-config example, so it trusts whatever pin `cordierite link` puts on the deep link for that
  session (`trust: "link"`) -- see [`docs/SECURITY.md`](../../docs/SECURITY.md#trust-modes).
