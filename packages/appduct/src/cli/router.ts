/**
 * The CLI's multi-level command router — the mechanism behind ARCHITECTURE.md §10 "Startup cost".
 *
 * A route table maps one command word to a *loader*: a `() => import("./routes/<name>.js")`.
 * Nothing behind a loader is evaluated until its command word actually matches, so the module
 * graph a process pays for at startup is the router plus the one route it takes, never the sum
 * of every command. A route module may itself export another router (`daemon` does), and the
 * same rule applies one level down: `daemon status` never loads `daemon run`'s daemon.
 *
 * The contract for a route module is a single `route` export of type {@link Route}. Keep the
 * route module's *static* imports limited to what that command needs — a static import in a
 * lazily loaded module is still lazy, it is the eager path (`dispatch.ts`, this file, `runner.ts`)
 * that must stay lean.
 */

import type { CliEnv } from "./types.js";

import { usageError } from "../errors.js";
import { executeCommand } from "./runner.js";

/** The inputs of the daemon version check (ARCHITECTURE.md §4 "Version drift"), as plain data so
 * they can cross the bundle boundary; `cli/version-guard.ts` turns them into the check itself. */
export type VersionCheckInputs = {
  /** The version this client actually is — always the real package version, never an override. */
  readonly clientVersion: string;
  /** Resolves `--daemon-restart` / `APPDUCT_DAEMON_RESTART` / `restartDaemonOnVersionMismatch`;
   * memoized by the caller, and it never throws (an unreadable config reads as `false`). */
  readonly forceRestart: () => Promise<boolean>;
  /** Where a "the daemon is newer than this client" notice goes for a command that is checked
   * ahead of its first RPC; a no-op under `--json`, whose stdout/stderr contract has no room for
   * it. A command that owns its own log channel (`mcp`) substitutes its own writer. */
  readonly warn: (message: string) => void;
};

/**
 * Everything a route needs to run one command; built once by `dispatch.ts`, narrowed per level.
 *
 * This object is the only thing that crosses from the eager bundle (`dist/bin.js`) into a route
 * bundle (`dist/cli/routes/<command>.js`), and each route bundle carries its *own copy* of the
 * modules it shares with the eager one (`scripts/bundle.mjs`). Two copies of a module mean two
 * copies of its classes, and `instanceof` fails across them — so the context carries plain data,
 * writers and closures that never throw. A closure that could throw an `AppductCliError` made in
 * the eager bundle would reach the route's copy of `toCliError` and render as `internal_error`.
 */
export type RouteContext = {
  /** The command words matched so far, e.g. `["daemon", "status"]`. Joined with spaces it is the
   * command name used to pick a success-data renderer, and (under `--verbose`) the `meta.command`
   * a rendered result reports. */
  readonly path: readonly string[];
  /** The positional arguments left after {@link path}: what the matched command itself receives. */
  readonly args: readonly string[];
  /** Every parsed flag (global and per-command), as `cac` reports them (camelCased). */
  readonly options: Readonly<Record<string, unknown>>;
  /** The raw argv `runCli` received (no `node`/script prefix). For the rare flag whose value must
   * be read verbatim: `cac` coerces every numeric-looking value to a number (`--filter 007` → `7`),
   * so a free-text flag recovers its exact string from here (`command-options.ts`'s
   * `readTextOption`). */
  readonly argv: readonly string[];
  readonly env: CliEnv;
  /** The resolved state directory (`--state-dir` / `APPDUCT_STATE_DIR` / default). */
  readonly stateDir: string;
  readonly versionCheck: VersionCheckInputs;
};

export type Route = (context: RouteContext) => Promise<number>;

export type RouteLoader = () => Promise<{ route: Route }>;

export type RouteTable = Readonly<Record<string, RouteLoader>>;

export type RouterOptions = {
  /** Builds the error for an unmatched (or missing) command word at this level. */
  readonly unknown: (word: string | undefined, context: RouteContext) => Error;
};

/** The command name for a context (the `meta.command` a rendered result reports under
 * `--verbose`): the matched words joined, or the level's own name. */
export const commandName = (context: RouteContext): string => {
  return context.path.join(" ");
};

/**
 * Builds a {@link Route} that consumes the next positional as a command word, lazy-loads the
 * matching route module and hands it the rest. An unmatched word renders `options.unknown`'s
 * error through the standard runner, so the exit code and `--json` shape are the same as any
 * other usage error.
 */
export const createRouter = (table: RouteTable, options: RouterOptions): Route => {
  return async (context) => {
    const [word, ...rest] = context.args;
    // `hasOwn` so a word such as "constructor" can't match the table's prototype.
    const load = word !== undefined && Object.hasOwn(table, word) ? table[word] : undefined;

    if (load === undefined) {
      return executeCommand(
        commandName(context),
        () => {
          throw options.unknown(word, context);
        },
        context.env,
      );
    }

    const { route } = await load();

    return route({ ...context, path: [...context.path, word!], args: rest });
  };
};

/** The default {@link RouterOptions.unknown} for a level whose commands are all top-level. */
export const unknownCommandError = (word: string | undefined): Error => {
  return usageError(word === undefined ? "A command is required." : `Unknown command "${word}".`);
};
