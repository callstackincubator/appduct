<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct for iOS

Call functions inside your running SwiftUI or UIKit app from a terminal, a test runner or an AI agent. Register tools with `AppductCore`; only the tools you register are reachable.

For a React Native app, use [`@appduct/react-native`](https://github.com/callstackincubator/appduct/blob/main/packages/react-native/README.md).

## Requirements

- iOS 15.1 or newer.
- Xcode 16.3 or newer for Swift Package Manager (Swift 6.1).
- The `appduct` CLI on your Mac: `npm install -g appduct` (Node 20 or newer).

## Getting started

Add the package with Swift Package Manager and add the `AppductCore` product to your app target:

```swift
.package(url: "https://github.com/callstackincubator/appduct", from: "0.14.0")
```

In Xcode, use File → Add Package Dependencies with the repository URL. [CocoaPods setup](https://callstackincubator.github.io/appduct/install/ios/#set-up-the-app) is also available.

Add a URL scheme to your app's `Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>myapp</string></array>
  </dict>
</array>
```

Register a tool at startup and forward links from your root SwiftUI view:

<a id="2-forward-deep-links"></a>

```swift
import AppductCore
import SwiftUI

@main
struct ShopApp: App {
  init() {
    try! Appduct.shared.register(
      name: "seed_cart",
      description: "Fill the cart with test items.",
      inputSchema: [
        "type": "object",
        "properties": ["items": ["type": "number"]],
        "required": ["items"],
      ]
    ) { args in
      ["added": (args["items"] as? NSNumber)?.intValue ?? 0]
    }
  }

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

Keep your existing root view in place of `ContentView`. For UIKit, forward both launch and later links from your [scene delegate](https://callstackincubator.github.io/appduct/install/ios/#set-up-the-app).

Build and run the Debug configuration on a booted iOS Simulator. From your app's project directory:

```bash
appduct sessions link --scheme myapp --open ios-sim
appduct tools ls
appduct tools call seed_cart --input '{"items":3}'
```

The tool returns `{"added":3}`. See [Connect a device](https://callstackincubator.github.io/appduct/guides/cli/#connect-a-device) for physical iPhones.

## Things to know

<a id="threading"></a>

- **Switch to the main actor for UI work.** Handlers and listeners run off the main actor; wrap UI changes in `await MainActor.run { … }`.
- **Check arguments in your handler.** Schemas are plain JSON Schema and don't validate inputs. Return JSON-compatible values; other values fail with `tool_serialization_error`.
- **Remove tools explicitly.** `register` returns a `ToolRegistration`; call `.remove()`. Letting it go out of scope doesn't unregister it.
- **Background calls have limited time.** iOS can allow calls to finish briefly after backgrounding. Once that time ends, calls fail with `session_suspended` until the app returns. See [Backgrounding](https://callstackincubator.github.io/appduct/install/ios/#backgrounding).
- **Reconnect after process death.** Short network drops resume the session; killing the app requires a new link.

## Release builds

With the default SwiftPM dependency, Debug includes Appduct and Release uses an inert implementation with the same API. To include it in an internal Release build, enable the `AlwaysEnabled` trait:

```swift
.package(url: "https://github.com/callstackincubator/appduct", from: "0.14.0", traits: ["AlwaysEnabled"])
```

For CocoaPods, use `:configurations => ['Debug']` to exclude it from Release. Pin an included build to your key, and verify the built app:

```bash
appduct doctor build/Shop.app --assert-absent
```

See [Release setup](https://callstackincubator.github.io/appduct/install/ios/#ship-appduct-in-a-release-build) for trust settings and installation-specific options.

## Learn more

- [iOS setup](https://callstackincubator.github.io/appduct/install/ios/): UIKit, listeners, events and troubleshooting
- [Write tools](https://callstackincubator.github.io/appduct/guides/writing-tools/): schemas, timeouts and groups
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/) over MCP
- [Security](https://callstackincubator.github.io/appduct/guides/security/): trust and key pinning
- [iOS playground](https://github.com/callstackincubator/appduct/blob/main/playground-native/ios/README.md): a runnable SwiftUI example

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE).

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
