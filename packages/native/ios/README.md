# `AppductCore` for iOS

Tools and state from outside a plain iOS app — no React Native, no Expo required. This is the
Swift SDK behind `@appduct/react-native`'s iOS half, usable directly from any SwiftUI/UIKit app:
register tools, forward a deep link, and a CLI or agent can claim a session, list your tools, and
invoke them over a pinned `wss://` handshake, the same way `@appduct/react-native` does for a
React Native app. See the [repo README](../../../README.md) for what Appduct is; this document is
the iOS integration guide.

If you're integrating from React Native instead, see
[`packages/react-native/README.md`](../../react-native/README.md) — this package is what that one
vendors under the hood.

## Requirements

- iOS 15.1 or later.
- Xcode 16.3 or later for Swift Package Manager (the package manifest needs Swift 6.1). CocoaPods
  has no extra Xcode requirement.

## Install

### Swift Package Manager

```swift
.package(url: "https://github.com/callstackincubator/appduct", from: "0.14.0")
```

`from:` resolves to the newest `0.x` release at or above `0.14.0`, the first with `registerEvent`.

Add the `AppductCore` product to your app target. Nothing else is needed to ship Appduct only in
`Debug`: a `Release` build gets an inert version with the same API, so your code compiles in both
and what you ship to the App Store carries no connection code (see [Compiling out of
Release](#compiling-out-of-release)).

To carry the real implementation into a `Release` build too (an internal/QA build, say), depend on
the `AlwaysEnabled` package trait instead:

```swift
.package(url: "https://github.com/callstackincubator/appduct", from: "0.14.0", traits: ["AlwaysEnabled"])
```

There is no environment-variable switch on this path; the trait is the only way to opt in.

### CocoaPods

```ruby
pod 'AppductCore', :configurations => ['Debug']
```

The `:configurations` restriction is what actually keeps this pod's code out of a `Release`
build — CocoaPods only *links* it into configurations literally named `Debug`. There is no
`AlwaysEnabled`-equivalent opt-in on this path; drop the `:configurations` restriction entirely if
you want the pod linked into every configuration.

## Integration

### 1. Depend on `AppductCore` and import it

```swift
import AppductCore
```

### 2. Declare your app's URL scheme

Add a `CFBundleURLTypes` entry to your `Info.plist` (Xcode: target → Info → URL Types):

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>myapp</string>
    </array>
  </dict>
</array>
```

This is the scheme `appduct sessions link --scheme myapp` (or `appduct init --scheme myapp` once, or
`APPDUCT_SCHEME`) composes the bootstrap deep link with. There is nothing to configure on the
Swift side for this step — the scheme lives entirely in `Info.plist`.

### 3. Forward deep links to `Appduct.shared.handle(_:)`

SwiftUI, on your root scene:

```swift
import AppductCore
import SwiftUI

@main
struct MyApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
        .onOpenURL { url in
          _ = Appduct.shared.handle(url)
        }
    }
  }
}
```

UIKit / a scene delegate — forward from `scene(_:openURLContexts:)` (and, for a cold launch via a
URL, `scene(_:willConnectTo:options:)`'s `connectionOptions.urlContexts`):

```swift
func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
  for context in URLContexts {
    _ = Appduct.shared.handle(context.url)
  }
}
```

`handle(_:)` returns `true` if the URL actually carried an Appduct bootstrap payload, so you can
compose it with your own, unrelated deep links:

```swift
.onOpenURL { url in
  if !Appduct.shared.handle(url) {
    handleMyOwnDeepLink(url)
  }
}
```

The actual parse/connect work happens asynchronously after `handle(_:)` returns; a malformed or
expired payload surfaces through `addListener`'s `.error(...)` case, never as a thrown error from
`handle(_:)` itself.

`Appduct.shared`'s first access already starts `restoreSession()` in the background, recovering
a still-valid process-memory resume lease — you don't need to call it yourself on a cold launch.

## Registering a tool

```swift
import AppductCore

