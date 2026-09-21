/**
 * Pidfile single-instancing (ARCHITECTURE.md §4). Acquired with `O_EXCL`; on conflict, liveness
 * is checked with `process.kill(pid, 0)` — plus, on Linux, a `/proc/<pid>/status` read that treats
 * a zombie as dead — and the pidfile is only taken over if the owning process is dead.
 */

import { readFileSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`Appduct daemon is already running (pid ${pid}).`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export type PidfileHandle = {
  readonly pid: number;
  /** Idempotent: safe to call more than once. */
  release: () => Promise<void>;
};

/**
 * Reads `/proc/<pid>/status`. Injectable purely so the zombie branch below can be tested without
 * arranging a real unreaped child, which needs a process that outlives its parent *and* an init
 * that does not reap — neither of which a test can rely on across platforms.
 */
export type ProcStatusReader = (pid: number) => string | undefined;

const readProcStatus: ProcStatusReader = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    // No procfs, no such process any more, or no permission: the caller falls back to
    // `process.kill(pid, 0)`'s answer, which is what this check was ever only refining.
    return undefined;
  }
};

/**
 * True when `/proc` positively says this pid is a zombie — an exited process whose parent has not
 * reaped it.
 *
 * A zombie still has a pid table entry, so `process.kill(pid, 0)` succeeds for it exactly as it
 * does for a running process. That is the right answer for signalling (the pid is not free to be
 * reused) and the wrong one for us: the daemon that pid names is gone, its socket is closed, and
 * nothing will ever come back. Normally it is invisible, because PID 1 reaps orphans within
 * milliseconds — but in a container whose PID 1 is a plain command rather than an init, nothing
 * reaps, and a daemon that was SIGKILLed after its parent CLI exited stays a zombie for the life
 * of the container. The pidfile then never looks stale, takeover never fires, and every later
 * command reports a daemon that is already dead.
 *
 * Linux-only by construction: this reads procfs and returns false wherever it is absent or
 * unreadable, which leaves `process.kill(pid, 0)` as the answer on macOS and everywhere else.
 * There is no portable equivalent, and getting this wrong in the other direction — declaring a
 * live daemon dead — would clobber a running daemon's state, so it only ever says "dead" on
 * positive evidence.
 */
const isZombie = (pid: number, readStatus: ProcStatusReader): boolean => {
  const status = readStatus(pid);

  if (status === undefined) {
    return false;
  }

  // `State:\tZ (zombie)` — one line, tab-separated, the state letter first.
  return /^State:\s*Z\b/mu.test(status);
};

/**
 * Liveness probe for a pid this process does not own (ARCHITECTURE.md §4's `process.kill(pid, 0)`
 * check, refined by the zombie check above). Exported because every "is a daemon still there?"
 * decision in the codebase must answer it the same way — pidfile takeover, the auto-spawn path's
 * stale-socket unlink, and log rotation all hinge on it, and a second implementation that
 * disagreed about `EPERM` (or about zombies) would mean one of them quietly clobbering a live
 * daemon's state.
 */
export const isProcessAlive = (pid: number, readStatus: ProcStatusReader = readProcStatus): boolean => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the process exists but we lack permission to signal it — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }

  // The signal landed, so a pid table entry exists. That is not the same as a process that can
  // still serve anything.
  return !isZombie(pid, readStatus);
};

export const readPidFromFile = async (pidFilePath: string): Promise<number | undefined> => {
  let contents: string;

  try {
    contents = await readFile(pidFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  const pid = Number.parseInt(contents.trim(), 10);

  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

export type AcquirePidfileOptions = {
  pid?: number;
  /**
   * Invoked once, after a stale (dead-owner) pidfile is detected and removed, before the pidfile
   * is re-acquired. Lets the caller clean up other stale state (e.g. `daemon.sock`) tied to the
   * dead process.
   */
  onStaleTakeover?: () => Promise<void>;
};

/**
 * Acquires the daemon pidfile, taking over a stale one (owner process is dead or the file is
 * unparseable) but throwing {@link DaemonAlreadyRunningError} when a live daemon holds it.
 */
export const acquirePidfile = async (
  pidFilePath: string,
  options: AcquirePidfileOptions = {},
): Promise<PidfileHandle> => {
  const pid = options.pid ?? process.pid;

  // Bounded retry: another process could win the takeover race between our stale-check and our
  // write attempt. A handful of retries is enough to make forward progress deterministic in tests
  // without looping forever on a persistently-contended pidfile.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = await open(pidFilePath, "wx", 0o600);

      try {
        await handle.writeFile(String(pid), "utf8");
      } finally {
        await handle.close();
      }

      let released = false;

      return {
        pid,
        release: async () => {
          if (released) {
            return;
          }

          released = true;
          await rm(pidFilePath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const existingPid = await readPidFromFile(pidFilePath);

      if (existingPid !== undefined && isProcessAlive(existingPid)) {
        throw new DaemonAlreadyRunningError(existingPid);
      }

      // Stale pidfile (dead owner, or unparseable contents): remove and retry.
      await rm(pidFilePath, { force: true });
      await options.onStaleTakeover?.();
    }
  }

  throw new Error(`Failed to acquire the Appduct daemon pidfile at "${pidFilePath}".`);
};
