/**
 * Daemon behaviour that needs **no listener**: `config.json` parsing and validation, the RPC
 * server's own line-length cap, and how `daemon status` renders a daemon that predates a field.
 * Nothing here binds a port, takes the pidfile, or mints TLS material.
 *
 * Everything that starts a real daemon lives in `daemon.integration.test.ts`. The split is not
 * cosmetic: a case that boots the whole daemon to assert a string in an error message pays for a
 * pidfile, a self-signed certificate and a socket it never uses, and fails for reasons that have
 * nothing to do with what it is testing.
 */

import { connect, type Socket } from "node:net";
import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { handleDaemonStatusCommand } from "../commands/daemon/status.js";
import { startDaemon } from "../daemon/daemon.js";
import { startRpcServer } from "../daemon/rpc-server.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import { makeTempStateDir as makeSharedStateDir, removeStateDir } from "./fixtures.js";

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

describe("daemon: config and RPC framing", () => {
  test("a line beyond the configured cap gets an error and the connection is dropped", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { ensureStateDir } = await import("../daemon/state-dir.js");
    await ensureStateDir(stateDir);

    const server = await startRpcServer({
      socketPath: paths.socketPath,
      dispatch: { "daemon.status": () => ({ ok: true }) },
      maxLineBytes: 64,
    });

    try {
      const socket = await connectRaw(paths.socketPath);
      const reader = createLineReader(socket);
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));

      const oversizedLine = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "daemon.status",
        params: { padding: "x".repeat(200) },
      });
      socket.write(`${oversizedLine}\n`);

      const response = JSON.parse(await reader.nextLine());
      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toMatch(/exceeds the 64-byte limit/u);

      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      await server.close();
      await removeStateDir(stateDir);
    }
  });

  test("config.json invalid values throw a clear error naming the key", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ wssPort: "not-a-number" }));

    await expect(startDaemon({ stateDir })).rejects.toThrow(/wssPort/u);

    await removeStateDir(stateDir);
  });

  test("wssPort accepts 0 (OS-assigned) and rejects anything that is not a port number", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    const { loadConfig } = await import("../daemon/config.js");
    await mkdir(stateDir, { recursive: true });

    // The documented default when the key is absent (ARCHITECTURE.md §3).
    await writeFile(paths.configPath, JSON.stringify({}));
    expect((await loadConfig(paths)).wssPort).toBe(8443);

    // `0` is not a degenerate port here but a request for an OS-assigned one, so it must load
    // as-is rather than being rejected by the positive-integer rule every other numeric key uses.
    await writeFile(paths.configPath, JSON.stringify({ wssPort: 0 }));
    expect((await loadConfig(paths)).wssPort).toBe(0);

    await writeFile(paths.configPath, JSON.stringify({ wssPort: 8443 }));
    expect((await loadConfig(paths)).wssPort).toBe(8443);

    // Everything that still is not a port: negatives, non-integers, out-of-range, wrong type.
    for (const invalid of [-1, 1.5, 65_536, "8443", null]) {
      await writeFile(paths.configPath, JSON.stringify({ wssPort: invalid }));
      await expect(loadConfig(paths)).rejects.toThrow(/wssPort/u);
    }

    await removeStateDir(stateDir);
  });

  test("restartDaemonOnVersionMismatch defaults to false and must be a boolean", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    const { loadConfig } = await import("../daemon/config.js");
    await mkdir(stateDir, { recursive: true });

    // Absent: the safe default — never drop an operator's live sessions without being asked.
    await writeFile(paths.configPath, JSON.stringify({}));
    expect((await loadConfig(paths)).restartDaemonOnVersionMismatch).toBe(false);

    await writeFile(paths.configPath, JSON.stringify({ restartDaemonOnVersionMismatch: true }));
    expect((await loadConfig(paths)).restartDaemonOnVersionMismatch).toBe(true);

    // A string is the likely typo (`"true"`), and silently reading it as truthy would be the worst
    // possible failure for a knob whose whole job is guarding session loss.
    await writeFile(paths.configPath, JSON.stringify({ restartDaemonOnVersionMismatch: "true" }));
    await expect(loadConfig(paths)).rejects.toThrow(/restartDaemonOnVersionMismatch/u);

    await removeStateDir(stateDir);
  });
});

/**
 * Retention *reporting* that needs no daemon: how `daemon status` renders a pre-retention daemon
 * (a hand-rolled RPC server, not a real one), and that an invalid retention key fails config
 * loading before anything is started. The wiring — a real daemon actually running the sweep — is
 * in `daemon.integration.test.ts`; the policy itself is in `audit-retention.test.ts`.
 */
describe("daemon: audit retention config and reporting", () => {
  test("daemon status degrades cleanly against a daemon that predates retention", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });

    // A daemon.status exactly as a pre-retention daemon answers it. A running daemon outlives the
    // CLI upgrade that would replace it, so this pairing is reachable in the field.
    const legacyDaemon = await startRpcServer({
      socketPath: paths.socketPath,
      dispatch: {
        "daemon.status": () => ({
          version: "0.6.0",
          pid: 4242,
          startedAt: "2026-09-01T00:00:00.000Z",
          wssPort: 8443,
          pinnedKeys: ["sha256/legacy"],
          sessions: [],
          policy: { default: "allow", destructive: "allow" },
          audit: { path: paths.auditDir, failedWrites: 3 },
        }),
      },
    });

    try {
      const result = await handleDaemonStatusCommand({ stateDir });

      if (!result.ok) {
        throw new Error(`Expected a successful daemon status result, got ${JSON.stringify(result)}`);
      }

      // Reported as absent, not as zero: the CLI was never told, and "0 files retained" would be
      // a different (and false) claim. Asserted as *missing keys* rather than as keys holding
      // `undefined`, since `toEqual` treats those as interchangeable and would pass just as
      // happily against a build that fabricated zeroes... no, worse: against one that read the
      // fields straight through and got `undefined` by accident. The distinction this test exists
      // to protect is the one `toHaveProperty` can see.
      expect(result.data.audit).not.toHaveProperty("failed_prunes");
      expect(result.data.audit).not.toHaveProperty("retention_days");
      expect(result.data.audit).not.toHaveProperty("files");
      expect(result.data.audit).not.toHaveProperty("bytes");
      expect(result.data.audit.path).toBe(paths.auditDir);
      expect(result.data.audit.failed_writes).toBe(3);
      expect(JSON.parse(JSON.stringify(result.data.audit))).toEqual({
        path: paths.auditDir,
        failed_writes: 3,
      });
      expect(result.data.daemon.version).toBe("0.6.0");
    } finally {
      await legacyDaemon.close();
    }

    await removeStateDir(stateDir);
  });

  test("an invalid auditRetentionDays/daemonLogMaxBytes fails the daemon like any other config key", async () => {
    const stateDir = await makeTempStateDir();
    const paths = getStateDirPaths(stateDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });

    await writeFile(paths.configPath, JSON.stringify({ auditRetentionDays: 0 }));
    await expect(startDaemon({ stateDir })).rejects.toThrow(/auditRetentionDays.*positive integer/u);

    await writeFile(paths.configPath, JSON.stringify({ daemonLogMaxBytes: 1.5 }));
    await expect(startDaemon({ stateDir })).rejects.toThrow(/daemonLogMaxBytes.*positive integer/u);

    await removeStateDir(stateDir);
  });
});
