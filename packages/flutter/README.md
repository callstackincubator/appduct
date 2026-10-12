<a href="https://callstackincubator.github.io/appduct/"><img src="https://raw.githubusercontent.com/callstackincubator/appduct/main/.github/assets/readme-banner.png" alt="Appduct by Callstack. Your app is an MCP server now: your agent calls its functions over MCP, on iOS, Android, React Native, Flutter and web." width="100%" /></a>

# Appduct for Flutter

Call functions inside your running Flutter app from a terminal, a test runner or an AI agent. Register functions as tools; only the tools you register are reachable.

Works on Android, iOS, macOS, Windows and Linux. Flutter web isn't supported.

## Requirements

- Flutter 3.38 or newer (Dart 3.10), iOS 15 or newer, Android 7.0 (API 24) or newer.
- The `appduct` CLI on your computer: `npm install -g appduct` (Node 20 or newer).

## Getting started

Install the package:

```bash
flutter pub add appduct
```

Start Appduct before `runApp`, and register a tool in your existing app:

```dart
import 'package:appduct/appduct.dart';
import 'package:flutter/material.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  Appduct.ensureInitialized();

  Appduct.instance.registerTool(
    'seed_cart',
    description: 'Fill the cart with test items.',
    inputSchema: {
      'type': 'object',
      'properties': {'items': {'type': 'number'}},
      'required': ['items'],
    },
    handler: (args, context) => {'added': (args['items'] as num).toInt()},
  );

  runApp(const ShopApp());
}
```

Use your app's root widget in place of `ShopApp`.

Before connecting, **complete the [platform setup](https://callstackincubator.github.io/appduct/install/flutter/#set-up-the-app)** for each platform you use. Android, iOS and macOS need a URL scheme; Android needs `INTERNET` in the main manifest, iOS needs `NSLocalNetworkUsageDescription`, and macOS needs the network client entitlement. The guide includes the snippets to add. Windows and Linux use a [desktop connection](https://callstackincubator.github.io/appduct/install/flutter/#connect-a-desktop-app) instead of link delivery.

For the Android emulator path, record the scheme you configured and your installed build's `applicationId`, then run a debug build:

```bash
appduct init --scheme myapp --android-app-id com.example.shop
flutter run -d <device>
```

In another terminal, from the Flutter project root:

```bash
appduct sessions link --open android
appduct tools ls
appduct tools call seed_cart --input '{"items":3}'
```

The tool returns `{"added":3}`. On a booted iOS Simulator, use `--open ios-sim` instead.

## Things to know

- **Read numbers as `num`.** JSON numbers arrive as an `int` or a `double`; use `(args['items'] as num).toInt()`.
- **Validate arguments when needed.** Raw JSON Schema describes the tool to callers; it doesn't validate arguments. The [Dart tool guide](https://callstackincubator.github.io/appduct/install/flutter/#register-tools-in-dart) covers `validated(schema, handler)`.
- **Move heavy work to `Isolate.run`.** Handlers run on the main isolate; a long computation freezes your UI.
- **Create awaited futures inside the handler.** An earlier future that fails can leave the call waiting until `tool_timeout`. See the [Dart tool guide](https://callstackincubator.github.io/appduct/install/flutter/#register-tools-in-dart).
- **Reconnect after process death.** Hot restart and short network drops resume the session; killing the app requires a new link.

## Release builds

Appduct is included in debug and profile builds. A release build leaves it out, and your `Appduct.*` calls do nothing. To include it in an internal build:

```bash
flutter build apk --release --dart-define=APPDUCT_ENABLED=true
```

Use `APPDUCT_ENABLED=false` to exclude it from debug and profile builds. Pin an included build to your key with `APPDUCT_PINS` and `APPDUCT_TRUST`; see [Release setup](https://callstackincubator.github.io/appduct/install/flutter/#ship-appduct-in-a-release-build). Check an APK that should exclude it with `appduct doctor build/app/outputs/flutter-apk/app-release.apk --assert-absent`.

## Learn more

- [Flutter setup](https://callstackincubator.github.io/appduct/install/flutter/): platform configuration, events and troubleshooting
- [Write tools](https://callstackincubator.github.io/appduct/guides/writing-tools/): schemas, timeouts, groups and events
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/) over MCP
- [Security](https://callstackincubator.github.io/appduct/guides/security/): trust and key pinning
- [Flutter playground](https://github.com/callstackincubator/appduct/blob/main/playground-flutter/README.md): a runnable example

## License

[MIT](https://github.com/callstackincubator/appduct/blob/main/LICENSE). Made at [Callstack](https://callstack.com/).
