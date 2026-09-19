/**
 * Owns the CLI result envelope — the {@link CommandMeta} block a rendered result carries, and
 * when it's attached. This module sits on the eager path (`runner.ts` calls it for every
 * command), so it imports nothing beyond `result-types`'s types and `global-flags`'s types.
 */

import type { CliResult, CommandMeta } from "./result-types.js";
import type { GlobalFlags } from "./global-flags.js";

export const createCommandMeta = (command: string, startedAt: Date, finishedAt: Date): CommandMeta => {
  return {
    command,
    timestamp: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
  };
};

export type CommandTiming = {
  command: string;
  startedAt: Date;
  finishedAt: Date;
};

/**
 * Attaches `meta` to a command's result, but only under `--verbose` — otherwise the result is
 * returned exactly as the handler produced it, with no `meta` key at all (never `meta: undefined`,
 * so `--json` output carries no `meta` property to filter out).
 */
export const finalizeResult = <T>(
  result: CliResult<T>,
  timing: CommandTiming,
  flags: Pick<GlobalFlags, "verbose">,
): CliResult<T> => {
  if (!flags.verbose) {
    return result;
  }

  return {
    ...result,
    meta: createCommandMeta(timing.command, timing.startedAt, timing.finishedAt),
  };
};
