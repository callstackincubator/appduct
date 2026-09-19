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

The mechanism differs by platform. On iOS, CocoaPods' `:configurations` is restricted to
`Debug` — a real per-variant *linking* decision.

Android can't use the equivalent `buildTypes` lever the same way, for a package with
static Java registration (`packageInstance`). React Native's Gradle autolinking generates
`PackageList.java` once, shared unfiltered across every variant, so restricting *linking*
by variant would leave that shared file referencing a class absent from an unlisted
variant's classpath — a compile error, not an inert build.

Android therefore links this project into every variant unconditionally, and
`android/build.gradle` instead swaps which *vendored source directory* compiles for the
`release` build type, based on `APPDUCT_ENABLED`. `AppductPackage`/`NativeAppductModule`
(`android/src/main/java`) always compile, for every variant — they reference
`AppductConnectionManager` and friends by unqualified name only, never a build-type
check. Which implementation that name resolves to is decided by which directory is on the
variant's compile classpath: `debug` always adds `android/core` (the real implementation,
vendored from `packages/native/android/core`); `release` adds either the same `android/core`
(opted in) or `android/core-noop` (the default) — the same public API, every method a no-op.
There is no `src/debug`/`src/release-stub` source-set split; the split is which
vendored directory gets added to the variant's `java.srcDirs`.

Either way, the real implementation is genuinely absent from the compiled output it is
excluded from — not a `#if DEBUG`/`FLAG_DEBUGGABLE` check baked into code that ships
regardless. `AppductPackage.getModule` (Android) and
`AppductTurboBridge.swift`/`RCTNativeAppduct.mm` (iOS) contain no build-type check
at all: if the real implementation is compiled/linked into a variant, it is in that
variant's build, full stop. Whether it is is what `APPDUCT_ENABLED` controls.

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

There is no plugin option to assert this stays in sync with autolinking — the plugin no
longer accepts an `include` option; passing one throws at prebuild, naming the replacement
(`APPDUCT_ENABLED`, described above).

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

The Swift/Kotlin connection code above — TLS, SPKI pinning, trust-mode resolution, the
private-LAN check, and the process-memory resume lease — lives canonically in
`packages/native`, not in `@appduct/react-native` itself. `@appduct/react-native` vendors
it at build/publish time (`scripts/sync-native-core.mjs`) rather than depending on it as a
published package, so this package's releases stay independent of separately publishing
`packages/native` to CocoaPods trunk / Maven Central. Nothing here changes what ships in a
given build variant; it only changes where the source of truth for that code lives.

**iOS** (`packages/native/ios`): a SwiftPM package, `AppductCore`, manifested by the
repo-root `Package.swift` (SwiftPM requires the manifest at the repository root for URL
dependencies). Every file under `Sources/AppductCore/Real/` is wrapped in
`#if APPDUCT_ENABLED`, with a same-API no-op mirror under `Stub/` wrapped in
`#if !APPDUCT_ENABLED`. The `AppductCore` target's `swiftSettings` define
`APPDUCT_ENABLED` for the `Debug` configuration, plus for any configuration that opts into
the `AlwaysEnabled` package trait — a trait rather than a second product, because a target's
sources (and therefore its active `#if` branches) are shared by every product built from it,
so a second "always-real" product could not compile different content from the first. This
is the same `Debug`-only default as `:configurations => ['Debug']` above, just expressed as a
compiler define instead of a linking decision, because a SwiftPM `TargetDependency` cannot be
conditioned on build configuration the way a CocoaPods dependency can.
`@appduct/react-native`'s own `Appduct.podspec` vendors only `Real/` and always compiles
it with `-DAPPDUCT_ENABLED` set — autolinking has already decided inclusion by the time
those sources compile, so the pod never needs `Stub/`.

**Android** (`packages/native/android`): a standalone Gradle project (own `settings.gradle`,
not a workspace member) publishing two modules with the same public API —
`com.callstack.appduct:core` (the real implementation) and `:core-noop` (every
method a no-op, no `okhttp` dependency, no marker class). `@appduct/react-native` vendors
`core`/`core-noop` into `android/core`/`android/core-noop` and picks between them the same way
described above — `AppductPackage`/`NativeAppductModule` (`android/src/main/java`)
always compile, and `debug`/`release` add whichever vendored directory to `java.srcDirs`.
**A plain Android app instead depends on `core`/`core-noop` as ordinary Maven coordinates**
(`debugImplementation("com.callstack.appduct:core:<version>")` /
`releaseImplementation("com.callstack.appduct:core-noop:<version>")`,
`packages/native/android/README.md`) — a real per-variant *dependency* decision, distinct from
(and simpler than) the vendored copy's source-directory swap, since a plain app has no
`PackageList.java`-style shared registration file forcing every variant onto the same
classpath the way RN's autolinking does.

Three exclusion mechanisms exist across the two platforms and their two consumers, all
structural and all failing closed: Android's `debugImplementation`/`releaseImplementation`
pairing with `core-noop` (a plain app, and the vendored copy's `java.srcDirs` swap doing
the equivalent internally); iOS CocoaPods' `:configurations => ['Debug']`; and iOS SwiftPM's
`Debug`-conditioned `APPDUCT_ENABLED` compiler define plus the opt-in `AlwaysEnabled` package
trait. None of the three is a runtime check — in every case the excluded configuration's
build genuinely does not contain the real implementation's bytecode.

A doctor-detection marker exists on both platforms, compiled only into the real
implementation and never into the excluded/no-op counterpart: `AppductCoreMarker` (an
`@objc` class, iOS) and `AppductNativeMarker` (Android) — `doctor`'s presence verdict is
decided by that marker alone on both platforms, never by a package/class name or a
manifest/plist key that a no-op build shares with the real one.
**Always run `appduct doctor --assert-absent` against the actual signed artifact you are
about to ship** — a `Release`/`release` configuration by name, or a dependency/build-setting
combination you believe excludes the real implementation, is what's supposed to produce that
outcome, not a guarantee of it; `doctor` checks the artifact itself, which is the only thing
that matters to an app-store reviewer or an attacker. This applies identically whether the
artifact is the vendored RN copy's build or a plain native app's own `Release`/`release`
build of `packages/native`.

## Related

- [`SECURITY.md`](SECURITY.md) — trust modes, pins, and the threat model
- [`ARCHITECTURE.md`](ARCHITECTURE.md#11-react-native-sdk) — SDK entry points and client behavior
- [`@appduct/react-native` README](../packages/react-native/README.md) — getting started and API reference
- [`packages/native/README.md`](../packages/native/README.md) — the native core's consumer entry points
