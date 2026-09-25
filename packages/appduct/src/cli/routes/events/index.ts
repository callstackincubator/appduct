/**
 * Route for `appduct events` — itself a router over the events verbs, so `events tail` loads only
 * `tail.ts` (issue #96). cac matches only the noun (`cli/create-cli.ts`), so the verb arrives here
 * as the first positional rather than as a cac command of its own.
 *
 * `ls` is reserved for the catalog issue #95 adds; until it lands, `events ls` falls through to
 * `unknown` below like any other unrecognized verb, naming `tail`/`since` as the ones that exist.
 */

import { usageError } from "../../../errors.js";
import { createRouter } from "../../router.js";

export const route = createRouter(
  {
    tail: () => import("./tail.js"),
    since: () => import("./since.js"),
  },
  {
    unknown: (verb) =>
      usageError(
        `The events command requires a verb: tail or since (got ${
          verb === undefined ? "none" : `"${verb}"`
        }).`,
      ),
  },
);
