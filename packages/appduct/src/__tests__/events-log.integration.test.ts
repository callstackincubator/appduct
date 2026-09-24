/**
 * `<stateDir>/events.log` end to end: a real in-process daemon, a scripted app over a real pinned
 * `wss://` socket and raw UDS JSON-RPC, reading the log back from disk.
 */

import { connect as connectUds, type Socket } from "node:net";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";

import { decodeBootstrap, type EventKind, type EventNotification } from "@appduct/shared";

import { AppductConfigError, loadConfig } from "../daemon/config.js";
import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { getStateDirPaths } from "../daemon/state-dir.js";
import { makeTempStateDir, removeStateDir } from "./fixtures.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (stateDirs.length > 0) {
    await removeStateDir(stateDirs.pop()!);
  }
});

const makeStateDir = async (configOverrides: Record<string, unknown> = {}): Promise<string> => {
  const stateDir = await makeTempStateDir(configOverrides, { prefix: "appduct-events-log-" });
  stateDirs.push(stateDir);
  return stateDir;
};

const start = async (stateDir: string, warn?: (message: string) => void): Promise<RunningDaemon> => {
  const daemon = await startDaemon({ stateDir, warn });
  runningDaemons.push(daemon);
  return daemon;
};

/** Shuts `daemon` down now (flushing the log) and drops it from the afterEach sweep. */
const shutdownNow = async (daemon: RunningDaemon): Promise<void> => {
  runningDaemons.splice(runningDaemons.indexOf(daemon), 1);
  await daemon.shutdown();
};

const rpcCall = (socketPath: string, method: string, params?: unknown): Promise<unknown> => {
  return new Promise((resolve, reject) => {
    const socket: Socket = connectUds(socketPath);
    let buffer = "";

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} })}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      socket.destroy();
      const parsed = JSON.parse(buffer.slice(0, newlineIndex)) as { result?: unknown; error?: { message: string } };

      if (parsed.error) {
        reject(new Error(parsed.error.message));
        return;
      }

      resolve(parsed.result);
    });

    socket.once("error", reject);
  });
};

const waitForEvent = (daemon: RunningDaemon, kind: EventKind): Promise<EventNotification> => {
  return new Promise((resolve) => {
    const unsubscribe = daemon.eventBus.subscribe((event) => {
      if (event.kind === kind) {
        unsubscribe();
        resolve(event);
      }
    });
  });
};

type App = { socket: WebSocket; sessionId: string; alias: string };

/** Mints a link over RPC and claims it from a fresh `wss://` socket that answers every tool call
 * with `"ok"`. */
