/**
 * `@appduct/react-native/metro` — the JS half of stripping Appduct from a bundle. Plain CommonJS at
 * the package root, like `app.plugin.js`, so it stays `require`-able from a Node-run
 * `metro.config.js` without routing through the `tsc` build that produces `build/` for the RN
 * runtime.
 *
 * The native half — whether the Appduct pod/module is compiled in at all — is decided by
 * autolinking, not by this file. Neither half alone removes both; see
 * https://callstackincubator.github.io/appduct/guides/build-variants/#strip-appducts-javascript-too.
 */
const { isAppductAutolinkEnabled } = require("./autolink-env");

const PACKAGE_NAME = "@appduct/react-native";

/** The specifier every redirected import gets rewritten to. Never itself redirected. */
const NOOP_SPECIFIER = `${PACKAGE_NAME}/noop`;

/**
 * `exports` subpaths that are package *infrastructure* -- consumed by tooling (npm, Node's own
 * `exports` resolution, Expo's config-plugin loader, this very file), never `import`ed/`require`d
 * as application JS at runtime -- and therefore never candidates for redirection regardless of
 * whether their value happens to be a string or a conditions object. Kept as a short, explicit
 * denylist (rather than guessing from shape) so a *real* entry point can safely use either
 * `exports` form -- a subpath mapped straight to a string (`"./polyfill": "./build/polyfill.js"`)
 * is just as much a JS module as one behind a conditions object, and both must be covered.
 */
const NON_MODULE_SUBPATHS = new Set([
  "./package.json",
  "./app.plugin.js",
  "./autolink-env.js",
  "./metro",
]);

/**
 * Turns an `exports` subpath key (`"."`, `"./auto"`, ...) into the specifier apps actually
 * `import`/`require` (`"@appduct/react-native"`, `"@appduct/react-native/auto"`, ...).
 */
function specifierForSubpath(subpath) {
  return subpath === "." ? PACKAGE_NAME : `${PACKAGE_NAME}/${subpath.slice(2)}`;
}

/**
 * Derives the list of specifiers that should redirect to `/noop` when Appduct is excluded,
 * from the package's own `exports` map rather than a hardcoded `["." , "/auto"]` list — so a
 * future entry point is covered automatically instead of silently falling through the crack this
 * task exists to close. Exported separately from `withAppduct` so it can be unit-tested
 * against a fabricated `exports` map (see `src/__tests__/metro.test.ts`) without needing a real
 * `require("./package.json")` round-trip.
 *
 * Every subpath is a candidate unless it's in `NON_MODULE_SUBPATHS` (package infrastructure, not
 * an application JS entry point) or redirects to `/noop` itself. This intentionally does *not*
 * key off whether the `exports` value is a string vs. a conditions object -- both are valid ways
 * to declare a real JS module entry point, and treating only conditions-object subpaths as
 * "real" would silently miss a future entry declared with the string form.
 */
function deriveRedirectSpecifiers(exportsField) {
  const specifiers = [];
  for (const subpath of Object.keys(exportsField || {})) {
    if (NON_MODULE_SUBPATHS.has(subpath)) {
      continue;
    }
    const specifier = specifierForSubpath(subpath);
    if (specifier === NOOP_SPECIFIER) {
      continue;
    }
    specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * `@appduct/web` hands out its real entry only under the `development` export condition, and
 * Metro never sets that condition. A development web bundle gets it here, so the page connects;
 * a production web bundle does not, and keeps the inert entry.
 */
function withWebDevelopment(context, moduleName, platform) {
  const isWeb =
    moduleName === "#appduct-web" ||
    moduleName === "@appduct/web" ||
    moduleName.startsWith("@appduct/web/");
  if (
    platform !== "web" ||
    !context.dev ||
    !isWeb ||
    !Array.isArray(context.unstable_conditionNames)
  ) {
    return context;
  }
  return {
    ...context,
    unstable_conditionNames: [...context.unstable_conditionNames, "development"],
  };
}

/**
 * `withAppduct(config, options?)` — wraps a Metro `config` so that, when Appduct is excluded,
 * every specifier derived from this package's `exports` (see `deriveRedirectSpecifiers`) resolves
 * to `@appduct/react-native/noop` instead, stripping the deep-link listener, tool registry, and
 * client state machine from the bundle. With no `include` option it reads `APPDUCT_ENABLED`,
 * the same variable that drives native autolinking, so one pipeline variable strips both surfaces.
 *
 * Composition: the single most important behavior here. A caller's existing
 * `config.resolver.resolveRequest` (the playground has one, for workspace symlink dedup) is
 * captured and chained to for *every* specifier, redirected or not — never replaced, and never
 * called twice for the same resolution. When no existing resolver is set, falls back to
 * `context.resolveRequest`, matching Metro's own default-resolver convention.
 *
 * **Call this last**, after anything else that sets `config.resolver.resolveRequest` (see
 * https://callstackincubator.github.io/appduct/guides/build-variants/#strip-appducts-javascript-too). The existing
 * resolver is captured by reference at call time, not read lazily, so
 * `config.resolver.resolveRequest = myResolver` *after* `withAppduct` silently discards the
 * strip rather than erroring — there is no way to detect that misordering from in here, since a
 * later assignment to the returned config object is invisible to this function.
 */
function withAppduct(config, options) {
  // Defaults to the same `APPDUCT_ENABLED` reading that drives native autolinking, so one
  // pipeline variable strips both surfaces. An explicit `include` still wins, for apps keying the
  // JS strip off their own predicate.
  const include =
    options && options.include !== undefined
      ? options.include
      : isAppductAutolinkEnabled();
  const redirectSpecifiers = new Set(
    include ? [] : deriveRedirectSpecifiers(require("./package.json").exports),
  );
  const existingResolveRequest =
    config.resolver && config.resolver.resolveRequest;

  const resolveRequest = (context, moduleName, platform) => {
    const resolveNext = existingResolveRequest || context.resolveRequest;
    const target = redirectSpecifiers.has(moduleName)
      ? NOOP_SPECIFIER
      : moduleName;
    return resolveNext(withWebDevelopment(context, target, platform), target, platform);
  };

  return {
    ...config,
    resolver: {
      ...config.resolver,
      resolveRequest,
    },
  };
}

module.exports = {
  withAppduct,
  // Exposed for unit testing (`src/__tests__/metro.test.ts`) and only that -- not part of the
  // documented public API.
  __testables: {
    deriveRedirectSpecifiers,
    specifierForSubpath,
    NOOP_SPECIFIER,
    PACKAGE_NAME,
  },
};
