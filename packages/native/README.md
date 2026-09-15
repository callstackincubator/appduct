# `packages/native`

The framework-free native core behind Appduct: TLS-pinned session transport, SPKI pinning,
explicit trust-mode resolution, process-memory resume leases, and the full app-side session
lifecycle (claim/resume, reconnect backoff, grace-window recovery, the tool registry, per-call
timeout/cancel/progress, and bootstrap deep-link handling), in plain Swift and Kotlin with no React
Native dependency. It also ships a small public facade (`Appduct.shared` on iOS, the
`Appduct` object on Android) that a plain native app calls directly, with no React Native or
Expo anywhere in the stack.

## Consuming this

- **Building a plain iOS app?** See [`ios/README.md`](ios/README.md) — install via SwiftPM or
  CocoaPods, declare your URL scheme, register tools, hardened-build config.
- **Building a plain Android app?** See [`android/README.md`](android/README.md) — install via
  Maven, the `appductScheme` manifest placeholder, registering tools, hardened-build config.
- **Building a React Native app?** Use [`@appduct/react-native`](../react-native/README.md)
  instead — it vendors this core's sources and gives you the same functionality behind a JS API.
- Runnable examples: [`playground-native/ios`](../../playground-native/ios) and
  [`playground-native/android`](../../playground-native/android) — a plain SwiftUI and a plain
  Jetpack Compose app registering the same tools the Expo playground (`playground/`) does.

## Contributing

For how this directory is laid out, how `@appduct/react-native` vendors it, the facade-exclusion
rules, and publishing status for the CocoaPods/Maven/SwiftPM artifacts, see
[`docs/internal/native-core.md`](../../docs/internal/native-core.md).
