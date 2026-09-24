/**
 * Deep-link scheme resolution (ARCHITECTURE.md §10, issue #29).
 *
 * A scheme is needed to compose `<scheme>:///?appduct=<payload>` in `appduct sessions link`,
 * `appduct/client`'s `link()` and the MCP `appduct_connect` tool. Before this module the only
 * source was `<state-dir>/config.json` — a single global file, which meant two apps with different
 * schemes on one machine required hand-editing it on every switch.
 *
 * The resolution order below is shared by every one of those callers so it cannot drift, first
 * match wins:
 *
 *   1. an explicit flag/option (`--scheme`)
 *   2. the `APPDUCT_SCHEME` environment variable
 *   3. the nearest `.appduct/config.json` that declares a `scheme`, walking up from the working
 *      directory (never `~/.appduct` or the state dir in use — see {@link findProjectConfigs};
 *      a project config without a `scheme` key does not stop the walk)
 *   4. `scheme` in the state directory's `config.json` (the pre-#29 behaviour)
 *   5. a static-file project probe, tried in this order (no walk-up — an app root is where you
 *      run these commands), with {@link discoverStaticProjectScheme} owning the whole step:
 *      a. `<cwd>/app.json`'s `expo.scheme` (the pre-#48 behaviour, unchanged)
 *      b. Android: `app/build.gradle(.kts)`'s `appductScheme` manifest placeholder, then
 *         `app/src/main/AndroidManifest.xml`'s first `<data android:scheme>` in a `VIEW`
 *         intent filter
 *      c. iOS: any `Info.plist` up to two levels deep (excluding `Pods`/`build`/`node_modules`/
 *         `DerivedData`) for the first `CFBundleURLSchemes` entry, then xcodegen's `project.yml`
 *         for the same key — see `native-scheme.ts`, which owns 5b/5c and never guesses when two
 *         of them disagree (throws instead, naming both)
 *
 * Nothing here executes project code: `app.config.js`/`app.config.ts` are deliberately *not*
 * evaluated (running arbitrary project JS to read one string is a much larger blast radius than
 * this feature warrants), and neither is `xcodebuild`/`plutil`/a Gradle evaluation for the native
 * probes added in issue #48 — every one of them is a plain, defensively-parsed read of a static
 * project file (`native-scheme.ts`'s doc comment has the detail). Dynamic-config projects use
 * `--scheme`, `APPDUCT_SCHEME`, or a project `.appduct/config.json` instead.
 *
 * A project `.appduct/config.json` carries client-side keys only — `scheme` and, since issue #63,
 * `appId.<platform>` (see {@link resolveAppId} below, which mirrors this module's shape but with a
 * shorter order: no environment-variable tier and no filesystem-discovery tier). It never
 * redirects the state directory — `--state-dir` / `APPDUCT_STATE_DIR` remain the only way to do
 * that — so a project file can never move the daemon's key, socket or audit log.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { usageError } from "./errors.js";
import { discoverNativeScheme, type NativeSchemeSource } from "./native-scheme.js";

/** The directory a project-level config lives in, relative to an app root. */
export const PROJECT_CONFIG_DIR = ".appduct";

/** The project-level config filename, inside {@link PROJECT_CONFIG_DIR}. */
export const PROJECT_CONFIG_FILENAME = "config.json";

/** Relative path used in messages/docs: `.appduct/config.json`. */
export const PROJECT_CONFIG_RELATIVE_PATH = join(PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);

/** The Expo app manifest discovery reads. Only static JSON — see this module's doc comment. */
export const APP_JSON_FILENAME = "app.json";

export const SCHEME_ENV_VAR = "APPDUCT_SCHEME";

/**
 * RFC 3986 §3.1 scheme grammar: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`.
 *
 * Enforced so a value like `"myapp://"` (a very natural thing to paste into `--scheme`) fails with
 * a message naming the offending source instead of silently composing the unopenable
 * `myapp://:///?appduct=…`.
 */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*$/u;

