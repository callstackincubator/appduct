/** Route for `appduct daemon start`. */

import type { Route } from "../../router.js";

import { handleDaemonStartCommand } from "../../../commands/daemon/start.js";
import { commandName } from "../../router.js";
import { executeCommand } from "../../runner.js";

export const route: Route = async (context) => {
  const { stateDir, io } = context;

  return executeCommand(
    commandName(context),
    context.guarded(() => handleDaemonStartCommand({ stateDir, clock: io.clock })),
    io,
  );
};
