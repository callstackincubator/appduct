/**
 * `appduct init` (issue #29): the one command that takes an app root from "package installed"
 * to "an agent can connect".
 *
 * It writes a *project-level* `.appduct/config.json` holding the deep-link scheme, and returns
 * the two things that are not discoverable from the filesystem: the MCP server entry to paste into
 * an agent's config, and the `import "@appduct/react-native/auto"` reminder the app needs.
 *
 * What it deliberately does **not** do:
 *
 * - It never generates or touches key material. The daemon auto-generates a host key at startup
 *   (`daemon/tls.ts`), so making `init` a key-generating step would re-introduce exactly the
 *   "run keygen, paste a pin" ceremony this command exists to remove. `appduct keygen` remains
 *   for explicit rotation/provisioning.
 * - It never writes daemon-side settings (`wssPort`, `keyPath`, `policy`, ...), and the project
 *   file is never *read* for them either (`scheme.ts`). A project config that could redirect
 *   `keyPath` would mean a file checked into a repo could move another developer's private key.
 * - It never starts, stops or contacts the daemon.
 *
 * Idempotency (issue #29's acceptance criterion): re-running with the same scheme is a no-op that
 * still prints the snippet, a *different* scheme is refused unless `--force`, and `--force` merges
 * into the existing JSON rather than truncating it, so a key a future version adds is not silently
 * dropped by an old binary.
 *
 * **`init` is not the resolver.** It considers exactly two *kinds* of source — `--scheme`, and
 * whatever {@link discoverStaticProjectScheme} finds on disk (`<cwd>/app.json`, then the native
 * Android/iOS probes from `native-scheme.ts`) — plus whatever this very file already records. It
 * deliberately does *not* consult `APPDUCT_SCHEME` or walk up for a parent
 * `.appduct/config.json`, because its job is to decide what to *write here*, and inheriting
 * either would bake an ambient value into a committed file: a shell variable that happened to be
 * exported, or a parent project's scheme silently copied into a sub-package. `scheme.ts`'s full
 * precedence chain is what *reads* the result. Discovery is shared with that chain's own final
 * step via {@link discoverStaticProjectScheme} specifically so the two can never disagree about
 * what "discovery" means. `InitCommandData.source` names every origin this command itself can
 * produce.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { CliResult, InitCommandData } from "../cli/result-types.js";
import { usageError } from "../errors.js";
import {
  discoverStaticProjectScheme,
  globalConfigDirs,
  isValidScheme,
  PROJECT_CONFIG_DIR,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_RELATIVE_PATH,
  SCHEME_ENV_VAR,
} from "../scheme.js";

export type InitCommandOptions = {
  scheme?: string;
  force?: boolean;
};

export type InitCommandContext = {
  /** The app root to initialize. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The active state directory, so `init` can refuse to write its project config into it. */
  stateDir?: string;
  /** Overrides the home directory whose `.appduct` is the default state dir (tests). */
  homeDir?: string;
};

const readExistingConfig = async (path: string): Promise<Record<string, unknown> | undefined> => {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return undefined;
    }

    // `.appduct` is a regular file (ENOTDIR), or `config.json` is a directory (EISDIR). Both
    // are things a person did to their own project, so they get a usage error naming the path —
    // not a raw errno from `readFile` rendered as an internal failure.
    if (code === "ENOTDIR") {
      throw usageError(
        `Cannot write ${path}: a file already exists where the "${PROJECT_CONFIG_DIR}" directory ` +
          "needs to go. Remove or rename it, then re-run `appduct init`.",
      );
    }

    if (code === "EISDIR") {
      throw usageError(
        `Cannot write ${path}: it is a directory, not a file. Remove it, then re-run \`appduct init\`.`,
      );
    }

    throw error;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw usageError(
      `Could not parse the existing ${path}: ${(error as Error).message}. Fix or delete it, then re-run \`appduct init\`.`,
    );
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw usageError(
      `The existing ${path} is not a JSON object. Fix or delete it, then re-run \`appduct init\`.`,
    );
  }

  return raw as Record<string, unknown>;
};