export const isValidScheme = (value: string): boolean => SCHEME_PATTERN.test(value);

/** Which step of the order above produced the scheme. The four `NativeSchemeSource` values are
 * step 5's native-project probes (`native-scheme.ts`); `"app-json"` is step 5's original,
 * unchanged probe. */
export type SchemeSource =
  | "flag"
  | "env"
  | "project-config"
  | "state-config"
  | "app-json"
  | NativeSchemeSource;

export type ResolvedScheme = {
  /** Undefined when no source produced one; `tried` then explains where we looked. */
  scheme?: string;
  source?: SchemeSource;
  /** Human-readable descriptions of every location consulted, in order, for error messages. */
  tried: string[];
};

const requireValidScheme = (value: string, origin: string): string => {
  if (!isValidScheme(value)) {
    throw usageError(
      `Invalid deep-link scheme ${JSON.stringify(value)} from ${origin}: a scheme must start with ` +
        'a letter and contain only letters, digits, "+", "-" or "." (for example "myapp") — do not ' +
        'include "://".',
    );
  }

  return value;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/** Reads and JSON-parses a file; `undefined` when it does not exist. Other I/O errors propagate. */
const readJsonFile = async (path: string): Promise<{ raw: unknown } | undefined> => {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    // A `.appduct` that is a file, or an `app.json` that is a directory, is "nothing usable
    // here" rather than a hard failure — the caller falls through to the next source.
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      return undefined;
    }

    throw error;
  }

  try {
    return { raw: JSON.parse(text) as unknown };
  } catch (error) {
    throw usageError(`Could not parse ${path}: ${(error as Error).message}`);
  }
};

/**
 * Normalizes Expo's `scheme` field, which is either a single string or an array of them. Mirrors
 * `packages/react-native/app.plugin.js`'s `configuredSchemes` so the CLI and the config plugin
 * agree on what "the app's scheme" means; the first entry wins for an array.
 *
 * Exported so {@link ../native-scheme.js} can apply the same "string, or first non-empty entry of
 * an array" rule to `CFBundleURLSchemes` (`Info.plist`/`project.yml`) — the shape is identical.
 */
export const firstConfiguredScheme = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }

  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Reads `<dir>/app.json`'s `expo.scheme`. Returns `undefined` when the file is missing, is not a
 * JSON object, has no `expo` object, or declares no usable scheme — every one of which just means
 * "discovery found nothing here". A *malformed* `app.json` throws, because silently ignoring a
 * syntax error in the file the user is pointing us at reads as "Appduct ignored my config".
 */
export const discoverExpoScheme = async (dir: string): Promise<string | undefined> => {
  const path = join(resolve(dir), APP_JSON_FILENAME);
  const file = await readJsonFile(path);

  if (!file || !isPlainObject(file.raw)) {
    return undefined;
  }

  const expo = file.raw.expo;

  if (!isPlainObject(expo)) {
    return undefined;
  }

  const scheme = firstConfiguredScheme(expo.scheme);

  return scheme === undefined ? undefined : requireValidScheme(scheme, `"expo.scheme" in ${path}`);
};

export type StaticProjectSchemeDiscovery = {
  /** `undefined` when nothing in this step resolved a scheme. */
  scheme?: string;
  source?: "app-json" | NativeSchemeSource;
  /** The human-readable location `scheme` was actually read from (a path, plus what was read from
   * it) — distinct from `tried` below, which lists every location whether or not it hit. Only set
   * alongside `scheme`. */
  origin?: string;
  /** Every location this step consulted, in order: `app.json` first (unchanged from pre-#48), then
   * every `native-scheme.ts` probe — always present, hit or miss, one entry each. */
  tried: string[];
};

/**
 * Step 5 of {@link resolveScheme} in full: `<cwd>/app.json` first (unchanged), then the native
 * Android/iOS project probes from `native-scheme.ts`. Exported as its own step — not inlined into
 * `resolveScheme` — because `appduct init` (`commands/init.ts`) runs exactly this same
 * discovery on its own, deliberately skipping steps 1-4 (see that file's doc comment for why): the
 * two must never disagree about what "discovery" means for the tail of the precedence order, or
 * `init` could write a scheme `resolveScheme` would never have found on its own.
 */
