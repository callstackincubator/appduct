/** Route for `appduct daemon stop`. Not version-guarded: stopping is already the remedy a version
 * mismatch would prescribe. */

import type { Route } from "../../router.js";

import { handleDaemonStopCommand } from "../../../commands/daemon/stop.js";
import { commandName } from "../../router.js";
import { executeCommand } from "../../runner.js";

export const route: Route = async (context) => {
  const { stateDir, io } = context;

  return executeCommand(
    commandName(context),
    () => handleDaemonStopCommand({ stateDir, clock: io.clock }),
    io,
  );
};