/**
 * The `scheme` already recorded in the project config.
 *
 * A hand-edited `"scheme": "myapp://"` must not be adopted and echoed back into `mcpServerEntry`
 * as though it were usable — every consumer of that entry would compose an unopenable link, and
 * `appduct link` would reject the very value `init` just blessed.
 *
 * But it is only fatal when the run would go on to *keep* that value: `replaceable` says a
 * `--scheme` or `--force` is about to overwrite it anyway, and refusing then would make the
 * error's own suggested remedy reproduce the error.
 */
const readExistingScheme = (
  existing: Record<string, unknown> | undefined,
  path: string,
  replaceable: boolean,
): string | undefined => {
  const scheme = existing?.scheme;

  if (scheme === undefined) {
    return undefined;
  }

  if (typeof scheme !== "string" || !isValidScheme(scheme)) {
    if (replaceable) {
      return undefined;
    }

    throw usageError(
      `${path} records an invalid deep-link scheme ${JSON.stringify(scheme)}: a scheme must start ` +
        'with a letter and contain only letters, digits, "+", "-" or "." (for example "myapp") — ' +
        'do not include "://". Fix it, or re-run with `--scheme <scheme> --force` to replace it.',
    );
  }

  return scheme;
};

export const handleInitCommand = async (
  options: InitCommandOptions,
  context: InitCommandContext = {},
): Promise<CliResult<InitCommandData>> => {
  const root = resolve(context.cwd ?? process.cwd());
  const projectDir = join(root, PROJECT_CONFIG_DIR);
  const configPath = join(projectDir, PROJECT_CONFIG_FILENAME);

  // Run from `$HOME` (or from the parent of a `APPDUCT_STATE_DIR`), `<cwd>/.appduct` *is*
  // the daemon's state directory. Writing there would drop a config beside `key.pem` and the
  // audit log and then tell the user it is safe to commit. The same exclusion the walk-up uses
  // decides this, so "which directory is global state" has exactly one answer in the codebase.
  if (
    globalConfigDirs({ stateDirRoot: context.stateDir, homeDir: context.homeDir }).has(projectDir)
  ) {
    throw usageError(
      `Refusing to write ${configPath}: that is Appduct's own state directory (it holds the ` +
        "daemon's private key and audit log), not a project config. Run `appduct init` from " +
        "your app's root directory instead.",
    );
  }

  if (options.scheme !== undefined && !isValidScheme(options.scheme)) {
    throw usageError(
      `Invalid deep-link scheme ${JSON.stringify(options.scheme)} from --scheme: a scheme must ` +
        'start with a letter and contain only letters, digits, "+", "-" or "." (for example ' +
        '"myapp") — do not include "://".',
    );
  }

  const existing = await readExistingConfig(configPath);
  // A `--scheme` or a `--force` is about to overwrite whatever is recorded, so a garbage value
  // there is not worth failing over — and failing would make this error's own remedy unusable.
  const existingScheme = readExistingScheme(
    existing,
    configPath,
    options.force === true || options.scheme !== undefined,
  );
  // Same discovery `resolveScheme`'s own last step runs (app.json, then the native Android/iOS
  // probes) — never APPDUCT_SCHEME, never a walk-up, per this file's doc comment. `discovered`
  // throws on its own for a malformed value or two native probes disagreeing, exactly as it would
  // for `resolveScheme`.
  const discovered = await discoverStaticProjectScheme(root);
  const discoveredScheme = discovered.scheme;
  const discoveredSourceLabel: InitCommandData["source"] | undefined =
    discovered.source === undefined
      ? undefined
      : discovered.source === "app-json"
        ? "app.json"
        : discovered.source;

  /*
   * Which scheme wins, and when that is an error, is the whole idempotency contract:
   *
   * - `--scheme` always wins, but replacing a *different* recorded scheme needs `--force`, since
   *   that is a person asking for one thing while the file already says another.
   * - A plain re-run keeps whatever is already recorded, even when discovery has since changed.
   *   Erroring there would mean `appduct init` — documented as safe to re-run — starts failing
   *   because somebody renamed a scheme in `app.json` or a native project file. The divergence is
   *   reported as a `note` instead: visible, but not fatal.
   * - `--force` on its own is the escape hatch that re-adopts discovery, replacing the recorded
   *   scheme with whatever it currently finds.
   * - With nothing recorded, discovery decides.
   */
  const [scheme, source, origin] = ((): [
    string | undefined,
    InitCommandData["source"],
    string | undefined,
  ] => {
    if (options.scheme !== undefined) {
      return [options.scheme, "--scheme", undefined];
    }

    if (options.force && discoveredScheme !== undefined) {
      return [discoveredScheme, discoveredSourceLabel ?? "app.json", discovered.origin];
    }

    return existingScheme === undefined
      ? [discoveredScheme, discoveredSourceLabel ?? "app.json", discovered.origin]
      : [existingScheme, "already-recorded", undefined];
  })();

  if (scheme === undefined) {
    throw usageError(
      `No deep-link scheme found for ${root}, and none was given. Looked in, in order:\n${discovered.tried
        .map((location, index) => `  ${index + 1}. ${location}`)
        .join("\n")}\nRun \`appduct init --scheme <scheme>\` with the scheme your app ` +
        'registers for deep links (e.g. "myapp"), or declare it in one of the locations above.',
    );
  }

  if (
    options.scheme !== undefined &&
    existingScheme !== undefined &&
    existingScheme !== options.scheme &&
    !options.force
  ) {
    throw usageError(
      `${configPath} already records the scheme "${existingScheme}", but --scheme asked for ` +
        `"${options.scheme}". Re-run with --force to replace it (every other key in the file is ` +
        "preserved), or drop --scheme to keep what is recorded.",
    );
  }

  // Only when the recorded scheme is the one being *kept by default* and discovery disagrees. An
  // explicit `--scheme` (even one that matches what is recorded) is the user stating the answer,
  // so there is nothing to bring to their attention; `--force` has already resolved it.
  const note =
    options.scheme === undefined &&
    scheme === existingScheme &&
    discoveredScheme !== undefined &&
    discoveredScheme !== scheme
      ? `${discovered.origin} declares "${discoveredScheme}", but ${configPath} records ` +
        `"${existingScheme}", which is what Appduct uses. Run \`appduct init --force\` to ` +
        "adopt that value instead."
      : undefined;

  const alreadyCorrect = existingScheme === scheme;

  if (!alreadyCorrect) {
    // Merge rather than replace: `--force` changes the scheme, it does not reset the file.
    const next = { ...(existing ?? {}), scheme };

    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  // `mkdir`'s and `writeFile`'s `mode` only apply when they *create*, and both are subject to the
  // process umask, so tighten explicitly — exactly as `ensureStateDir` does (ARCHITECTURE.md §3).
  // Unconditional, not just on write: an idempotent re-run is the natural way to repair a
  // directory that an earlier version, a umask, or a `git checkout` left world-readable. Safe in
  // both branches — `alreadyCorrect` implies the file already exists.
  await chmod(dirname(configPath), 0o700);
  await chmod(configPath, 0o600);

  // `origin` (set only in the two discovery branches above — see the tuple returned there) names
  // the exact file/key `scheme` was read from, so the human-readable hint can say more than just
  // "source: android-manifest".
  return {
    ok: true,
    data: {
      path: configPath,
      scheme,
      source,
      ...(origin === undefined ? {} : { origin }),
      created: existing === undefined,
      changed: !alreadyCorrect,
      ...(note === undefined ? {} : { note }),
      mcpServerEntry: {
        command: "appduct",
        args: ["mcp", "--scheme", scheme],
      },
      nextSteps: [
        'Add `import "@appduct/react-native/auto";` to your app entry (index.js / App.tsx) — it ' +
          "is what starts the in-app agent endpoint.",
        `Add the Appduct MCP server entry to your agent's MCP config. "--scheme ${scheme}" keeps ` +
          `that entry self-contained; ${SCHEME_ENV_VAR} and this ${PROJECT_CONFIG_RELATIVE_PATH} ` +
          "work too.",
        "With the app running, pair a device: `appduct link --open ios-sim` (or `--open android`).",
        ...(origin === undefined ? [] : [`Scheme "${scheme}" was read from ${origin}.`]),
        `This file is safe to commit — it holds only "scheme". Do not point --state-dir at this ` +
          "directory: the state dir holds the daemon's private key and audit log, which must " +
          "never be committed.",
      ],
    },
  };
};
