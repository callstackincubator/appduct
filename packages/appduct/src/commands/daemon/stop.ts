/** `appduct daemon stop` (ARCHITECTURE.md §4): `daemon.shutdown` over RPC, falling back to a
 * SIGTERM at the pidfile's process when the socket is not answering. */

import { RPC_METHODS, type DaemonShutdownResult } from "@appduct/shared";

import type { CliResult, DaemonStopCommandData } from "../../cli/result-types.js";

import { readPidFromFile } from "../../daemon/pidfile.js";
import { getStateDirPaths } from "../../daemon/state-dir.js";
import { connectionError } from "../../errors.js";
import { callDaemon, isDaemonUnreachableError } from "../../rpc/client.js";
import type { DaemonCommandContext } from "./context.js";

export const handleDaemonStopCommand = async (
  context: DaemonCommandContext,
): Promise<CliResult<DaemonStopCommandData>> => {
  try {
    await callDaemon<DaemonShutdownResult>(
      RPC_METHODS.daemonShutdown,
      {},
      { stateDir: context.stateDir, autoSpawn: false },
    );

    return { ok: true, data: { daemon: { ok: true, method: "rpc" } } };
  } catch (error) {
    if (!isDaemonUnreachableError(error)) {
      throw error;
    }

    const paths = getStateDirPaths(context.stateDir);
    const pid = await readPidFromFile(paths.pidFilePath);

    if (pid === undefined) {
      throw connectionError("No Appduct daemon is running.");
    }

    process.kill(pid, "SIGTERM");

    return { ok: true, data: { daemon: { ok: true, method: "sigterm" } } };
  }
};
