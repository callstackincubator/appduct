/**
 * `daemon/pidfile.ts`'s liveness probe (ARCHITECTURE.md §4). Every "is a daemon still there?"
 * decision in the codebase goes through `isProcessAlive` — pidfile takeover, the auto-spawn path's
 * stale-socket unlink, log rotation — so what it answers for a zombie decides all three.
 */

import { spawnSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import { isProcessAlive, type ProcStatusReader } from "../daemon/pidfile.js";

/**
 * A pid that is genuinely gone: spawn a no-op child and wait for it to exit. `spawnSync` reaps it,
 * so by the time this returns the pid is free of any table entry at all.
 */
const deadPid = (): number => {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(child.status).toBe(0);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid!;
};

/**
 * A `/proc/<pid>/status` body, in the shape the kernel writes it: `Name`, then `State:\tX (word)`.
 *
 * A *real* zombie cannot be arranged from here. Node reaps its own children automatically (libuv
 * installs a SIGCHLD handler), so a child of this process is never a zombie; producing one needs a
 * grandchild orphaned to a PID 1 that does not reap, which is precisely the container-specific
 * condition this whole check exists for and therefore the one thing a test may not assume. The
 * seam is the reader, so the test supplies the bytes `/proc` would have contained and the
 * decision under test — "a pid that `kill(pid, 0)` accepts is still dead if procfs says Z" — is
 * exercised for real.
 */
const procStatus = (state: string, name = "appduct"): string => {
  return `Name:\t${name}\nUmask:\t0022\nState:\t${state}\nTgid:\t1\n`;
};

describe("isProcessAlive", () => {
  test("a running process is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("a genuinely-exited process is dead", () => {
    expect(isProcessAlive(deadPid())).toBe(false);
  });

  test("a zombie is dead, even though process.kill(pid, 0) succeeds for it", () => {
    // `process.pid` is the one pid guaranteed to pass `kill(pid, 0)` here, so using it isolates
    // the assertion to the procfs half: without the zombie check this is unconditionally `true`.
    expect(isProcessAlive(process.pid, () => procStatus("Z (zombie)"))).toBe(false);
  });

  test("every other process state is left alone", () => {
    for (const state of ["R (running)", "S (sleeping)", "D (disk sleep)", "T (stopped)", "I (idle)"]) {
      expect(isProcessAlive(process.pid, () => procStatus(state))).toBe(true);
    }
  });

  test("an unreadable /proc leaves process.kill(pid, 0)'s answer standing", () => {
    // What macOS, Windows, a hardened container and a pid we lack permission on all look like.
    // Falling back to "alive" here is the safe direction: declaring a live daemon dead would have
    // the next command clobber its pidfile and socket out from under it.
    const unreadable: ProcStatusReader = () => undefined;

    expect(isProcessAlive(process.pid, unreadable)).toBe(true);
    expect(isProcessAlive(deadPid(), unreadable)).toBe(false);
  });

  test("a status that never mentions State is not read as a zombie", () => {
    // Defensive: a truncated read, or a future procfs that reorders fields, must not be able to
    // turn into a "dead" verdict by accident.
    expect(isProcessAlive(process.pid, () => "Name:\tappduct\n")).toBe(true);
    // And `Z` must be the *state*, not merely a letter somewhere on the line.
    expect(isProcessAlive(process.pid, () => procStatus("S (sleeping)", "Zygote"))).toBe(true);
  });
});
