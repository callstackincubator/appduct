/** Route for `appduct tools describe` — loaded by `routes/tools/index.ts`'s router only when it
 * runs (issue #96; replaces the removed `appduct tools <name>` / `appduct tools [selector] <name>`
 * detail form). Unlike the old single-positional form, `<name>` is never ambiguous with a
 * selector: `splitSelectorAndRequiredTarget` always takes the last positional as the name. */

import type { Route } from "../../router.js";

import { handleToolsCommand } from "../../../commands/tools.js";
import { splitSelectorAndRequiredTarget } from "../../command-options.js";
import { commandName } from "../../router.js";
import { executeCommand } from "../../runner.js";
import { guarded } from "../../version-guard.js";
import { parseToolsListingFlags } from "./shared-options.js";

export const route: Route = async (context) => {
  const { stateDir } = context;

  return executeCommand(
    commandName(context),
    // Argument parsing runs inside the handler so a usage error renders through the runner
    // instead of escaping the route as an uncaught rejection.
    () => {
      const { selector, target: name } = splitSelectorAndRequiredTarget(
        context.args,
        "tools describe [selector] <name>",
      );
      // Parsed (and validated) even though `describe` never *uses* them, so a listing flag next
      // to a `<name>` still gets `commands/tools.ts`'s "only apply to a listing" usage error
      // instead of being silently ignored.
      const listing = parseToolsListingFlags(context);

      return guarded(context)(() => handleToolsCommand({ selector, name, ...listing }, { stateDir }))();
    },
    context.env,
  );
};
