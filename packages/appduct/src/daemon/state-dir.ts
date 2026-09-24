/**
 * State directory resolution and layout (ARCHITECTURE.md §3).
 *
 * Default `~/.appduct/`, overridable with `APPDUCT_STATE_DIR` (tests rely on the
 * override). Created lazily with mode `0700`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";

export type StateDirPaths = {
  /** The state directory root. */
  root: string;
  /** Unix domain control socket. Windows named pipes would plug in behind {@link getSocketPath}. */
  socketPath: string;
  pidFilePath: string;
  logFilePath: string;
  /** The daemon's own event log; rotated to `<eventsLogPath>.1`. */
  eventsLogPath: string;
  keyPath: string;
  configPath: string;
  auditDir: string;
  /** Exclusive spawn-lock file used by the auto-spawning RPC client to prevent double-spawn races. */
  spawnLockPath: string;
};

/** Resolves the state directory: explicit `override`, else `APPDUCT_STATE_DIR`, else `~/.appduct`. */
export const resolveStateDir = (override?: string): string => {
  return override ?? process.env.APPDUCT_STATE_DIR ?? join(homedir(), ".appduct");
};

export const getStateDirPaths = (stateDir: string): StateDirPaths => {
  return {
    root: stateDir,
    socketPath: join(stateDir, "daemon.sock"),
    pidFilePath: join(stateDir, "daemon.pid"),
    logFilePath: join(stateDir, "daemon.log"),
    eventsLogPath: join(stateDir, "events.log"),
    keyPath: join(stateDir, "key.pem"),
    configPath: join(stateDir, "config.json"),
    auditDir: join(stateDir, "audit"),
    spawnLockPath: join(stateDir, "daemon.spawn.lock"),
  };
};

/**
 * Single seam for the control-socket address. Today this is always the UDS path; a Windows
 * named-pipe implementation (`\\.\pipe\appduct-<user>`) plugs in here without touching any
 * caller (ARCHITECTURE.md §13 — best-effort, not blocking v2.0).
 */
export const getSocketPath = (paths: StateDirPaths): string => {
  return paths.socketPath;
};

/** Creates the state dir (and `audit/`) with mode `0700` if missing; tightens the mode if it exists. */
export const ensureStateDir = async (stateDir: string): Promise<StateDirPaths> => {
  const paths = getStateDirPaths(stateDir);

  await mkdir(paths.auditDir, { recursive: true });
  await chmod(paths.root, 0o700);
  // `mkdir` honors the process umask (commonly 0o022, yielding drwxr-xr-x); tighten explicitly so
  // `audit/` matches every other path under the state dir (ARCHITECTURE.md §3).
  await chmod(paths.auditDir, 0o700);

  return paths;
};
