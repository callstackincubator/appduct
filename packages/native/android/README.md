<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct for Android

Call functions inside your running Kotlin or Java Android app from a terminal, a test runner or an AI agent. Register tools with the `Appduct` SDK; only the tools you register are reachable.

For a React Native app, use [`@appduct/react-native`](https://github.com/callstackincubator/appduct/blob/main/packages/react-native/README.md).

## Requirements

- Android 7.0 (API 24) or newer.
- The `appduct` CLI on your computer: `npm install -g appduct` (Node 20 or newer).
- `adb` on your `PATH` for automatic link delivery to an emulator or USB device.

## Getting started

Add the real and inert artifacts from Maven Central to your app's Gradle dependencies. Use the same Appduct version for both:

```kotlin
dependencies {
  debugImplementation("com.callstack.appduct:core:0.15.0")
  releaseImplementation("com.callstack.appduct:core-noop:0.15.0")
}

android {
  defaultConfig {
    manifestPlaceholders["appductScheme"] = "myapp-appduct"
  }
}
```

Use a dedicated scheme if your app already handles its own deep links. Ensure your app's `AndroidManifest.xml` has this permission, outside `<application>`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

Register a tool in your `Application.onCreate()`:

```kotlin
import android.app.Application
import com.callstack.appduct.Appduct
import org.json.JSONObject

class ShopApp : Application() {
  override fun onCreate() {
    super.onCreate()

    Appduct.register(
      name = "seed_cart",
      description = "Fill the cart with test items.",
      inputSchema = JSONObject(
        """{"type":"object","properties":{"items":{"type":"number"}},"required":["items"]}""",
      ),
    ) { args ->
      JSONObject().put("added", args.optInt("items"))
    }
  }
}
```

If you added this `Application` class, set `android:name=".ShopApp"` on your manifest's `<application>` element. Appduct initializes automatically; you don't need an `init` call or a link handler.

Build and install your debug app on an emulator or USB device. From your Android project directory, record the scheme and the installed variant's `applicationId`, then connect:

```bash
appduct init --scheme myapp-appduct --android-app-id com.example.shop
appduct sessions link --open android
appduct tools ls
appduct tools call seed_cart --input '{"items":3}'
```

The tool returns `{"added":3}`. Include any `applicationIdSuffix` in the id you record.

## Things to know

- **Switch to the main thread for UI work.** Handlers and listeners run in the background; use `withContext(Dispatchers.Main) { … }` for UI changes.
- **Check arguments in your handler.** Raw JSON Schema describes inputs but doesn't validate them. Return JSON-compatible values; other values fail with `tool_serialization_error`.
- **Remove tools explicitly.** `register` returns a `ToolRegistration`; call `.remove()`. Registering the same name replaces its handler.
- **Check setup when a link doesn't connect.** A missing `appductScheme` fails the build; a missing `INTERNET` permission prevents the connection. See [Troubleshooting](https://callstackincubator.github.io/appduct/install/android/#troubleshooting).
- **Reconnect after process death.** Short network drops resume the session; killing the app requires a new link.

### Opting out of the init provider and trampoline

Keep the startup provider unless you supply initialization yourself. If you need to handle deep links in your own activity, follow [Deep links](https://callstackincubator.github.io/appduct/install/android/#deep-links); the guide also explains the consequences of removing either component.

## Release builds

The `debugImplementation(core)` / `releaseImplementation(core-noop)` pairing includes Appduct in debug builds and an inert API in release builds. For an internal release build, depend on `core` for that variant and pin it to your key. See [Release setup](https://callstackincubator.github.io/appduct/install/android/#ship-appduct-in-a-release-build).

Check a release APK that should exclude Appduct:

```bash
appduct doctor app/build/outputs/apk/release/app-release.apk --assert-absent
```

## Learn more

- [Android setup](https://callstackincubator.github.io/appduct/install/android/): deep links, listeners, events and troubleshooting
- [Write tools](https://callstackincubator.github.io/appduct/guides/writing-tools/): schemas, timeouts and groups
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/) over MCP
- [Security](https://callstackincubator.github.io/appduct/guides/security/): trust and key pinning
- [Android playground](https://github.com/callstackincubator/appduct/blob/main/playground-native/android/README.md): a runnable Compose example

## Made with ❤️ at Callstack

`appduct` is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love] is a group of React and React Native geeks, contact us at [hello@callstack.com](mailto:hello@callstack.com) if you need any help with these or just want to say hi!

Like the project? ⚛️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=appduct&utm_term=readme-with-love
