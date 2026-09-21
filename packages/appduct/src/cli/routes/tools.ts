/** Route for `appduct tools` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleToolsCommand } from "../../commands/tools.js";
import {
  parseNonNegativeIntegerOption,
  parsePositiveIntegerOption,
  readTextOption,
  splitOptionalSelectorAndTarget,
} from "../command-options.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";
import { guarded } from "../version-guard.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;

  return executeCommand(
    commandName(context),
    // Argument parsing runs inside the handler so a usage error renders through the runner (exit
    // 64, `--json` envelope) instead of escaping the route as an uncaught rejection, and before
    // the version check so a typo never waits on (or restarts) the daemon.
    () => {
      const { selector, target, selectorOrTarget } = splitOptionalSelectorAndTarget(
        context.args,
        "tools [selector] [name]",
      );
      const limit = parsePositiveIntegerOption(options.limit, "--limit");
      const offset = parseNonNegativeIntegerOption(options.offset, "--offset");
      const filter = readTextOption(context.argv, options.filter, "--filter");

      return guarded(context)(() =>
        handleToolsCommand(
          { selector: selector ?? selectorOrTarget, name: target, filter, limit, offset },
          { stateDir },
        ),
      )();
    },
    context.env,
    { full: Boolean(options.full) },
  );
};
