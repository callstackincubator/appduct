# Build variants: which builds carry Appduct

Whether Appduct's native code ships in a given build is decided by autolinking and the
`APPDUCT_ENABLED` environment variable. It is **not** derived from whether the build is
debuggable.

The JS half is a separate, opt-in step. `APPDUCT_ENABLED` strips Appduct's JS too,
but only once the `withAppduct` Metro helper is wired into `metro.config.js` — without
that, the real JS entry is still bundled; it just finds no native module and goes inert.

What a build *trusts* once it does ship is a separate, orthogonal decision — see
[`SECURITY.md`](SECURITY.md#trust-modes).

- [Inclusion is an autolinking decision](#inclusion-is-an-autolinking-decision)
- [`APPDUCT_ENABLED`](#appduct_enabled)
- [Verifying against the artifact](#verifying-against-the-artifact)
- [Compiling Appduct out of production builds](#compiling-appduct-out-of-production-builds)
- [Excluding it permanently, without the environment variable](#excluding-it-permanently-without-the-environment-variable)
- [JS — swap the module at bundle time](#js--swap-the-module-at-bundle-time)
- [Native core](#native-core)

## Inclusion is an autolinking decision

Inclusion is decided entirely by autolinking, not by anything this package does at
runtime. By default the native module is present in **debug** builds and absent from
**release** builds.

On iOS, CocoaPods links the pod only into the `Debug` configuration. On Android, a
`release` build compiles a same-API no-op in place of the real implementation. Either way
an excluded build does not contain the real implementation at all; there is no runtime
build-type check to bypass.

**Resulting matrix (`APPDUCT_ENABLED` × build variant, `trust` orthogonal to both):**

| `APPDUCT_ENABLED` | Debug / `debug` | Release / `release` |
| --- | --- | --- |
| unset (default) | Native code ships | Native code excluded |
| `1` / `true` | Native code ships | Native code ships |
| `0` / `false` | Native code excluded | Native code excluded |

`trust` (`"link"` vs `"pin"`, resolved as described in
[`SECURITY.md`](SECURITY.md#trust-modes)) only matters in a variant where the native code
ships at all.

## `APPDUCT_ENABLED`

The per-platform mechanism is described above; this section is what to set, and where
each surface reads it.

A release-signed internal/QA build that still needs Appduct (an agent-driven CI build,
for example) opts back in explicitly:

```bash
APPDUCT_ENABLED=1 npx expo prebuild && APPDUCT_ENABLED=1 npx expo run:ios --configuration Release
```

To go the other direction — strip Appduct from a **debug** build too, or from every
variant regardless of name — set `APPDUCT_ENABLED=0`:

```bash
APPDUCT_ENABLED=0 npx expo prebuild && APPDUCT_ENABLED=0 npx expo run:ios --configuration Release
```

Accepted values are `1`/`true` and `0`/`false`, case-insensitive; unset or empty means the
dev-only default described above.

**A malformed value is only caught on the Expo path, but both platforms fail closed the same
way.** The config plugin throws at prebuild. Nothing else does: autolinking's
`react-native.config.js` swallows the parse error, and `android/build.gradle` treats anything
but `1`/`true` as off — both fall back to the dev-only default (Debug-only on iOS, the
`release` stub on Android), exactly as if the variable were unset. A bare-RN pipeline gets no
error at all — check the built artifact with `appduct doctor` rather than trusting the
variable's spelling.

**One variable, every surface.** Appduct ships its own `react-native.config.js` that
reads the variable and sets `ios.configurations` in autolinking accordingly;
`android/build.gradle` reads the same variable directly to pick the `release` source set;
and `@appduct/react-native/metro` reads it too, to strip the JS (see
[JS — swap the module at bundle time](#js--swap-the-module-at-bundle-time)). Metro's own
dev/release split does not thread through to this, so an explicit `APPDUCT_ENABLED=0`
is still how you strip Appduct JS from a release bundle.

**It must be set when autolinking resolves** — `pod install` and gradle configure — not
merely when the app compiles. Flipping it and rebuilding without re-running install does
nothing, silently.

**Keyed to build type by name, not by a compiled-in check.** CocoaPods restricts linking
to Xcode configurations literally named `Debug`/`Release`; Gradle restricts it to build
types literally named `debug`/`release`. A custom build-type/configuration name (a
`staging` flavor, say) gets neither — set `APPDUCT_ENABLED=1` for that pipeline if it
should carry Appduct. This is a real per-variant linking decision, not a runtime check
compiled into every variant.

## Verifying against the artifact

Verify the result against the artifact rather than the build log:

```bash
appduct doctor path/to/app-release.apk --assert-absent
```

When Appduct *is* linked, its podspec and `build.gradle` print
`[appduct] native module INCLUDED in this build` during pod install / gradle configure.
Nothing prints when it is excluded, because nothing runs — the line exists to catch a
release build that carries Appduct by mistake, which is the failure that matters. Treat
`doctor` as the authority; the log is an early warning.

## Compiling Appduct out of production builds

Removing Appduct entirely takes two independent halves — the native module and the JS
bundle. `APPDUCT_ENABLED=0` drives both at once **provided `withAppduct` is wired
into `metro.config.js`** (see [JS — swap the module at bundle
time](#js--swap-the-module-at-bundle-time)); without that helper the variable removes only
the native half.

Both halves are what satisfies an app-store reviewer who expects no "remote control"
surface whatsoever, not just an inert one.

**Either half alone still yields a working, inert app.** The `/noop` Metro swap alone
gives you an app with no Appduct JS running but the native pod still compiled in
(unused). The autolinking exclude alone gives you an app with no native Appduct code
but that still imports the real JS entry, which finds no native module and degrades to the
same `/noop`-equivalent behavior described in
[`SECURITY.md`](SECURITY.md#what-a-build-without-the-native-module-does).

## Excluding it permanently, without the environment variable

If a project should never carry Appduct on a given platform — regardless of pipeline —
declare the exclusion in the app instead. In a `react-native.config.js` at your app root:

```js
module.exports = {
  dependencies: {
    "@appduct/react-native": {
      platforms: {
        ios: null,
        android: null,
      },
    },
  },
};
```

The Expo-managed equivalent is `expo.autolinking`'s per-platform `exclude` list — but it
must live in **`package.json`**, not `app.json` / `app.config.*`.
`expo-modules-autolinking` reads this config straight from `package.json` at
pod-install/gradle time; an `expo.autolinking` block in `app.json` is silently ignored, so
the exclusion never happens and the native module still ships. Double-check with the
resolver command below after adding it.

```json
{
  "expo": {
    "autolinking": {
      "ios": { "exclude": ["@appduct/react-native"] },
      "android": { "exclude": ["@appduct/react-native"] }
    }
  }
}
```

Verify the exclusion actually took effect — this is the only way to catch the `app.json`
mistake above. Run it from your app root after `npm`/`pnpm`/`yarn install`, using the
locally installed binary rather than `npx` (which can silently fetch an unrelated version
from the registry instead of resolving the one your build actually uses):

```sh
./node_modules/.bin/expo-modules-autolinking react-native-config --json --platform ios
```

`@appduct/react-native` must be absent from the printed `dependencies`.

> **`expo.autolinking.apple` overrides `expo.autolinking.ios`, not merges with it.** The
> CocoaPods driver `pod install` actually invokes always resolves with `--platform apple`,
> and when an `apple` sub-object is present under `expo.autolinking`, it wins outright over
> `ios` — `ios` is only used as a fallback when `apple` is absent. If your app also has an
> `expo.autolinking.apple` block (for reasons unrelated to Appduct), an `ios`-only
> exclude for `@appduct/react-native` is silently ignored on iOS; add the exclude to
> `apple` instead (or to both).

> **Excluding on iOS also disables codegen for this package.** `expo-modules-autolinking`
> only generates `AppductSpec` — the TurboModule codegen output `RCTNativeAppduct.mm`
> imports — for packages it actually autolinks.
>
> So if your app excludes `@appduct/react-native` from iOS autolinking but still
> references the `Appduct` pod directly — for example to attach an XCTest target — the
> build fails because the generated header no longer exists. This only affects setups that
> both exclude and hand-add the pod; a normal consumer app that just wants Appduct gone
> never hits it.

## JS — swap the module at bundle time

Strip the JS too, so no Appduct JS (deep-link listener, tool registry, client state
machine) ends up in the bundle either. Excluding the native module alone does not do this:
the real JS entry is still bundled, it just finds no native module and goes inert.

Use the `withAppduct` Metro helper from `@appduct/react-native/metro` in
`metro.config.js`:

```js
const { getDefaultConfig } = require("expo/metro-config");
const { withAppduct } = require("@appduct/react-native/metro");

const config = getDefaultConfig(__dirname);

module.exports = withAppduct(config);
```

With no options it reads `APPDUCT_ENABLED` itself, so the same variable that drops the
native module strips the JS. Pass `{ include: false }` to force the strip, or
`{ include: yourCondition }` with a boolean you compute yourself to key it off something
else entirely — `include` is a boolean, not a callback.

When stripping, every specifier this package exposes as a real JS module entry point
(derived from `package.json`'s `exports`, not a hardcoded `.`/`/auto` list, so a future
entry point is covered automatically) is redirected to `@appduct/react-native/noop`,
which has no side effect on import, matching `/auto`'s shape without installing anything.
`/noop` itself is never redirected.

If `config.resolver.resolveRequest` is already set — as it typically will be, e.g. a
workspace-symlink-dedup resolver — `withAppduct` **chains to it** for every resolution,
redirected or not, instead of replacing it; it only falls back to `context.resolveRequest`
when no existing resolver is present. Your existing resolver's return value is what
callers see.

**Call `withAppduct` last**, after anything else that sets
`config.resolver.resolveRequest` — it captures the existing resolver by reference when
called, so a later assignment overwrites (and silently discards) the strip instead of
composing with it.

If you'd rather not touch Metro config, a conditional `require` at each import site works
too (module identity differs per call site, so this is more repetitive but avoids any
bundler-level indirection):

```ts
const { registerTool, useAppductTool } = __DEV__
  ? require("@appduct/react-native")
  : require("@appduct/react-native/noop");
```

Either way, `/noop` is typed identically to the root entry — both implement the same
shared interface — so switching between them is a drop-in swap. `registerTool` still
returns a disposer, `connect()` still returns a `Promise<void>` (it just always rejects
with an `AppductDisabledError`, `code: "appduct_disabled"`), and `getAppductState()`
always reports `"idle"`.

## Native core

A plain iOS or Android app, with no React Native, uses the same rule: the real
implementation is in debug builds only, unless you opt in.

**Android.** Depend on the real module for debug and the no-op module for release:

```kotlin
dependencies {
  debugImplementation("com.callstack.appduct:core:<version>")
  releaseImplementation("com.callstack.appduct:core-noop:<version>")
}
```

`core-noop` has the same public API with every method inert, so your code compiles
unchanged in both variants. See
[`packages/native/android/README.md`](../packages/native/android/README.md).

**iOS.** With SwiftPM, the package compiles the real implementation only into `Debug` and a
same-API stub into `Release`; depend on its `AlwaysEnabled` trait to carry the real one into
`Release` too. With CocoaPods, use
`pod 'AppductCore', :configurations => ['Debug']`. See
[`packages/native/ios/README.md`](../packages/native/ios/README.md).

Then check the artifact you are about to ship:

```bash
appduct doctor path/to/app-release.apk --assert-absent
appduct doctor path/to/YourApp.app --assert-absent
```

## Related

- [`SECURITY.md`](SECURITY.md) — trust modes, pins, and the threat model
- [`ARCHITECTURE.md`](ARCHITECTURE.md#11-react-native-sdk) — SDK entry points and client behavior
- [`@appduct/react-native` README](../packages/react-native/README.md) — getting started and API reference
- [`packages/native/README.md`](../packages/native/README.md) — the native core's consumer entry points