export const discoverStaticProjectScheme = async (cwd: string): Promise<StaticProjectSchemeDiscovery> => {
  const appJsonPath = join(resolve(cwd), APP_JSON_FILENAME);
  const tried = [`${appJsonPath} ("expo.scheme")`];
  const appJsonScheme = await discoverExpoScheme(cwd);

  if (appJsonScheme !== undefined) {
    return { scheme: appJsonScheme, source: "app-json", origin: appJsonPath, tried };
  }

  const native = await discoverNativeScheme(resolve(cwd));
  tried.push(...native.tried);

  if (native.result !== undefined) {
    return {
      scheme: native.result.scheme,
      source: native.result.source,
      origin: native.result.origin,
      tried,
    };
  }

  return { tried };
};

export type ProjectConfigLookupOptions = {
  /** The state dir actually in use, so the walk can never mistake it for a project config. */
  stateDirRoot?: string;
  /** The home directory whose `.appduct` is the *default* state dir. Injectable so tests can
   * point it at a temp tree instead of the real `$HOME`; defaults to `os.homedir()`. */
  homeDir?: string;
};

/**
 * The `.appduct` directories that are *global* state, never a project's own config.
 *
 * Shared by the walk-up (which must not read them at the project tier) and `appduct init`
 * (which must not *write* into them: it would drop a config next to the daemon's `key.pem` and
 * call it safe to commit), so the two can never disagree about which directory is which.
 */
export const globalConfigDirs = (options: ProjectConfigLookupOptions = {}): Set<string> => {
  const excluded = new Set([join(resolve(options.homeDir ?? homedir()), PROJECT_CONFIG_DIR)]);

  if (options.stateDirRoot !== undefined) {
    excluded.add(resolve(options.stateDirRoot));
  }

  return excluded;
};

/**
 * Every `<dir>/.appduct/config.json` on the path from `startDir` up to the filesystem root,
 * nearest first.
 *
 * The walk terminates at the root (`dirname("/") === "/"`, and likewise for a Windows drive root)
 * — it cannot escape above it, and it never follows `..` out of a caller-supplied path because
 * every candidate is derived from the resolved absolute `startDir`.
 *
 * Two directories are never treated as a project root, because a hit there would silently apply a
 * *global* file at the project tier — one step above the state dir's own config, inverting the
 * documented precedence:
 *
 * - `<homeDir>/.appduct`, the default state dir. Essentially every project lives somewhere under
 *   the home directory, so without this a plain `appduct sessions link` in any repo would pick up the
 *   global `config.json` as if it were the project's — and with `--state-dir` pointing elsewhere it
 *   would shadow the state dir the operator explicitly chose.
 * - `stateDirRoot`, the state dir actually in use, for the same reason when it is not the default.
 */
export const findProjectConfigs = (
  startDir: string,
  options: ProjectConfigLookupOptions = {},
): string[] => {
  const excluded = globalConfigDirs(options);
  const found: string[] = [];
  let dir = resolve(startDir);

  for (;;) {
    const projectDir = join(dir, PROJECT_CONFIG_DIR);

    if (!excluded.has(projectDir)) {
      const candidate = join(projectDir, PROJECT_CONFIG_FILENAME);

      if (existsSync(candidate)) {
        found.push(candidate);
      }
    }

    const parent = dirname(dir);

    if (parent === dir) {
      return found;
    }

    dir = parent;
  }
};

/** The nearest project config on the path from `startDir` upwards, if any. */
export const findProjectConfig = (
  startDir: string,
  options: ProjectConfigLookupOptions = {},
): string | undefined => {
  return findProjectConfigs(startDir, options)[0];
};