try Appduct.shared.register(
  name: "seed_cart",
  description: "Fill the cart with test items.",
  inputSchema: [
    "type": "object",
    "properties": ["items": ["type": "number"]],
    "required": ["items"],
  ],
  outputSchema: [
    "type": "object",
    "properties": ["added": ["type": "number"]],
  ]
) { args in
  let items = (args["items"] as? NSNumber)?.intValue ?? 0
  return ["added": items]
}
```

- `inputSchema`/`outputSchema` are plain JSON Schema, as `[String: Any]`. Nothing validates call
  arguments against `inputSchema`, so check what your handler needs before using it.
- `handler` is `async throws`, and receives converted `[String: Any]` args; return any
  JSON-representable value (`nil`, a number/string/bool, an `[Any]`, a `[String: Any]`, or nested
  combinations). A value that isn't representable this way (a `Date`, `Data`, or a custom type)
  surfaces to the caller as `tool_error.error.type == "tool_serialization_error"`, the same wire
  error type a JSON-serialization failure produces anywhere else in Appduct.
- `register` returns a `ToolRegistration`; call `.remove()` to unregister. Letting the value go out
  of scope does **not** unregister it — there is no `deinit`-based auto-removal, matching
  `@appduct/react-native`'s `registerTool(...).remove()` contract.
- A second overload drops the `ToolCallContext` parameter for a handler that doesn't need progress
  reporting or the cancellation reason:

  ```swift
  try Appduct.shared.register(name: "ping", description: "Always answers pong.") { _ in
    "pong"
  }
  ```

- `annotations` (`ToolAnnotations(readOnlyHint:destructiveHint:idempotentHint:)`) and `timeoutMs`
  are optional, exactly like the JS API's `registerTool`.
  Set them the way an agent needs them: `readOnlyHint` on every observer, `destructiveHint` on
  anything that deletes, signs out or pays, and an `outputSchema` on every tool, so `appduct tools ls`
  shows a complete signature. [`docs/TOOLS.md`](../../../docs/TOOLS.md#designing-tools-for-agents)
  has the full list of rules, with examples.
- `group` is optional too. On an app with many tools, set it so agents can list them one area at a
  time (`appduct tools ls --group cart`). A group is `"cart"` or one subgroup below it, like
  `"checkout/payment"`; each part uses tool-name characters (letters, digits, `_`, `-`, at most 64).
  A malformed group makes `register` throw, like a malformed name:

  ```swift
  try Appduct.shared.register(name: "add_item", description: "Add a product to the cart.", group: "cart") { args in
    ["added": args["sku"] ?? NSNull()]
  }
  ```

### Observing connection state, session, and errors

```swift
let subscription = Appduct.shared.addListener { event in
  switch event {
  case .stateChange(let change):
    print("state ->", change.state.rawValue, change.reason ?? "")
  case .sessionChange(let change):
    print("session ->", change.sessionId ?? "none")
  case .error(let error):
    print("error [\(error.phase)]:", error.message)
  }
}

