/**
 * Daemon lifecycle against a **real, running daemon**: `startDaemon` takes the pidfile, mints TLS
 * material, binds an OS-assigned wss port (ARCHITECTURE.md §3's `wssPort: 0`) and serves the UDS
 * control socket, and every case here drives that socket for real.
 *
 * Split out of `daemon.test.ts`, which keeps the cases that need none of it (config parsing, the
 * line-length cap, `daemon status` against a hand-rolled legacy daemon).
 */

import { spawnSync } from "node:child_process";
import { connect, type Socket } from "node:net";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { decodeBootstrap } from "@appduct/shared";

import { AUDIT_PRUNE_INTERVAL_MS, startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { DaemonAlreadyRunningError } from "../daemon/pidfile.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import { systemTimers, type IntervalHandle, type TimerFns } from "../daemon/timers.js";
import { makeTempStateDir as makeSharedStateDir, removeStateDir } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];

const startTrackedDaemon = async (stateDir: string): Promise<RunningDaemon> => {
  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);
  return daemon;
};

afterEach(async () => {
  while (runningDaemons.length > 0) {
    const daemon = runningDaemons.pop();
    await daemon?.shutdown();
  }
});

/**
 * The shared fixture writes `wssPort: 0` ("bind an OS-assigned port", ARCHITECTURE.md §3). This
 * file used to write no `config.json` at all, so every daemon it started bound the default 8443
 * and collided with any other daemon on the machine — including the ones a second vitest process
 * (another worktree, another agent session) is running at the same time.
 */
const makeTempStateDir = async (): Promise<string> => {
  return makeSharedStateDir({}, { prefix: "appduct-daemon-test-" });
};

