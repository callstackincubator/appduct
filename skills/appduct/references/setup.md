# Appduct setup

Use this file when the task is to add Appduct to a project that doesn't have it yet: a React
Native app (Expo or bare), or a native iOS or Android app with no React Native
(see [Native iOS or Android](#native-ios-or-android)).

The development path needs **no keys, no pins and no config file**. The daemon generates
its own host key on first start, the deep-link scheme is discovered from the project's own
files (`app.json`, or the Android/iOS project files — see below), and any build with no
embedded pins trusts the pin carried in the link itself — in every build type, not just a
debug one. Everything under **Hardening** below is for builds that leave your machine — do
not do it as part of a first-time setup.

## React Native: every project

1. Install `appduct` where the operator or agent will run the CLI (or configure it as
   an MCP server — see [cli.md](./cli.md)). Its daemon auto-spawns on first use; there
   is no separate host process to start.
2. Install `@appduct/react-native` in the app.
3. Register the app tools you want Appduct to expose (`registerTool` /
   `useAppductTool`), following [writing-tools.md](./writing-tools.md) so the agent that
   calls them can use them.
4. Import `@appduct/react-native/auto` once near the app's entry point to install the
   deep-link bootstrap listener automatically — or `require()` it at the point you want
   it installed (e.g. behind `__DEV__`). (If you'd rather drive bootstrap yourself —
   custom deep-link handling, QR scanning, tests — skip that entry, use the
   side-effect-free root entry, and call `restoreSession()` at startup before your own
   bootstrap handling so a Metro reload still recovers the session.)
5. Release builds need nothing: they leave out Appduct's native module by default, and the
   JS that is still bundled goes inert. Do not set `APPDUCT_ENABLED=0` for a dev setup — it
   removes Appduct from debug builds too. Only if the project wants Appduct's JS stripped
   from release bundles as well, wrap the Metro config in `withAppduct` from
   `@appduct/react-native/metro` (call it last, after anything else that sets
   `resolver.resolveRequest`) and build releases with `APPDUCT_ENABLED=0`. See
   https://callstackincubator.github.io/appduct/guides/build-variants/.

## Expo

1. Add `@appduct/react-native` to the app dependencies.
2. Optional: add the Appduct Expo config plugin to the Expo config. `cliPins` is
   required only when `trust: "pin"` is set or implied; `trust` and `allowPrivateLanOnly`
   (defaults to `true`, fail-closed) are optional, and `deepLinkScheme` is only
   *validated* against `expo.scheme` — it is not what the CLI reads. A zero-config app can
   skip the plugin entry entirely (https://callstackincubator.github.io/appduct/guides/security/#pin-a-build-to-your-key).
3. Make sure `expo.scheme` is set — it is both what registers the app for deep links and
   what `appduct sessions link` discovers automatically from `app.json`.
4. Run `appduct init` in the app root. It records the scheme in
   `.appduct/config.json` and prints the MCP server entry to paste into an agent's
   config. Re-running it is always safe: it keeps the scheme already recorded, and only
   notes it if `app.json` has since come to declare a different one. Use
   `appduct init --force` to adopt the new `app.json` value. Add
   `--android-app-id <package> --ios-app-id <bundle-id>` (`expo.android.package` and
   `expo.ios.bundleIdentifier`) so `--open android` and `appduct_connect` can deliver links
   without an `--app-id` on every call.
5. Run prebuild or rebuild the native project so the native config is applied.
6. Use a development build. Expo Go is not enough — this library ships native code.

If the project uses a dynamic `app.config.js` / `app.config.ts`, discovery does not apply
(Appduct never executes project code to read a scheme). Use
`appduct init --scheme <scheme>` once, or pass `--scheme` / set `APPDUCT_SCHEME`.

## Bare React Native

1. Add `@appduct/react-native` to the app dependencies.
2. Run the normal native dependency installation steps for the project.
3. Configure URL schemes / intent filters so bootstrap links (`{scheme}:///?appduct=…`)
   open your app.
4. Run `appduct init` in the project root. With no `app.json` `expo.scheme`, discovery
   falls back to static native project files, all relative to the directory you run it in
   (never a walk-up): `app/build.gradle(.kts)`'s `appductScheme` manifest placeholder, then
   `app/src/main/AndroidManifest.xml`'s first `<data android:scheme>` in a `VIEW` intent
   filter, then any `Info.plist` up to two levels down for the first `CFBundleURLSchemes`
   entry, then xcodegen's `project.yml`. From a bare React Native root the iOS plist probe
   reaches `ios/<App>/Info.plist`, but the Android ones expect an Android project root
   (`android/`), so pass `appduct init --scheme <scheme>` with the scheme you configured in
   step 3 whenever discovery comes up empty. It also refuses to guess when two probes
   resolve different schemes — `--scheme` is the answer there too. Add
   `--android-app-id <applicationId> --ios-app-id <bundle-id>` so device delivery works
   without an `--app-id` on every call.
5. Leave the private-LAN-only setting alone: it is on by default, so a bootstrap link must
   point at a private IPv4 address or `127.0.0.1`. Turn it off (`AppductAllowPrivateLanOnly`
   in `Info.plist`, `com.callstack.appduct.ALLOW_PRIVATE_LAN_ONLY` meta-data on Android) only
   if a device has to reach the machine at a public address.
6. Rebuild the native app after the configuration changes.

## Native iOS or Android

A plain Swift or Kotlin app with no React Native uses Appduct's native SDKs. Install
`appduct` for the CLI as in step 1 above, then:

- **iOS** (iOS 15.1+): add the `AppductCore` Swift package (Xcode 16.3+) or the
  `AppductCore` pod restricted to `Debug`, declare the URL scheme in `Info.plist`, forward
  opened URLs to `Appduct.shared.handle(url)`, and register tools with
  `Appduct.shared.register(...)`. Full guide:
  https://github.com/callstackincubator/appduct/blob/main/packages/native/ios/README.md
- **Android** (`minSdkVersion` 24+): add `debugImplementation("com.callstack.appduct:core:<version>")`
  and `releaseImplementation("com.callstack.appduct:core-noop:<version>")`, set
  `manifestPlaceholders["appductScheme"]`, make sure the app's manifest has the `INTERNET`
  permission, and register tools with `Appduct.register(...)` in `Application.onCreate()`.
  Deep links reach Appduct with no code of your own. Full guide:
  https://github.com/callstackincubator/appduct/blob/main/packages/native/android/README.md

Then run `appduct init --ios-app-id <bundle-id>` or `--android-app-id <applicationId>` in the
app root; it finds the scheme in `Info.plist` or the Gradle placeholder. Release builds leave
Appduct out by default on both platforms.

## Web

1. Install `appduct` where you run the CLI, and `@appduct/web` in the page's app.
2. Register tools with `registerTool` from `@appduct/web`, following
   [writing-tools.md](./writing-tools.md). The API is the same as React Native's, without the
   hook.
3. Connect the page you are driving: `appduct_connect` with `target: "web"` and the page's
   `url` returns `{ url, script }`. Open `url` (reloads the page), or run `script` in the page
   (keeps its state). CLI: `appduct sessions link --open web <url>`. A link works once and
   expires after 5 minutes. Reloading the page resumes the session; a new tab does not.
   If the page is open in a Chrome launched with `--remote-debugging-port` and its own
   `--user-data-dir`, add `browserUrl` (CLI: `--browser-url`, such as `http://127.0.0.1:9222`) and
   the daemon attaches the tab itself: no `script`, no `https` permission prompt, and the session
   is claimed when the call returns. When no tab or several tabs start with `url`, the error lists
   the open tabs with their target ids; pass one as `targetId` (CLI: `--target-id`). A popup or a
   page in a new tab isn't attached; the session stays on the page it was attached to.
   Playwright: `attachPage(page, { link })` from `appduct/client`. Pipe-launched
   chrome-devtools-mcp, `--autoConnect`, Claude in Chrome, Firefox and Safari use the WebSocket
   path: `appduct sessions link --open web <url>`.
4. Production builds need nothing: the root entry is inert unless the bundler sets the
   `development` export condition. To include Appduct in another build, import
   `@appduct/web/enabled`. A React Native app's web build in `expo start --web` needs the Metro
   config wrapped in `withAppduct` (`@appduct/react-native/metro`) to connect in development,
   because Metro sets no `development` condition; without it the page stays inert. In a bundler
   with no `development` condition (plain esbuild), `connect()` warns once and does nothing. Running the `script` then throws a `TypeError`
   because `window.__APPDUCT__` is undefined, and opening the `url` silently connects nothing.
   Fix it with `--conditions=development` (esbuild), or import `@appduct/web/enabled`.
5. If the connection is refused: the page's origin must be `localhost`, `127.0.0.1` or `[::1]`,
   or listed in `webOrigins` in `~/.appduct/config.json` (then `appduct daemon stop`). An
   `https` page needs Chrome's local network access permission, granted in Playwright with
   `context.grantPermissions(["local-network-access"], { origin })`; Safari can't connect from
   `https`. The browser must run on the same computer as the daemon.

## Hardening (not needed for a dev loop)

For builds that leave your machine, replace link-carried trust with embedded pins:

1. Run `appduct keygen` (non-interactive with `--out <path>`; writes
   `~/.appduct/key.pem` by default, which is also where the daemon auto-generates one).
2. Add the printed `sha256/...` SPKI pin to the app configuration in a `cliPins` array
   (plural — the native clients accept a pin *set*, which is what makes future rotation
   non-breaking). Providing `cliPins` switches `trust` to `"pin"` by default.
3. Rebuild: this is native configuration, so it is not a fast in-session action.

## Final check

- The app trusts the daemon's current pin — via `cliPins` for a pinned build, or via the
  link-carried pin when no `cliPins` are configured.
- The app has at least one registered tool.
- The app's deep-link scheme matches what `appduct sessions link` resolves — run
  `appduct sessions link --json` in the app root and read the scheme off the deep link; the
  error names every location it looked in if it cannot find one.
- `appduct sessions ls` (or `appduct_connect` + `appduct_wait_for_session` over MCP)
  reaches `state: "active"` once the app opens the link.
- Hardened builds only: the daemon's key is present and `0600`, and the app trusts its
  current pin in `cliPins`.
