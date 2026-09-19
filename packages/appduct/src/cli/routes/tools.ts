/** Route for `appduct tools` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleToolsCommand } from "../../commands/tools.js";
import { splitOptionalSelectorAndTarget } from "../command-options.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";
import { guarded } from "../version-guard.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;
  const { selector, target, selectorOrTarget } = splitOptionalSelectorAndTarget(
    context.args,
    "tools [selector] [name]",
  );

  return executeCommand(
    commandName(context),
    guarded(context)(() =>
      handleToolsCommand({ selector: selector ?? selectorOrTarget, name: target }, { stateDir }),
    ),
    { ...context.io, full: Boolean(options.full) },
  );
};
