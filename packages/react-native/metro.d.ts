/**
 * Hand-written type declaration for `metro.js` (see that file's doc comment for why it's plain
 * CommonJS rather than a `tsc`-built `.ts` source). Metro's own config type lives in
 * `metro-config`, an optional dependency of `expo`/`react-native`, not this package -- typed as
 * `Record<string, unknown>` here rather than adding that dependency just for a type.
 */

export interface WithAppductOptions {
  /**
   * `true` leaves Metro's module resolution untouched; `false` redirects every specifier this
   * package exposes as a real JS entry point to `@appduct/react-native/noop`. Omitted, it
   * follows `APPDUCT_ENABLED` (via `autolink-env.js`, where unset counts as enabled) — the same
   * variable that drives native autolinking, so one pipeline variable strips both surfaces. The
   * config plugin's `include` option is gone; an explicit value here is for apps keying the JS
   * strip off their own predicate.
   */
  include?: boolean;
}

/**
 * Wraps a Metro config so that, when Appduct is excluded (`options.include` is `false`, or it is
 * omitted and `APPDUCT_ENABLED` is falsy), imports of
 * `@appduct/react-native` (and any other entry point this package exports) resolve to the
 * inert `/noop` entry instead. Chains to `config.resolver.resolveRequest` if already set, rather
 * than replacing it -- call this last, after anything else that sets `resolveRequest`. See
 * `docs/BUILD-VARIANTS.md`'s "Compiling Appduct out of production builds" section.
 */
export function withAppduct<TConfig extends Record<string, unknown>>(
  config: TConfig,
  options?: WithAppductOptions,
): TConfig;
