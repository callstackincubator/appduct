/**
 * `appduct events ls [selector] [--name <glob>] [--limit <n>] [--offset <n>]` (issue #124): lists the events an app declared,
 * from the daemon's `events.list`. The listing carries each event's full descriptor, so `--json`
 * has the payload schemas too; the human renderer prints signature lines, and the full schema when
 * `--name` is an exact name (no `*`) that matched an event.
 */

import { RPC_METHODS, type EventsListResult } from "@appduct/shared";

import type { CliResult, EventsListing } from "../cli/result-types.js";
import { callDaemon, type SpawnFn } from "../rpc/client.js";

export type EventsLsOptions = {
  selector?: string;
  /** Whole-name, case-sensitive glob, forwarded to `events.list`. */
  name?: string;
  /** Page size; omitted lists everything from `offset` on. */
  limit?: number;
  /** Zero-based start index into the name-sorted, filtered list. */
  offset?: number;
};

export const handleEventsLsCommand = async (
  options: EventsLsOptions,
  context: { stateDir: string; spawn?: SpawnFn },
): Promise<CliResult<EventsListing>> => {
  const result = await callDaemon<EventsListResult>(
    RPC_METHODS.eventsList,
    { selector: options.selector, name: options.name, limit: options.limit, offset: options.offset },
    { stateDir: context.stateDir, spawn: context.spawn },
  );

  // The inputs actually given are echoed so the human renderer can tell an exact-name lookup from
  // a listing and report the page, and `--json` consumers see what produced it (as `tools ls` does).
  return {
    ok: true,
    data: {
      ...result,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    },
  };
};
