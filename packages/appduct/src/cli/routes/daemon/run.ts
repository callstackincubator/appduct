/** Route for `appduct daemon run`: the one daemon action that hosts the daemon in-process. */

import type { Route } from "../../router.js";

import { handleDaemonRunCommand } from "../../../commands/daemon/run.js";
import { commandName } from "../../router.js";
import { executeHostedCommand } from "../../runner.js";

export const route: Route = async (context) => {
  const { stateDir, env } = context;

  return executeHostedCommand(
    commandName(context),
    () => handleDaemonRunCommand({ stateDir, clock: env.clock }),
    env,
  );
};