/** Reads newline-delimited JSON-RPC responses off a raw socket, resolving each awaited line. */
const createLineReader = (socket: Socket) => {
  let buffer = "";
  const pendingLines: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      const waiter = waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        pendingLines.push(line);
      }
    }
  });

  return {
    nextLine: (): Promise<string> => {
      const buffered = pendingLines.shift();
      if (buffered !== undefined) {
        return Promise.resolve(buffered);
      }

      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
};

const connectRaw = (socketPath: string): Promise<Socket> => {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
};

describe("daemon lifecycle", () => {
  test("daemon.status round-trips over the real UDS", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startTrackedDaemon(stateDir);

    const paths = getStateDirPaths(stateDir);
    expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.socketPath)).mode & 0o777).toBe(0o600);
    // `audit/` must be tightened explicitly: `mkdir` honors the process umask, which on a common
    // 0o022 umask would otherwise leave it drwxr-xr-x (ARCHITECTURE.md §3: mode 0700).
    expect((await stat(paths.auditDir)).mode & 0o777).toBe(0o700);

    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.status", params: {} })}\n`);
    const line = await reader.nextLine();
    const response = JSON.parse(line);

    expect(response.id).toBe(1);
    expect(response.result).toMatchObject({
      pid: process.pid,
      sessions: [],
    });
    // The state dir asks for an OS-assigned port, so the only correct assertion is that the
    // *bound* port is reported — a status echoing the configured `0` back would be reporting the
    // one number no app can ever connect to.
    expect(response.result.wssPort).toBeGreaterThan(0);
    expect(Number.isInteger(response.result.wssPort)).toBe(true);
    expect(response.result.wssPort).toBe(daemon.listener.port());
    expect(response.result.pinnedKeys).toHaveLength(1);
    expect(response.result.pinnedKeys[0]).toMatch(/^sha256\//u);
    expect(response.result.version).toBeTypeOf("string");
    expect(response.result.startedAt).toBe(daemon.startedAt.toISOString());

    socket.destroy();
    await removeStateDir(stateDir);
  });

  test("wssPort: 0 binds an OS-assigned port, and both daemon.status and a minted link carry it", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startTrackedDaemon(stateDir);
    const paths = getStateDirPaths(stateDir);

    const bound = daemon.listener.port();
    expect(bound).toBeGreaterThan(0);

    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.status", params: {} })}\n`);
    const status = JSON.parse(await reader.nextLine());
    expect(status.result.wssPort).toBe(bound);

    // The link is the part that actually matters to an app: a bootstrap payload advertising the
    // configured `0` would be undialable, and nothing downstream could tell it from a real port.
    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "link.create", params: { ttlSeconds: 60 } })}\n`,
    );
    const link = JSON.parse(await reader.nextLine());
    expect(link.result.endpoint.port).toBe(bound);

    const decoded = decodeBootstrap(link.result.deepLinkPayload);
    expect(decoded).not.toBeNull();
    expect(decoded!.port).toBe(bound);

    // And the bound port is genuinely reachable — `0` was a request, not a literal bind. A plain
    // TCP connect is enough to prove that, and it is all this case is about: what the listener
    // does with the connection (TLS, pinning, the wire protocol) has its own tests.
    const probe = await new Promise<Socket>((resolve, reject) => {
      const connection = connect({ host: "127.0.0.1", port: bound! }, () => resolve(connection));
      connection.once("error", reject);
    });
    probe.destroy();

    socket.destroy();
    await removeStateDir(stateDir);
  });

  test("malformed JSON line gets a JSON-RPC parse error and the connection stays usable", async () => {
    const stateDir = await makeTempStateDir();
    await startTrackedDaemon(stateDir);
    const paths = getStateDirPaths(stateDir);

    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);

    socket.write("{ not json \n");
    const badLineResponse = JSON.parse(await reader.nextLine());
    expect(badLineResponse.error.code).toBe(-32700);

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "daemon.status" })}\n`);
    const goodLineResponse = JSON.parse(await reader.nextLine());
    expect(goodLineResponse.id).toBe(7);
    expect(goodLineResponse.result.pid).toBe(process.pid);

    socket.destroy();
    await removeStateDir(stateDir);
  });

  test("unknown method returns JSON-RPC -32601", async () => {
    const stateDir = await makeTempStateDir();
    await startTrackedDaemon(stateDir);
    const paths = getStateDirPaths(stateDir);

    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nonexistent.method" })}\n`);
    const response = JSON.parse(await reader.nextLine());

    expect(response.error.code).toBe(-32601);

    socket.destroy();
    await removeStateDir(stateDir);
  });

  test("daemon.shutdown acks then closes the socket and removes sock + pid files", async () => {
    const stateDir = await makeTempStateDir();
    const daemon = await startTrackedDaemon(stateDir);
    runningDaemons.pop(); // shutting down manually below; don't double-shutdown in afterEach.
    const paths = getStateDirPaths(stateDir);

    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "daemon.shutdown" })}\n`);
    const response = JSON.parse(await reader.nextLine());
    expect(response.result).toEqual({ ok: true });

    await daemon.exited;

    await expect(stat(paths.socketPath)).rejects.toThrow();
    await expect(stat(paths.pidFilePath)).rejects.toThrow();

    socket.destroy();
    await removeStateDir(stateDir);
  });

  test("second daemon against the same state dir throws DaemonAlreadyRunningError", async () => {
    const stateDir = await makeTempStateDir();
    const first = await startTrackedDaemon(stateDir);

    await expect(startDaemon({ stateDir })).rejects.toThrow(DaemonAlreadyRunningError);

    await first.shutdown();
    await removeStateDir(stateDir);
  });

  test("takes over a stale pidfile and stale socket left by a dead process", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);

    // A genuinely-dead pid: spawn a no-op child and wait for it to exit.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(dead.status).toBe(0);
    const deadPid = dead.pid;
    expect(deadPid).toBeGreaterThan(0);

    await writeFile(paths.pidFilePath, String(deadPid), { mode: 0o600 });
    // A stale socket file (not actually listening) left behind by the "crashed" daemon.
    await writeFile(paths.socketPath, "", { mode: 0o600 });

    const daemon = await startTrackedDaemon(stateDir);

    expect(Number((await readFile(paths.pidFilePath, "utf8")).trim())).toBe(process.pid);
    expect((await stat(paths.socketPath)).mode & 0o777).toBe(0o600);

    // Confirm the socket now actually answers RPC (proof the stale placeholder file was replaced).
    const socket = await connectRaw(paths.socketPath);
    const reader = createLineReader(socket);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.status" })}\n`);
    const response = JSON.parse(await reader.nextLine());
    expect(response.result.pid).toBe(process.pid);

    socket.destroy();
    void daemon;
    await removeStateDir(stateDir);
  });

  test("config.json unknown keys warn instead of throwing", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ totallyUnknownKey: true, wssPort: 0 }));

    const warnings: string[] = [];
    const daemon = await startTrackedDaemon(stateDir);
    void daemon;

    // Re-load directly to also exercise the warn callback in isolation from the running daemon.
    const { loadConfig } = await import("../daemon/config.js");
    const config = await loadConfig(getStateDirPaths(stateDir), {
      warn: (message) => warnings.push(message),
    });

    expect(config.wssPort).toBe(0);
    expect(warnings.some((message) => message.includes("totallyUnknownKey"))).toBe(true);

    await removeStateDir(stateDir);
  });
});


