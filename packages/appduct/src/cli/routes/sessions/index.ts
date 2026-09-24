/**
 * Route for `appduct sessions` — itself a router over the session verbs, so `sessions ls` loads
 * only `ls.ts` (issue #96). cac matches only the noun (`cli/create-cli.ts`), so the verb arrives
 * here as the first positional rather than as a cac command of its own — the same shape
 * `routes/daemon/index.ts` already uses for `daemon status`.
 */

import { usageError } from "../../../errors.js";
import { createRouter } from "../../router.js";

export const route = createRouter(
  {
    ls: () => import("./ls.js"),
    revoke: () => import("./revoke.js"),
    link: () => import("./link.js"),
  },
  {
    unknown: (verb) =>
      usageError(
        `The sessions command requires a verb: ls, revoke, or link (got ${
          verb === undefined ? "none" : `"${verb}"`
        }).`,
      ),
  },
);
