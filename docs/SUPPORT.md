# Packages and platform support

## Packages

| Package | What it is |
| --- | --- |
| [`appduct`](../packages/appduct/README.md) | The CLI, the background service, and the MCP server |
| [`AppductCore`](../packages/native/ios/README.md) | The iOS library (Swift Package Manager or CocoaPods) |
| [`com.callstack.appduct:core`](../packages/native/android/README.md) | The Android library, paired with `core-noop` for release builds (Maven Central) |
| [`@appduct/react-native`](../packages/react-native/README.md) | The React Native library and Expo config plugin |

## Requirements

- **iOS:** iOS 15.1 or newer. Installing with Swift Package Manager needs Xcode 16.3 or newer.
- **Android:** Android 7.0 (API 24) or newer.
- **React Native:** iOS 15.1+ and Android, both on the New Architecture. Web gets a no-op stub so shared code doesn't break.
- **CLI:** Node 20 or newer. Windows hasn't been verified.
