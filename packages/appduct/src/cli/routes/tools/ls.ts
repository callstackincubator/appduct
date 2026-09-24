/** Route for `appduct tools ls` — loaded by `routes/tools/index.ts`'s router only when it runs
 * (issue #96; replaces the removed `appduct tools [selector]` listing form). */

import type { Route } from "../../router.js";

import { handleToolsCommand } from "../../../commands/tools.js";
import { usageError } from "../../../errors.js";
import { splitOptionalSelector } from "../../command-options.js";
import { commandName } from "../../router.js";
import { executeCommand } from "../../runner.js";
import { guarded } from "../../version-guard.js";
import { parseToolsListingFlags } from "./shared-options.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;

  return executeCommand(
    commandName(context),
    // Argument parsing runs inside the handler so a usage error renders through the runner (exit
    // 64, `--json` envelope) instead of escaping the route as an uncaught rejection, and before
    // the version check so a typo never waits on (or restarts) the daemon.
    () => {
      const { selector } = splitOptionalSelector(context.args, "tools ls [selector]");
      const listing = parseToolsListingFlags(context);

      if (listing.groups && options.full) {
        throw usageError('"--groups" lists groups only and cannot be combined with "--full".');
      }

      return guarded(context)(() => handleToolsCommand({ selector, ...listing }, { stateDir }))();
    },
    context.env,
    { full: Boolean(options.full) },
  );
};
