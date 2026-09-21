/** Route for `appduct daemon status`. Not version-guarded: the handler reports drift as a warning
 * instead of restarting (`commands/daemon/status.ts`). */

import type { Route } from "../../router.js";

import { handleDaemonStatusCommand } from "../../../commands/daemon/status.js";
import { commandName } from "../../router.js";
import { executeCommand } from "../../runner.js";

export const route: Route = async (context) => {
  const { stateDir, env } = context;

  return executeCommand(
    commandName(context),
    () => handleDaemonStatusCommand({ stateDir, clock: env.clock }),
    env,
  );
};
