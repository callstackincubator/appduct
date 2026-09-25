/**
 * The `--name`/`--payload-max-bytes` flags shared by `events tail` and `events since` (issue
 * #115): both pass them straight through to `events.subscribe`/`events.since` with no default —
 * see `commands/events.ts`. Kept out of `index.ts` — nothing outside this directory imports it —
 * since a route module, not the noun's router, is the caller.
 */

import { parsePositiveIntegerOption, readTextOption } from "../../command-options.js";
import type { RouteContext } from "../../router.js";

export type EventsFilterFlags = {
  name?: string;
  payloadMaxBytes?: number;
};

export const parseEventsFilterFlags = (context: RouteContext): EventsFilterFlags => {
  const { options } = context;

  return {
    name: readTextOption(context.argv, options.name, "--name"),
    payloadMaxBytes: parsePositiveIntegerOption(options.payloadMaxBytes, "--payload-max-bytes"),
  };
};
