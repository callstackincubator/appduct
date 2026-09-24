/**
 * Route for `appduct tools` — itself a router over the tools verbs, so `tools ls` loads only
 * `ls.ts` (issue #96). cac matches only the noun (`cli/create-cli.ts`), so the verb arrives here
 * as the first positional rather than as a cac command of its own.
 */

import { usageError } from "../../../errors.js";
import { createRouter } from "../../router.js";

export const route = createRouter(
  {
    ls: () => import("./ls.js"),
    describe: () => import("./describe.js"),
    call: () => import("./call.js"),
  },
  {
    unknown: (verb) =>
      usageError(
        `The tools command requires a verb: ls, describe, or call (got ${
          verb === undefined ? "none" : `"${verb}"`
        }).`,
      ),
  },
);
