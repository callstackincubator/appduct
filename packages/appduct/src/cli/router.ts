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

import type { CliRenderContext } from "./types.js";
import type { VersionCheckOptions } from "../rpc/client.js";

import { usageError } from "../errors.js";
import { executeCommand } from "./runner.js";

/** Everything a route needs to run one command; built once by `dispatch.ts`, narrowed per level. */
export type RouteContext = {
  /** The command words matched so far, e.g. `["daemon", "status"]`. Joined with spaces it is the
   * `meta.command` a rendered result reports. */
  readonly path: readonly string[];
  /** The positional arguments left after {@link path}: what the matched command itself receives. */
  readonly args: readonly string[];
  /** Every parsed flag (global and per-command), as `cac` reports them (camelCased). */
  readonly options: Readonly<Record<string, unknown>>;
  readonly io: CliRenderContext;
  /** The resolved state directory (`--state-dir` / `APPDUCT_STATE_DIR` / default). */
  readonly stateDir: string;
  /**
   * Wraps a handler so the daemon's version is verified once before the command's first RPC
   * (ARCHITECTURE.md §4 "Version drift"). Every command that talks to the daemon uses it, except
   * the ones `dispatch.ts` documents as exempt.
   */
  readonly guarded: <T>(handler: () => T | Promise<T>) => () => Promise<T>;
  /** The version-check options for a command that threads the check into its own startup instead
   * of running it ahead (`mcp`); `onWarning` decides where the drift notice goes. */
  readonly versionCheckFor: (onWarning: (message: string) => void) => Promise<VersionCheckOptions>;
};

export type Route = (context: RouteContext) => Promise<number>;

export type RouteLoader = () => Promise<{ route: Route }>;

export type RouteTable = Readonly<Record<string, RouteLoader>>;

export type RouterOptions = {
  /** Builds the error for an unmatched (or missing) command word at this level. */
  readonly unknown: (word: string | undefined, context: RouteContext) => Error;
};

/** The `meta.command` string for a context: the matched words joined, or the level's own name. */
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
        context.io,
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
