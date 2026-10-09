# Appduct for Flutter

Call functions inside your running Flutter app from a terminal, a test runner or an AI agent. You register a few functions, called tools, with a name, a description and an input schema. The `appduct` CLI and its MCP server list and call them over an encrypted connection. Only the tools you register are reachable.

Works on Android, iOS, macOS, Windows and Linux. Flutter web isn't supported.

## Requirements

- Flutter 3.38 or newer, iOS 15 or newer, Android 7.0 (API 24) or newer.
- The `appduct` CLI on your computer: `npm install -g appduct` (Node 20 or newer).

## Getting started

```bash
flutter pub add appduct
```

Start Appduct before `runApp`, and register a tool:

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
      'properties': {
        'items': {'type': 'number'},
      },
      'required': ['items'],
    },
    handler: (args, context) => {'added': (args['items'] as num).toInt()},
  );

  runApp(const ShopApp());
}
```

Then give the app a URL scheme and the permissions to reach your computer: a scheme on Android, iOS and macOS, `INTERNET` in the main Android manifest, `NSLocalNetworkUsageDescription` on iOS and the network client entitlement on macOS. The [Flutter setup guide](https://callstackincubator.github.io/appduct/install/flutter/) has each step.

With the app running in debug mode on a simulator or emulator, connect and call the tool:

```bash
appduct sessions link --open ios-sim     # or: --open android
appduct tools call seed_cart --input '{"items":3}'
```

## Things to know

- **Read numbers as `num`.** A JSON number arrives as an `int` or a `double`, so use `args['items'] as num`, not `as double`.
- **Move heavy work to `Isolate.run`.** Handlers run on the main isolate. A long computation inside one freezes your UI.
- **Create the futures a handler awaits inside the handler.** A future created earlier that fails doesn't reach your `try`/`catch`, and the call ends with `tool_timeout`.

[Register tools in Dart](https://callstackincubator.github.io/appduct/install/flutter/#register-tools-in-dart) explains each of these.

## Release builds

Appduct is in debug and profile builds. A release build leaves it out, and your `Appduct.*` calls do nothing. To include it in an internal build, or to leave it out of debug and profile builds, set a define:

```bash
flutter build apk --release --dart-define=APPDUCT_ENABLED=true
```

Pin an included build to your key with `APPDUCT_PINS` and `APPDUCT_TRUST` through `--dart-define-from-file`. See [Ship Appduct in a release build](https://callstackincubator.github.io/appduct/install/flutter/#ship-appduct-in-a-release-build) and [Security](https://callstackincubator.github.io/appduct/guides/security/). Check the built app with `appduct doctor <file> --assert-absent`.

## Learn more

- [Documentation](https://callstackincubator.github.io/appduct/): guides and reference for every platform
- [Write tools](https://callstackincubator.github.io/appduct/guides/writing-tools/): schemas, timeouts, groups and events
- [Connect an agent](https://callstackincubator.github.io/appduct/guides/agents/) over MCP

## License

MIT. Made at [Callstack](https://callstack.com/).
