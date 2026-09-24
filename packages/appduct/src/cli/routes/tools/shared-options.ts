/**
 * The listing-only flags (`--group`/`--groups`/`--filter`/`--limit`/`--offset`) shared by
 * `tools ls`, which acts on them, and `tools describe`, which only needs them parsed so it can
 * reject one next to a `<name>` with the same usage error it has always gotten
 * (`commands/tools.ts`'s `hasListingOnlyOptions`). Kept out of `index.ts` — nothing outside this
 * directory imports it — since a route module, not the noun's router, is the caller.
 */

import { isValidToolGroup } from "@appduct/shared";

import { usageError } from "../../../errors.js";
import { parseNonNegativeIntegerOption, parsePositiveIntegerOption, readTextOption } from "../../command-options.js";
import type { RouteContext } from "../../router.js";

export type ToolsListingFlags = {
  group?: string;
  groups?: boolean;
  filter?: string;
  limit?: number;
  offset?: number;
};

export const parseToolsListingFlags = (context: RouteContext): ToolsListingFlags => {
  const { options } = context;
  const limit = parsePositiveIntegerOption(options.limit, "--limit");
  const offset = parseNonNegativeIntegerOption(options.offset, "--offset");
  const filter = readTextOption(context.argv, options.filter, "--filter");
  const group = readTextOption(context.argv, options.group, "--group");

  // Checked here, not only by the daemon, so a malformed group is a usage error (exit 64) that
  // never waits on the daemon — the same rule the daemon's `tools.list` applies.
  if (group !== undefined && !isValidToolGroup(group)) {
    throw usageError(
      `"--group" must be a group name like "checkout" or "checkout/payment" (one or two "/"-separated segments of [a-zA-Z0-9_-], at most 64 characters each); got ${JSON.stringify(group)}.`,
    );
  }

  const groups = options.groups === undefined ? undefined : Boolean(options.groups);

  return { group, groups, filter, limit, offset };
};
