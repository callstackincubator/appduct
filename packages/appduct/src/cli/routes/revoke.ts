/** Route for `appduct revoke` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleRevokeCommand } from "../../commands/revoke.js";
import { splitOptionalSelector } from "../command-options.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";
import { guarded } from "../version-guard.js";

export const route: Route = async (context) => {
  const { stateDir } = context;

  return executeCommand(
    commandName(context),
    // Parsed inside the handler so a usage error renders through the runner instead of escaping
    // the route as an uncaught rejection.
    () => {
      const { selector } = splitOptionalSelector(context.args, "revoke [selector]");
      return guarded(context)(() => handleRevokeCommand({ selector }, { stateDir }))();
    },
    context.env,
  );
};
