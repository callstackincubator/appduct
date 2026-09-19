/** `appduct daemon status` (ARCHITECTURE.md §4): `daemon.status` passthrough plus the version-drift
 * diagnosis. Warns instead of restarting, unlike the guarded commands (`cli/dispatch.ts`). */

import { RPC_METHODS, type DaemonStatusResult } from "@appduct/shared";

import type { CliResult, DaemonStatusCommandData } from "../../cli/result-types.js";

import { getPackageVersion } from "../../package-version.js";
import { callDaemon, isSameVersion } from "../../rpc/client.js";
import type { DaemonCommandContext } from "./context.js";

/** Drops the entries whose value is `undefined`, so spreading the result adds only keys that
 * carry an actual answer. */
const definedOnly = <T extends Record<string, unknown>>(fields: T): Partial<T> => {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
};

export const handleDaemonStatusCommand = async (
  context: DaemonCommandContext,
): Promise<CliResult<DaemonStatusCommandData>> => {
  const status = await callDaemon<DaemonStatusResult>(
    RPC_METHODS.daemonStatus,
    {},
    { stateDir: context.stateDir, autoSpawn: true, spawn: context.spawn },
  );

  // The wire type declares the retention fields required, as it must for any daemon built from
  // this tree — but the daemon on the other end of the socket may predate them, and a running
  // daemon outlives the CLI upgrade that would replace it. Reading them through a partial view
  // keeps that possibility in the types instead of in a comment, and leaves each one `undefined`
  // rather than `0` when it was never reported.
  const retention: Partial<DaemonStatusResult["audit"]> = status.audit;

  const clientVersion = context.clientVersion ?? getPackageVersion();
  // Guarded the same way the version check guards it (`rpc/client.ts`): a `daemon.status` without
  // `sessions` would otherwise throw from the middle of the command that exists to diagnose a
  // daemon — the one command that must keep working against a daemon it does not fully understand.
  const sessionCount = Array.isArray(status.sessions) ? status.sessions.length : 0;
  const pendingLinkCount = typeof status.pendingLinks === "number" ? status.pendingLinks : 0;
  // Names the same cost the restart path names (`rpc/client.ts`), so the diagnosis an operator
  // reads here and the error they hit on the next command tell one consistent story: an unclaimed
  // link is destroyed by a restart just as surely as a session is.
  const atStake = `${sessionCount} session(s) and ${pendingLinkCount} unclaimed link(s)`;
  const warning = isSameVersion(status.version, clientVersion)
    ? undefined
    : `Version drift: this daemon is ${status.version} but the CLI is ${clientVersion}. ` +
      `Newer RPC methods will fail against it — run "appduct daemon stop" (this drops ${atStake}) ` +
      `and the next command will start a matching daemon, or pass "--daemon-restart" to any command to replace it in place.`;

  return {
    ok: true,
    data: {
      warning,
      daemon: {
        version: status.version,
        pid: status.pid,
        started_at: status.startedAt,
        wss_port: status.wssPort,
        pinned_keys: status.pinnedKeys,
        session_count: sessionCount,
      },
      policy: status.policy,
      audit: {
        path: status.audit.path,
        failed_writes: status.audit.failedWrites,
        // Spread so an unreported field is a *missing key*, not a key holding `undefined`. The two
        // serialize identically, but only the first is honestly shaped: a caller can ask whether
        // the daemon answered, and `--json` consumers see the same absence in-process as on the
        // wire.
        ...definedOnly({
          failed_prunes: retention.failedPrunes,
          retention_days: retention.retentionDays,
          files: retention.files,
          bytes: retention.bytes,
        }),
      },
    },
  };
};
