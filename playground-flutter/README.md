# Appduct Playground (Flutter)

A Flutter app (Android, iOS, macOS) that depends on [`packages/flutter`](../packages/flutter) by
path and registers the same five tools and the `playground_ping` event as `playground` and
`playground-native`, so `appduct tools ls` reports an equivalent surface whichever playground
answered the link. The tools, the event and the screens' `Semantics` identifiers (`call-count`,
`connection-state`, `ping-button` and the rest) follow the
[playground contract](../docs/internal/playground-contract.md); `session-alias` and
`last-session-event` stay `none` because the Flutter SDK does not expose them yet. It uses go_router, so an Appduct link reaching the app is checked against a real
router.

```bash
cd playground-flutter
flutter pub get
flutter run -d <device>                          # debug build, Appduct included
cd ..
pnpm playground-flutter:appduct -- sessions link --open android      # or ios-sim
pnpm playground-flutter:appduct -- tools call sum --input '{"a":2,"b":3}'
```

`flutter test` checks the tools against the package's in-memory fakes. The device checks (hot
restart, links under UIScene, a profile build on an iPhone, an opted-in release build) are in the
`e2e-device` skill, `.claude/skills/e2e-device/SKILL.md`.

The scheme is `appduct-flutter`. The Android manifest has the `INTERNET` permission, `Info.plist`
has `NSLocalNetworkUsageDescription`, and the macOS entitlements have
`com.apple.security.network.client`, the three things `appduct init` prints for a Flutter project.
