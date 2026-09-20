/**
 * `rpc/client.ts` against a **real daemon** on the other end of the control socket: the direct
 * connect, a real JSON-RPC error, the injected-spawn auto-spawn path, the spawn-lock race, and
 * `openDaemonStream`'s call + server-pushed-notification round-trip.
 *
 * Split out of `rpc-client.test.ts`, which keeps everything the client decides on its own — the
 * version-drift logic in particular, which runs against a hand-rolled fake daemon because a real
 * one can only ever report this build's own version.
 */

import { afterEach, describe, expect, test } from "vitest";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import {
  callDaemon,
  DaemonUnavailableError,
  openDaemonStream,
  resetDaemonVersionChecks,
  type SpawnFn,
} from "../rpc/client.js";
import { makeTempStateDir as makeSharedStateDir, removeStateDir } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  // The per-process version-check cache is global; leaking it would skip the next test's check.
  resetDaemonVersionChecks();

  while (stateDirs.length > 0) {
    await removeStateDir(stateDirs.pop()!);
  }
});

/** The shared fixture's `wssPort: 0` matters here: this file's ancestor wrote no `config.json` at
 * all, so every `startDaemon` below bound the default 8443 and raced every other daemon on the
 * machine — including the ones a second vitest process is running. */
const makeTempStateDir = async (): Promise<string> => {
  const stateDir = await makeSharedStateDir({}, { prefix: "appduct-rpc-client-integration-" });
  stateDirs.push(stateDir);
  return stateDir;
};

describe("callDaemon against a real daemon", () => {
  test("connects directly when a daemon is already listening", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startDaemon({ stateDir });
    runningDaemons.push(daemon);

    const status = await callDaemon<{ pid: number }>(
      "daemon.status",
      {},
      { stateDir, autoSpawn: false },
    );

    expect(status.pid).toBe(process.pid);

    await removeStateDir(stateDir);
  });

  test("propagates a JSON-RPC error for an unknown method", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startDaemon({ stateDir });
    runningDaemons.push(daemon);

    await expect(
      callDaemon("nonexistent.method", {}, { stateDir, autoSpawn: false }),
    ).rejects.toThrow(/Method not found/u);

    await removeStateDir(stateDir);
  });

  test("auto-spawns an in-process daemon via the injected spawn fn and retries the request", async () => {
    const stateDir = await makeTempStateDir();
    let spawnCalls = 0;

    const spawn: SpawnFn = async (args, context) => {
      spawnCalls += 1;
      expect(args).toEqual(["daemon", "run"]);
      expect(context.stateDir).toBe(stateDir);

      const daemon = await startDaemon({ stateDir: context.stateDir });
      runningDaemons.push(daemon);
    };

    const status = await callDaemon<{ pid: number }>(
      "daemon.status",
      {},
      { stateDir, autoSpawn: true, spawn, spawnPollIntervalMs: 20, spawnWaitTimeoutMs: 2000 },
    );

    expect(spawnCalls).toBe(1);
    expect(status.pid).toBe(process.pid);

    await removeStateDir(stateDir);
  });

  test("concurrent auto-spawn race results in exactly one spawn (spawn-lock)", async () => {
    const stateDir = await makeTempStateDir();
    let spawnCalls = 0;

    const spawn: SpawnFn = async (_args, context) => {
      spawnCalls += 1;
      // Simulate real spawn latency so both callers are genuinely racing.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const daemon = await startDaemon({ stateDir: context.stateDir });
      runningDaemons.push(daemon);
    };

    const options = {
      stateDir,
      autoSpawn: true,
      spawn,
      spawnPollIntervalMs: 20,
      spawnWaitTimeoutMs: 3000,
    } as const;

    const [first, second] = await Promise.all([
      callDaemon<{ pid: number }>("daemon.status", {}, options),
      callDaemon<{ pid: number }>("daemon.status", {}, options),
    ]);

    expect(spawnCalls).toBe(1);
    expect(first.pid).toBe(process.pid);
    expect(second.pid).toBe(process.pid);
    expect(runningDaemons).toHaveLength(1);

    await removeStateDir(stateDir);
  });
});

describe("openDaemonStream", () => {
  test("supports calls and delivers server-pushed notifications", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startDaemon({ stateDir });
    runningDaemons.push(daemon);

    const stream = await openDaemonStream({ stateDir, autoSpawn: false });

    try {
      const status = await stream.call<{ pid: number }>("daemon.status");
      expect(status.pid).toBe(process.pid);

      const received: unknown[] = [];
      const unsubscribe = stream.onNotification((payload) => {
        received.push(payload);
      });

      const [connection] = daemon.server.connections();
      expect(connection).toBeDefined();
      daemon.server.notify(connection!, { kind: "daemon_started", ts: 123, data: null });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toEqual([{ kind: "daemon_started", ts: 123, data: null }]);

      unsubscribe();
    } finally {
      stream.close();
    }

    await removeStateDir(stateDir);
  });
});
