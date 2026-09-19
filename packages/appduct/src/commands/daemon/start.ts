/** `appduct daemon start` (ARCHITECTURE.md §4): a `daemon.status` call with auto-spawn on, so a
 * daemon that isn't running gets started as a detached process — never in-process. */

import { RPC_METHODS, type DaemonStatusResult } from "@appduct/shared";

import type { CliResult, DaemonStartCommandData } from "../../cli/result-types.js";

import { callDaemon } from "../../rpc/client.js";
import type { DaemonCommandContext } from "./context.js";

export const handleDaemonStartCommand = async (
  context: DaemonCommandContext,
): Promise<CliResult<DaemonStartCommandData>> => {
  const status = await callDaemon<DaemonStatusResult>(
    RPC_METHODS.daemonStatus,
    {},
    { stateDir: context.stateDir, autoSpawn: true, spawn: context.spawn },
  );

  return {
    ok: true,
    data: {
      daemon: {
        pid: status.pid,
        wss_port: status.wssPort,
        started_at: status.startedAt,
      },
    },
  };
};
