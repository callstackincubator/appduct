/** `appduct daemon run` (ARCHITECTURE.md §4): host the daemon in this process. The only daemon
 * action that loads the daemon implementation itself (`daemon/daemon.ts`, and with it `ws` and the
 * certificate stack), which is why it lives in its own module. */

import type { CliResult, DaemonRunCommandData } from "../../cli/result-types.js";

import { startDaemon } from "../../daemon/daemon.js";
import { DaemonAlreadyRunningError } from "../../daemon/pidfile.js";
import { connectionError } from "../../errors.js";
import type { DaemonCommandContext } from "./context.js";

export type DaemonRunHostedResult = {
  result: CliResult<DaemonRunCommandData>;
  completion: Promise<void>;
  stop: () => void;
};

export const handleDaemonRunCommand = async (
  context: DaemonCommandContext,
): Promise<DaemonRunHostedResult> => {
  let daemon: Awaited<ReturnType<typeof startDaemon>>;

  try {
    daemon = await startDaemon({
      stateDir: context.stateDir,
      clock: context.clock,
      warn: context.warn,
    });
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      throw connectionError(error.message, { pid: error.pid });
    }

    throw error;
  }

  return {
    result: {
      ok: true,
      data: {
        daemon: {
          pid: process.pid,
          state_dir: daemon.paths.root,
          socket_path: daemon.paths.socketPath,
        },
      },
    },
    completion: daemon.exited,
    stop: () => {
      void daemon.shutdown();
    },
  };
};