/**
 * Reads the `scheme` key out of a project `.appduct/config.json`. Unlike `app.json` this *is*
 * Appduct's own file, so anything wrong with it (not an object, `scheme` not a non-empty
 * string) is a hard error rather than a silent fall-through — a typo here must not quietly
 * degrade to a different scheme from a lower-precedence source.
 *
 * Keys other than `scheme` are ignored: a project file is client-side settings only, and
 * accepting (say) `keyPath` here would let a checked-in file redirect the daemon's key material.
 */
export const readProjectConfigScheme = async (path: string): Promise<string | undefined> => {
  const file = await readJsonFile(path);

  if (!file) {
    return undefined;
  }

  if (!isPlainObject(file.raw)) {
    throw usageError(`Invalid Appduct project config at ${path}: must be a JSON object.`);
  }

  const scheme = file.raw.scheme;

  if (scheme === undefined) {
    return undefined;
  }

  if (typeof scheme !== "string" || scheme.length === 0) {
    throw usageError(
      `Invalid Appduct project config at ${path}: "scheme" must be a non-empty string.`,
    );
  }

  return requireValidScheme(scheme, `"scheme" in ${path}`);
};

/** A target's platform, and the key it reads under `appId` in a project config — `"ios"` for
 * `ios-device`, `"android"` for `android`. See `cli/open-target.ts`'s `platformOf`, the single
 * place a delivery target is mapped to one of these. */
export type AppIdPlatform = "ios" | "android";

const APP_ID_PLATFORMS: ReadonlySet<string> = new Set<AppIdPlatform>(["ios", "android"]);

/**
 * Reads `appId.<platform>` out of a project `.appduct/config.json`. Same stance as
 * {@link readProjectConfigScheme}: this is Appduct's own file, so anything wrong with the `appId`
 * block is a hard error rather than a silent fall-through, including an unknown key inside it — a
 * typo'd `"andriod"` must read as "this file is broken", not as "no Android app id was recorded",
 * which would otherwise look exactly like a project that simply hasn't set one up yet.
 *
 * Deliberately does *not* apply `cli/open-target.ts`'s `isValidAppId` charset check here: that
 * check guards an argv/remote-shell hazard at the point a value is actually used, the same
 * arrangement the old `iosBundleId` config key had. A structurally well-formed but wrong-for-its-
 * platform id is caught there instead, with the command that needed it named in the error.
 */
export const readProjectConfigAppId = async (
  path: string,
  platform: AppIdPlatform,
): Promise<string | undefined> => {
  const file = await readJsonFile(path);

  if (!file) {
    return undefined;
  }

  if (!isPlainObject(file.raw)) {
    throw usageError(`Invalid Appduct project config at ${path}: must be a JSON object.`);
  }

  const appId = file.raw.appId;

  if (appId === undefined) {
    return undefined;
  }

  if (!isPlainObject(appId)) {
    throw usageError(
      `Invalid Appduct project config at ${path}: "appId" must be an object with "ios" and/or ` +
        '"android" keys.',
    );
  }

  for (const key of Object.keys(appId)) {
    if (!APP_ID_PLATFORMS.has(key)) {
      throw usageError(
        `Invalid Appduct project config at ${path}: unknown key "appId.${key}" (expected "ios" ` +
          'and/or "android").',
      );
    }
  }

  const value = appId[platform];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw usageError(
      `Invalid Appduct project config at ${path}: "appId.${platform}" must be a non-empty string.`,
    );
  }

  return value;
};

export type ResolveSchemeOptions = {
  /** `--scheme` (or a programmatic `scheme` option) — highest precedence. */
  flagScheme?: string;
  /**
   * The environment `APPDUCT_SCHEME` is read from. Defaults to `process.env`.
   *
   * Deliberately separate from the environment callers hand to `adb`/`simctl`: those callers
   * narrow that env on purpose, and reusing it here would silently drop a `APPDUCT_SCHEME` the
   * user really had exported.
   */
  env?: NodeJS.ProcessEnv;
  /** Where the project walk-up and `app.json` discovery start. Defaults to `process.cwd()`. */
  cwd?: string;
  /** `scheme` already loaded from the state directory's `config.json`. */
  configScheme?: string;
  /** The state directory's `config.json` path, named in `tried` (and used to skip it in the walk-up). */
  stateConfigPath?: string;
  /** The state directory root, so the walk-up never mistakes it for a project config. */
  stateDirRoot?: string;
  /** Overrides the home directory whose `.appduct` the walk-up skips (tests point this at a
   * temp tree rather than the real `$HOME`). */
  homeDir?: string;
};

