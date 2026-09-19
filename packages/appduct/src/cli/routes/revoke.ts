/** Route for `appduct revoke` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleRevokeCommand } from "../../commands/revoke.js";
import { splitOptionalSelector } from "../command-options.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";
import { guarded } from "../version-guard.js";

export const route: Route = async (context) => {
  const { stateDir } = context;
  const { selector } = splitOptionalSelector(context.args, "revoke [selector]");

  return executeCommand(
    commandName(context),
    guarded(context)(() => handleRevokeCommand({ selector }, { stateDir })),
    context.env,
  );
};