// later, if you want to stop listening:
subscription.cancel()
```

`Appduct.shared.state` and `.sessionId` are synchronous snapshots you can read at any time
without a listener — useful for a view's initial render before its first event arrives.

### Posting an app event

```swift
try await Appduct.shared.postEvent("checkout_completed", payload: ["orderId": "abc123"])
```

Read back with `appduct events tail`. Throws (does not send) unless a session is currently active.

Declare the events your app posts so an agent can list them with `appduct events ls` before waiting
on one. `payloadSchema` is an optional JSON Schema object; it is shown to the agent, not checked
against what you post. A name is any string up to 4096 characters, dotted names included.

```swift
let registration = try Appduct.shared.registerEvent(
  name: "checkout_completed",
  description: "Fired once an order finishes checkout.",
  payloadSchema: ["type": "object", "properties": ["orderId": ["type": "string"]], "required": ["orderId"]]
)
// later, to withdraw it:
registration.remove()
```

Against an older `appduct` CLI that predates event lists, the app keeps its session and tools and
`appduct events ls` shows nothing.

## Hardened builds

By default a build trusts whatever pin the deep link itself carries for that session
(`trust: "link"`) — no configuration needed. To pin a build to keys you embedded ahead of time
instead, set these `Info.plist` keys. They are the same settings React Native apps configure; see
[Configuring trust](../../../docs/SECURITY.md#configuring-trust) for what each one protects against:

| Key | Purpose |
| --- | ------- |
| `AppductCliPins` | String array of `sha256/...` SPKI pins (generate with `appduct keygen`) |
| `AppductTrust` | `"link"` \| `"pin"` — any other value is a hard error at connect time |
| `AppductAllowPrivateLanOnly` | Boolean; defaults to `true` (fail-closed) when absent — bootstrap host must be a local IPv4 address |

`trust: "pin"` requires non-empty `AppductCliPins`; a build that only ever trusts embedded pins
but has none configured has no way to trust anything, so native refuses that combination at connect
time. Once any `AppductCliPins` are present, they always win regardless of `AppductTrust`
(config can never *widen* trust). Read the effective configuration a running build actually has —
never a second parse path, so it can never disagree with what a real `connect()` attempt does —
with `Appduct.shared.buildConfig`.

## Compiling out of Release

A default `Release` build doesn't contain Appduct's connection code at all, with either install
method: SwiftPM compiles it only for a configuration named `Debug` unless you opt into
`AlwaysEnabled`, and CocoaPods links it only into `Debug`. A custom configuration name (say,
`Staging`) counts as `Release` here. Check the built app rather than the build settings:

```bash
appduct doctor path/to/YourApp.app --assert-present   # Debug
appduct doctor path/to/YourApp.app --assert-absent    # Release
```

`doctor` exits non-zero when the assertion fails, so you can run it as a release-pipeline step. See
[`docs/BUILD-VARIANTS.md`](../../../docs/BUILD-VARIANTS.md) for how other build variants are
handled.

## Threading

Every `Appduct` method is safe to call from any thread/actor. Tool handlers, `addListener`
callbacks, and everything inside `AppductClient` itself run **off the main actor** — a handler
(or listener) that touches UI must hop back explicitly:

```swift
try Appduct.shared.register(name: "show_alert", description: "Shows a native alert.") { _ in
  await MainActor.run {
    // present UI here
  }
  return nil
}
```

`ToolCallContext.reportProgress(progress:message:)` and `.cancelReason()` are themselves safe to
call from any thread and need no such hop.

## Troubleshooting

**`handle(_:)` always returns `false`.** The URL doesn't carry a `appduct` query parameter —
check the scheme in `Info.plist` matches what `appduct sessions link --scheme <scheme>` used, and that
you're forwarding the *actual* opened URL (not a re-derived one) into `handle(_:)`.

**A tool call never reaches your handler.** Confirm `Appduct.shared.state == .active` and that
`appduct tools ls` lists the name you registered — a call for an unregistered name gets
`tool_not_found` without ever reaching app code, by design.

**Registering the same name twice.** `register` upserts by name; the second registration's handler
replaces the first's, and the tool keeps its original position in `appduct tools ls`' listing.

**A Release build still connects.** You depended on the `AlwaysEnabled` trait (SwiftPM) or dropped
CocoaPods' `:configurations` restriction, most likely on purpose for an internal/QA build — see
[Compiling out of Release](#compiling-out-of-release) to confirm what actually shipped, and
[Hardened builds](#hardened-builds) if that build should also be pinned.

## Going further

- [`playground-native/ios`](../../../playground-native/ios) — a full example app built on this SDK.
- [`docs/SECURITY.md`](../../../docs/SECURITY.md) — trust modes, pins, the threat model.
- [`docs/BUILD-VARIANTS.md`](../../../docs/BUILD-VARIANTS.md) — how inclusion is decided per build.