/**
 * Resolves the deep-link scheme against the documented order, reporting both the winner and every
 * location consulted so callers can render an error that says where to put one.
 */
export const resolveScheme = async (options: ResolveSchemeOptions = {}): Promise<ResolvedScheme> => {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const tried: string[] = [];

  tried.push("the --scheme flag");

  if (options.flagScheme !== undefined && options.flagScheme.length > 0) {
    return {
      scheme: requireValidScheme(options.flagScheme, "the --scheme flag"),
      source: "flag",
      tried,
    };
  }

  tried.push(`the ${SCHEME_ENV_VAR} environment variable`);

  const envScheme = env[SCHEME_ENV_VAR];

  if (typeof envScheme === "string" && envScheme.length > 0) {
    return {
      scheme: requireValidScheme(envScheme, `the ${SCHEME_ENV_VAR} environment variable`),
      source: "env",
      tried,
    };
  }

  // Every project config on the way up, not just the nearest: one that exists but declares no
  // `scheme` (a future version's file holding some other client-side key, say) is not an answer,
  // so the walk continues past it rather than treating its silence as "no project scheme".
  const projectConfigPaths = findProjectConfigs(cwd, {
    stateDirRoot: options.stateDirRoot,
    homeDir: options.homeDir,
  });

  tried.push(
    projectConfigPaths.length === 0
      ? `${PROJECT_CONFIG_RELATIVE_PATH} (searched upwards from ${cwd})`
      : projectConfigPaths.join(", "),
  );

  for (const projectConfigPath of projectConfigPaths) {
    const projectScheme = await readProjectConfigScheme(projectConfigPath);

    if (projectScheme !== undefined) {
      return { scheme: projectScheme, source: "project-config", tried };
    }
  }

  tried.push(
    options.stateConfigPath === undefined
      ? 'the state directory\'s config.json ("scheme")'
      : `${options.stateConfigPath} ("scheme")`,
  );

  if (options.configScheme !== undefined && options.configScheme.length > 0) {
    return {
      scheme: requireValidScheme(
        options.configScheme,
        options.stateConfigPath === undefined
          ? 'the state directory\'s config.json "scheme"'
          : `"scheme" in ${options.stateConfigPath}`,
      ),
      source: "state-config",
      tried,
    };
  }

  const discovered = await discoverStaticProjectScheme(cwd);
  tried.push(...discovered.tried);

  if (discovered.scheme !== undefined) {
    return { scheme: discovered.scheme, source: discovered.source, tried };
  }

  return { tried };
};

/**
 * The shared "no scheme anywhere" message. Every caller renders the same body so the locations
 * listed (and the fixes suggested) can't drift between `appduct sessions link`, `appduct mcp` and
 * `appduct_connect`.
 */
export const describeMissingScheme = (tried: string[]): string => {
  const locations =
    tried.length === 0
      ? ""
      : `Looked in, in order:\n${tried
          .map((location, index) => `  ${index + 1}. ${location}`)
          .join("\n")}\n`;

  return (
    "A deep-link scheme is required to compose the link, and none was found. " +
    locations +
    `Set one with --scheme <scheme>, ${SCHEME_ENV_VAR}=<scheme>, "expo.scheme" in ${APP_JSON_FILENAME}, ` +
    `or run \`appduct init\` in your app root to write ${PROJECT_CONFIG_RELATIVE_PATH}.`
  );
};

