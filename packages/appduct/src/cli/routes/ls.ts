/** Route for `appduct ls` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleLsCommand } from "../../commands/ls.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";
import { guarded } from "../version-guard.js";

export const route: Route = async (context) => {
  const { stateDir } = context;

  return executeCommand(
    commandName(context),
    guarded(context)(() => handleLsCommand({ stateDir })),
    context.io,
  );
};