const claimApp = async (daemon: RunningDaemon): Promise<App> => {
  const minted = (await rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds: 60 })) as {
    deepLinkPayload: string;
  };
  const link = decodeBootstrap(minted.deepLinkPayload)!;

  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${daemon.listener.port()!}`, { rejectUnauthorized: false });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });

  const ack = new Promise<Record<string, unknown>>((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>));
  });
  const claimed = waitForEvent(daemon, "session_claimed");
  socket.send(
    JSON.stringify({
      type: "session_claim",
      protocol_version: 2,
      session_id: link.sessionId,
      token: link.token,
      device_model: "Pixel 8",
    }),
  );
  const { alias } = await ack;
  await claimed;

  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

    if (message.type === "tool_call") {
      socket.send(JSON.stringify({ type: "tool_result", session_id: link.sessionId, id: message.id, result: "ok" }));
    }
  });

  const toolsChanged = waitForEvent(daemon, "tools_changed");
  socket.send(
    JSON.stringify({
      type: "tool_registry_snapshot",
      session_id: link.sessionId,
      tools: [{ name: "echo", description: "Echoes." }],
    }),
  );
  await toolsChanged;

  return { socket, sessionId: link.sessionId, alias: alias as string };
};

/** Claims an app, posts an app event, calls a tool and revokes the session. */
const driveOneSession = async (daemon: RunningDaemon): Promise<void> => {
  const app = await claimApp(daemon);

  const appEvent = waitForEvent(daemon, "app_event");
  app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "greeting", ts: Date.now() }));
  await appEvent;

  await rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "echo", args: {} });

  const revoked = waitForEvent(daemon, "session_revoked");
  await rpcCall(daemon.paths.socketPath, "sessions.revoke", { selector: app.alias });
  await revoked;
  app.socket.close();
};

const readLines = async (filePath: string): Promise<EventNotification[]> => {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventNotification);
};

const fileMode = async (filePath: string): Promise<number> => (await stat(filePath)).mode & 0o777;

describe("events.log", () => {
  test("a session claim, a tool call and a session revoke each append one JSON line, at mode 0600, and no app_event ever does", async () => {
    const stateDir = await makeStateDir();
    const daemon = await start(stateDir);

    await driveOneSession(daemon);
    await shutdownNow(daemon);

    const eventsLogPath = path.join(stateDir, "events.log");
    const kinds = (await readLines(eventsLogPath)).map((event) => event.kind);
    const count = (kind: EventKind): number => kinds.filter((k) => k === kind).length;

    expect(count("session_claimed")).toBe(1);
    expect(count("tool_call_started")).toBe(1);
    expect(count("tool_call_finished")).toBe(1);
    expect(count("session_revoked")).toBe(1);
    expect(count("daemon_started")).toBe(1);
    expect(count("app_event")).toBe(0);
    expect(await fileMode(eventsLogPath)).toBe(0o600);
  });

  test("rotates to events.log.1 once over eventsLogMaxBytes, replacing the previous backup and leaving events.log under the cap", async () => {
    const maxBytes = 600;
    const stateDir = await makeStateDir({ eventsLogMaxBytes: maxBytes });
    const daemon = await start(stateDir);

    // Several sessions' worth of events: enough to rotate more than once.
    for (let round = 0; round < 3; round += 1) {
      await driveOneSession(daemon);
    }
    await shutdownNow(daemon);

    const eventsLogPath = path.join(stateDir, "events.log");
    const backupPath = `${eventsLogPath}.1`;
    const backup = await readFile(backupPath, "utf8");
    const backupLines = backup.split("\n").filter((line) => line.length > 0);
    const lastLineBytes = Buffer.byteLength(`${backupLines.at(-1)}\n`);

    expect((await stat(eventsLogPath)).size).toBeLessThanOrEqual(maxBytes);
    // A replaced backup is one over-cap file: without its last line it was still within the cap.
    expect(Buffer.byteLength(backup) - lastLineBytes).toBeLessThanOrEqual(maxBytes);
    expect(backupLines.every((line) => (JSON.parse(line) as EventNotification).kind !== "app_event")).toBe(true);
    expect(await fileMode(backupPath)).toBe(0o600);
  });

  test("a write failure is warned and the daemon keeps serving RPC", async () => {
    const stateDir = await makeStateDir();
    // A directory where the log should be: every append fails.
    await mkdir(path.join(stateDir, "events.log"));
    const warnings: string[] = [];
    const daemon = await start(stateDir, (message) => warnings.push(message));

    await vi.waitFor(() => {
      expect(warnings.some((message) => message.includes("events.log"))).toBe(true);
    });

    await expect(rpcCall(daemon.paths.socketPath, "daemon.status")).resolves.toBeDefined();
    await expect(rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds: 60 })).resolves.toMatchObject({
      deepLinkPayload: expect.any(String),
    });
  });
});

describe("config: eventsLogMaxBytes", () => {
  test("defaults to 10 MiB", async () => {
    const stateDir = await makeStateDir();

    await expect(loadConfig(getStateDirPaths(stateDir))).resolves.toMatchObject({ eventsLogMaxBytes: 10 * 1024 * 1024 });
  });

  test.each([0, -1, 1.5, "big"])("rejects %j like daemonLogMaxBytes", async (value) => {
    const stateDir = await makeStateDir();
    const paths = getStateDirPaths(stateDir);

    await writeFile(paths.configPath, JSON.stringify({ daemonLogMaxBytes: value }));
    const reference = (await loadConfig(paths).then(() => undefined, (error: unknown) => error)) as AppductConfigError;

    await writeFile(paths.configPath, JSON.stringify({ eventsLogMaxBytes: value }));
    const rejection = (await loadConfig(paths).then(() => undefined, (error: unknown) => error)) as AppductConfigError;

    expect(rejection).toBeInstanceOf(AppductConfigError);
    expect(rejection.key).toBe("eventsLogMaxBytes");
    expect(rejection.message).toBe(reference.message.replace("daemonLogMaxBytes", "eventsLogMaxBytes"));
  });
});
