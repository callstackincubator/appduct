/**
 * Route for `appduct events` — itself a router over the events verbs, so `events tail` loads only
 * `tail.ts` (issue #96). cac matches only the noun (`cli/create-cli.ts`), so the verb arrives here
 * as the first positional rather than as a cac command of its own.
 */

import { usageError } from "../../../errors.js";
import { createRouter } from "../../router.js";

export const route = createRouter(
  {
    ls: () => import("./ls.js"),
    tail: () => import("./tail.js"),
    since: () => import("./since.js"),
  },
  {
    unknown: (verb) =>
      usageError(
        `The events command requires a verb: ls, tail, or since (got ${
          verb === undefined ? "none" : `"${verb}"`
        }).`,
      ),
  },
);
