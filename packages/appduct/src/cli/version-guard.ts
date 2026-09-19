/**
 * The daemon version check as a route sees it (ARCHITECTURE.md §4 "Version drift"). Lives on the
 * route side of the eager/route bundle boundary on purpose: the check throws
 * `DaemonVersionMismatchError` instances, and they must be created by the same copy of
 * `rpc/client.ts` that the route's `runner.ts` classifies them with (see `RouteContext`).
 */

import type { RouteContext } from "./router.js";

import { ensureDaemonVersionMatches, type VersionCheckOptions } from "../rpc/client.js";

/** The check's options for a route, with the drift notice going to `onWarning` (default: the
 * context's `warn`). `mcp` passes its own writer: stderr is that server's only log channel. */
export const versionCheckOptions = async (
  context: RouteContext,
  onWarning: (message: string) => void = context.versionCheck.warn,
): Promise<VersionCheckOptions> => {
  return {
    clientVersion: context.versionCheck.clientVersion,
    forceRestart: await context.versionCheck.forceRestart(),
    onWarning,
  };
};

/**
 * Wraps a command handler so the daemon's version is verified once, before the command's first
 * RPC. `autoSpawn: false`: with nothing listening there is no drift to find, and any daemon this
 * process spawns afterwards is its own build. Applied to every command that talks to the daemon
 * except `daemon run` (it *is* the daemon), `daemon status` (warns instead — see
 * `commands/daemon/status.ts`) and `daemon stop` (already the remedy); `keygen`/`doctor` never
 * open a daemon connection at all.
 */
export const guarded = (context: RouteContext) => {
  return <T>(handler: () => T | Promise<T>): (() => Promise<T>) => {
    return async () => {
      await ensureDaemonVersionMatches({
        stateDir: context.stateDir,
        autoSpawn: false,
        checkVersion: await versionCheckOptions(context),
      });

      return handler();
    };
  };
};