/** {@link resolveScheme}, throwing {@link usageError} with {@link describeMissingScheme} when nothing matched. */
export const resolveSchemeOrThrow = async (options: ResolveSchemeOptions = {}): Promise<string> => {
  const resolved = await resolveScheme(options);

  if (resolved.scheme === undefined) {
    throw usageError(describeMissingScheme(resolved.tried));
  }

  return resolved.scheme;
};

/** Which step of {@link resolveAppId}'s order produced the app id. */
export type AppIdSource = "flag" | "project-config";

export type ResolvedAppId = {
  /** Undefined when no source produced one; `tried` then explains where we looked. */
  appId?: string;
  source?: AppIdSource;
  /** Human-readable descriptions of every location consulted, in order, for error messages. */
  tried: string[];
};

export type ResolveAppIdOptions = {
  /** Which `appId.<platform>` key to read from a project config; see `cli/open-target.ts`'s
   * `platformOf`. */
  platform: AppIdPlatform;
  /** `--app-id` (CLI `link`) / `appId` (MCP `appduct_connect`) / `appId` (`mintLink`, the
   * `appduct/client` `link()`) — highest precedence, because the target is known at the call
   * site. */
  flagAppId?: string;
  /** Where the project walk-up starts. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The state directory root, so the walk-up never mistakes it for a project config. */
  stateDirRoot?: string;
  /** Overrides the home directory whose `.appduct` the walk-up skips (tests point this at a
   * temp tree rather than the real `$HOME`). */
  homeDir?: string;
};

/**
 * Resolves an app id against the order the contract fixes: an explicit value first, then the
 * nearest project `.appduct/config.json` declaring `appId.<platform>` (the same walk-up
 * {@link resolveScheme} uses, via {@link findProjectConfigs}). Unlike {@link resolveScheme} there
 * is no environment-variable tier and no filesystem-discovery tier (issue #63 leaves static
 * discovery of an app id from `build.gradle`/`app.json` out of scope) — an app id that cannot be
 * found either way is a plain usage error, not something worth guessing at.
 */
export const resolveAppId = async (options: ResolveAppIdOptions): Promise<ResolvedAppId> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const tried: string[] = [];

  tried.push("the --app-id flag");

  if (options.flagAppId !== undefined && options.flagAppId.length > 0) {
    return { appId: options.flagAppId, source: "flag", tried };
  }

  const projectConfigPaths = findProjectConfigs(cwd, {
    stateDirRoot: options.stateDirRoot,
    homeDir: options.homeDir,
  });

  tried.push(
    projectConfigPaths.length === 0
      ? `${PROJECT_CONFIG_RELATIVE_PATH} (searched upwards from ${cwd})`
      : projectConfigPaths.join(", "),
  );

  for (const projectConfigPath of projectConfigPaths) {
    const projectAppId = await readProjectConfigAppId(projectConfigPath, options.platform);

    if (projectAppId !== undefined) {
      return { appId: projectAppId, source: "project-config", tried };
    }
  }

  return { tried };
};

/**
 * The shared "no app id anywhere" message (issue #63). Every caller renders the same body — the
 * CLI's `--app-id` guard, `mintLink`, and `appduct_connect` — so the three fixes it names (the
 * flag, the MCP argument, and the project config `appduct init` writes) cannot drift between them.
 */
export const describeMissingAppId = (platform: AppIdPlatform, tried: string[]): string => {
  const locations =
    tried.length === 0
      ? ""
      : `Looked in, in order:\n${tried
          .map((location, index) => `  ${index + 1}. ${location}`)
          .join("\n")}\n`;

  const platformLabel = platform === "android" ? "Android" : "a physical iPhone/iPad";
  const initFlag = platform === "android" ? "--android-app-id" : "--ios-app-id";

  return (
    `Delivering to ${platformLabel} needs the installed app's id, and none was found. ${locations}` +
    `Set one with \`appduct init ${initFlag} <id>\`, --app-id <id>, or "appId.${platform}" in ` +
    `${PROJECT_CONFIG_RELATIVE_PATH}.`
  );
};