/**
 * Retention wiring (ARCHITECTURE.md §3, issue #32). The audit *policy* — which files are stale, how
 * the day boundary is computed — is covered by `audit-retention.test.ts`; what matters here is that
 * a real daemon actually runs it at startup, keeps running it on the daily seam, reports the
 * footprint over RPC, and does not leave the timer behind on shutdown.
 */
describe("daemon: audit retention", () => {
  /** Interval-only fake: `startDaemon` uses its `timers` seam solely for the daily audit sweep, so
   * everything else (session grace/keepalive, listener pre-claim) keeps running on real timers. */
  const createIntervalRecorder = (): {
    timers: TimerFns;
    intervals: Array<{ callback: () => void; ms: number; cleared: boolean }>;
  } => {
    const intervals: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];

    return {
      intervals,
      timers: {
        ...systemTimers,
        setInterval: (callback, ms) => {
          const record = { callback, ms, cleared: false };
          intervals.push(record);
          return record as unknown as IntervalHandle;
        },
        clearInterval: (handle) => {
          (handle as unknown as { cleared: boolean }).cleared = true;
        },
      },
    };
  };

  const writeDayFile = async (auditDir: string, stamp: string): Promise<void> => {
    await writeFile(path.join(auditDir, `${stamp}.jsonl`), "{}\n", { mode: 0o600 });
  };

  /** Both sweeps are fire-and-forget (`void auditLogger.prune()`), so the assertion polls rather
   * than sleeping on a guessed duration. */
  const waitForAuditDir = async (auditDir: string, expected: string[]): Promise<void> => {
    const deadline = Date.now() + 2000;

    for (;;) {
      const names = (await readdir(auditDir)).sort();

      if (names.join(",") === expected.join(",") || Date.now() > deadline) {
        expect(names).toEqual(expected);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  test("prunes stale day files at startup, again on the daily timer, and clears the timer on shutdown", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(paths.auditDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ auditRetentionDays: 7, wssPort: 0 }));

    await writeDayFile(paths.auditDir, "2026-09-05"); // today per the clock below
    await writeDayFile(paths.auditDir, "2026-08-01"); // stale at startup

    const { timers, intervals } = createIntervalRecorder();
    let now = new Date("2026-09-05T12:00:00.000Z");
    const daemon = await startDaemon({ stateDir, timers, clock: { now: () => now } });
    runningDaemons.push(daemon);

    await waitForAuditDir(paths.auditDir, ["2026-09-05.jsonl"]);

    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.ms).toBe(AUDIT_PRUNE_INTERVAL_MS);

    // A day later the daemon is still running and the sweep still fires — the file that was
    // "today" at startup is now stale enough to go.
    await writeDayFile(paths.auditDir, "2026-09-14");
    now = new Date("2026-09-14T12:00:00.000Z");
    intervals[0]!.callback();
    await waitForAuditDir(paths.auditDir, ["2026-09-14.jsonl"]);

    await daemon.shutdown();
    expect(intervals[0]!.cleared).toBe(true);

    await removeStateDir(stateDir);
  });

  test("daemon.status reports the audit footprint and the effective retention", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(paths.auditDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ auditRetentionDays: 45, wssPort: 0 }));

    // Clock-injected, and the fixture's name is derived from it, for two reasons: the file must
    // be dated relative to the daemon's own idea of "today" rather than the calendar the suite
    // happens to run on, and naming it *today* makes it immune to the fire-and-forget startup
    // sweep that may still be in flight — today's file is the one file pruning can never take.
    const now = new Date("2026-09-05T12:00:00.000Z");
    const daemon = await startDaemon({ stateDir, clock: { now: () => now } });
    runningDaemons.push(daemon);

    const todayFile = `${now.toISOString().slice(0, 10)}.jsonl`;
    await writeFile(path.join(paths.auditDir, todayFile), "x".repeat(120), { mode: 0o600 });

    const socket = await connectRaw(daemon.paths.socketPath);
    const reader = createLineReader(socket);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.status", params: {} })}\n`);
    const response = JSON.parse(await reader.nextLine());

    expect(response.result.audit).toEqual({
      path: paths.auditDir,
      failedWrites: 0,
      failedPrunes: 0,
      retentionDays: 45,
      files: 1,
      bytes: 120,
    });

    socket.destroy();
    await removeStateDir(stateDir);
  });
});
