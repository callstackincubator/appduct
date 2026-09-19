/**
 * Route for `appduct daemon` — itself a router over the daemon actions, so `daemon status` loads
 * `status.ts` and nothing else. In particular it never evaluates `run.ts`, the only action that
 * pulls in the daemon implementation (ARCHITECTURE.md §10 "Startup cost").
 *
 * cac only matches a command's first word (`cli/create-cli.ts`), so the action arrives here as
 * the first positional rather than as a cac command of its own.
 */

import { usageError } from "../../../errors.js";
import { createRouter } from "../../router.js";

export const route = createRouter(
  {
    run: () => import("./run.js"),
    start: () => import("./start.js"),
    stop: () => import("./stop.js"),
    status: () => import("./status.js"),
  },
  {
    unknown: (action) =>
      usageError(
        `The daemon command requires an action: run, start, stop, or status (got ${
          action === undefined ? "none" : `"${action}"`
        }).`,
      ),
  },
);
