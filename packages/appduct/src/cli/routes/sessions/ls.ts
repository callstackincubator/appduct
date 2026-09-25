/** Route for `appduct sessions ls` — loaded by `routes/sessions/index.ts`'s router only when it
 * runs (issue #96; replaces the removed `appduct ls`). */

import type { Route } from "../../router.js";

import { handleLsCommand } from "../../../commands/ls.js";
import { commandName } from "../../router.js";
import { executeCommand } from "../../runner.js";
import { guarded } from "../../version-guard.js";

export const route: Route = async (context) => {
  const { stateDir } = context;

  return executeCommand(
    commandName(context),
    guarded(context)(() => handleLsCommand({ stateDir })),
    context.env,
  );
};
