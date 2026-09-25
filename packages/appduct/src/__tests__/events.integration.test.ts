/**
 * `appduct events tail --json` (ARCHITECTURE.md §10): spawns the CLI as a subprocess and asserts
 * line-delimited parseability. Drives a real daemon (auto-spawned by the first
 * CLI call) and a real `events tail` subprocess, asserts each stdout line is independently
 * parseable NDJSON carrying an app event, then confirms Ctrl-C (SIGINT) ends the stream cleanly
 * (exit 0).
 */

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { decodeBootstrap } from "@appduct/shared";

import {
  makeTempStateDir as makeSharedStateDir,
  removeStateDir,
  runCliBinary,
  spawnCliBinary,
  waitForExit,
} from "./fixtures.js";

// Client pinning is the app's job; this test skips it client-side for its throwaway self-signed key.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const stateDirs: string[] = [];
const daemonPids: number[] = [];

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  while (daemonPids.length > 0) {
    const pid = daemonPids.pop()!;
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  while (stateDirs.length > 0) {
    await removeStateDir(stateDirs.pop()!);
  }
});

const makeTempStateDir = async (): Promise<{ stateDir: string }> => {
  const directory = await makeSharedStateDir({}, { prefix: "appduct-events-cli-" });

  stateDirs.push(directory);
  return { stateDir: directory };
};

const runCliJson = (args: string[], stateDir: string) => {
  const result = runCliBinary([...args, "--json"], { stateDir });

  return JSON.parse(result.stdout);
};

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> => {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
};

/** Mints a link via the CLI, claims it over a fresh `ws` socket, and returns the claimed device's
 * identity plus the open socket (caller closes it). */
const claimAppOverCli = async (
  stateDir: string,
): Promise<{ socket: WebSocket; alias: string; sessionId: string }> => {
  const linkResult = runCliJson(["sessions", "link", "--ttl", "30", "--scheme", "appduct-events-since-test"], stateDir);
  expect(linkResult.ok).toBe(true);

  const payload = (linkResult.data.deepLink as string).split("appduct=")[1]!.split("&")[0]!;
  const decoded = decodeBootstrap(payload)!;

  // The bootstrap payload carries the port the daemon actually bound - the state dir's
  // `wssPort: 0` deliberately names none, and this is the very number a real app would dial.
  const port = decoded.port;

  const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  socket.send(
    JSON.stringify({
      type: "session_claim",
      protocol_version: 2,
      session_id: decoded.sessionId,
      token: decoded.token,
      device_model: "Pixel 8",
    }),
  );
  const ack = await nextMessage(socket);

  return { socket, alias: ack.alias as string, sessionId: decoded.sessionId };
};

describe("appduct events tail --json", () => {
  test("streams only app_event lines as NDJSON and exits 0 on SIGINT", async () => {
    const { stateDir } = await makeTempStateDir();

    // `daemon status` both auto-spawns the daemon and gives us its pid for cleanup.
    const status = runCliJson(["daemon", "status"], stateDir);
    expect(status.ok).toBe(true);
    daemonPids.push(status.data.daemon.pid);

    const eventsProcess = spawnCliBinary(["events", "tail", "--json"], { stateDir });

    const lines: string[] = [];
    let buffered = "";
    const appEventSeen = new Promise<void>((resolve) => {
      (async () => {
        for await (const chunk of eventsProcess.stdout) {
          buffered += chunk.toString("utf8");
          let newlineIndex = buffered.indexOf("\n");

          while (newlineIndex !== -1) {
            const line = buffered.slice(0, newlineIndex);
            buffered = buffered.slice(newlineIndex + 1);

            if (line.length > 0) {
              lines.push(line);

              if (JSON.parse(line).kind === "app_event") {
                resolve();
              }
            }

            newlineIndex = buffered.indexOf("\n");
          }
        }
      })();
    });

    // Give the events subprocess a moment to connect and subscribe before minting the link, so the
    // link and claim events it must not print are actually sent its way.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { socket, sessionId } = await claimAppOverCli(stateDir);
    socket.send(JSON.stringify({ type: "event", session_id: sessionId, name: "greeting", ts: Date.now() }));

    await Promise.race([
      appEventSeen,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for an app_event line")), 5000)),
    ]);

    // Every line must be independently parseable NDJSON, and the link and claim that came first
    // must not have been printed.
    expect(lines.map((line) => JSON.parse(line).kind)).toEqual(["app_event"]);
    expect(JSON.parse(lines[0]!)).toHaveProperty("ts");

    eventsProcess.kill("SIGINT");
    const exitCode = await waitForExit(eventsProcess);
    expect(exitCode).toBe(0);

    socket.close();
    const stopResult = runCliJson(["daemon", "stop"], stateDir);
    expect(stopResult.ok).toBe(true);
  }, 15_000);

  test("events since pulls only retained app events one-shot for a claimed session, and a later pull with the returned cursor sees nothing new", async () => {
    const { stateDir } = await makeTempStateDir();

    const status = runCliJson(["daemon", "status"], stateDir);
    expect(status.ok).toBe(true);
    daemonPids.push(status.data.daemon.pid);

    const { socket, alias, sessionId } = await claimAppOverCli(stateDir);
    socket.send(JSON.stringify({ type: "event", session_id: sessionId, name: "greeting", ts: Date.now() }));
    // The claim ack round-trip already guarantees `session_claimed` landed; give the `event` frame a
    // beat to reach the daemon and land in the retention buffer before pulling.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Attach the data listener before the process can exit — the child's stdout write and its
    // `process.exit()` race the parent's own read otherwise, and a `for await` started only once
    // the child has already exited can end up seeing nothing.
    const sinceProcess = spawnCliBinary(["events", "since", alias, "0", "--json"], { stateDir });
    let stdout = "";
    sinceProcess.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    expect(await waitForExit(sinceProcess)).toBe(0);

    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(1); // at least one event line plus the trailing cursor line

    // The last line is the trailing `{"cursor":N,"dropped":N,"remaining":N}` marker (issue #6,
    // extended by #113/#115: a scripted caller shouldn't have to reconstruct the resume point by
    // maxing `seq` over the event lines, which is impossible when the response is empty, and
    // needs `dropped`/`remaining` to know whether it missed anything or more pages remain);
    // everything before it is an event.
    const cursorLine = JSON.parse(lines[lines.length - 1]!) as { cursor: number; dropped: number; remaining: number };
    const eventLines = lines.slice(0, -1);

    for (const line of eventLines) {
      expect(JSON.parse(line)).toHaveProperty("seq");
    }

    // The session's claim is not printed, only the app's own event.
    expect(eventLines.map((line) => JSON.parse(line).kind)).toEqual(["app_event"]);

    const drainedProcess = spawnCliBinary(["events", "since", alias, String(cursorLine.cursor), "--json"], { stateDir });
    let drainedStdout = "";
    drainedProcess.stdout.on("data", (chunk: Buffer) => {
      drainedStdout += chunk.toString("utf8");
    });
    expect(await waitForExit(drainedProcess)).toBe(0);

    // Nothing new since the cursor: only the trailing cursor line itself, no event lines, and
    // nothing dropped or remaining.
    const drainedLines = drainedStdout.split("\n").filter((line) => line.length > 0);
    expect(drainedLines).toHaveLength(1);
    expect(JSON.parse(drainedLines[0]!)).toEqual({ cursor: cursorLine.cursor, dropped: 0, remaining: 0 });

    socket.close();
    const stopResult = runCliJson(["daemon", "stop"], stateDir);
    expect(stopResult.ok).toBe(true);
  }, 15_000);

  test("events since 0 --name filters to only the app events matching the glob (issue #115)", async () => {
    const { stateDir } = await makeTempStateDir();

    const status = runCliJson(["daemon", "status"], stateDir);
    expect(status.ok).toBe(true);
    daemonPids.push(status.data.daemon.pid);

    const { socket, alias, sessionId } = await claimAppOverCli(stateDir);
    socket.send(JSON.stringify({ type: "event", session_id: sessionId, name: "checkout_ok", ts: Date.now() }));
    socket.send(JSON.stringify({ type: "event", session_id: sessionId, name: "checkout_failed", ts: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const sinceProcess = spawnCliBinary(["events", "since", alias, "0", "--name", "*_failed", "--json"], { stateDir });
    let stdout = "";
    sinceProcess.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    expect(await waitForExit(sinceProcess)).toBe(0);

    const lines = stdout.split("\n").filter((line) => line.length > 0);
    const eventLines = lines.slice(0, -1);

    expect(eventLines).toHaveLength(1);
    expect(JSON.parse(eventLines[0]!).data.name).toBe("checkout_failed");

    socket.close();
    const stopResult = runCliJson(["daemon", "stop"], stateDir);
    expect(stopResult.ok).toBe(true);
  }, 15_000);

  test("events tail --name filters to only the app events matching the glob (issue #115)", async () => {
    const { stateDir } = await makeTempStateDir();

    const status = runCliJson(["daemon", "status"], stateDir);
    expect(status.ok).toBe(true);
    daemonPids.push(status.data.daemon.pid);

    const eventsProcess = spawnCliBinary(["events", "tail", "--json", "--name", "*_failed"], { stateDir });

    const lines: string[] = [];
    let buffered = "";
    const appEventSeen = new Promise<void>((resolve) => {
      (async () => {
        for await (const chunk of eventsProcess.stdout) {
          buffered += chunk.toString("utf8");
          let newlineIndex = buffered.indexOf("\n");

          while (newlineIndex !== -1) {
            const line = buffered.slice(0, newlineIndex);
            buffered = buffered.slice(newlineIndex + 1);

            if (line.length > 0) {
              lines.push(line);

              if (JSON.parse(line).kind === "app_event") {
                resolve();
              }
            }

            newlineIndex = buffered.indexOf("\n");
          }
        }
      })();
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    const { socket, sessionId } = await claimAppOverCli(stateDir);
    socket.send(JSON.stringify({ type: "event", session_id: sessionId, name: "checkout_ok", ts: Date.now() }));
    socket.send(JSON.stringify({ type: "event", session_id: sessionId, name: "checkout_failed", ts: Date.now() }));

    await Promise.race([
      appEventSeen,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for an app_event line")), 5000)),
    ]);

    // Give a possible (wrongly) unfiltered "checkout_ok" line a moment to also arrive before
    // asserting on the final set.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(lines.map((line) => JSON.parse(line).kind)).toEqual(["app_event"]);
    expect(JSON.parse(lines[0]!).data.name).toBe("checkout_failed");

    eventsProcess.kill("SIGINT");
    const exitCode = await waitForExit(eventsProcess);
    expect(exitCode).toBe(0);

    socket.close();
    const stopResult = runCliJson(["daemon", "stop"], stateDir);
    expect(stopResult.ok).toBe(true);
  }, 15_000);

  test("events since 0 --payload-max-bytes truncates a payload over the cap; without the flag it is returned whole (issue #115)", async () => {
    const { stateDir } = await makeTempStateDir();

    const status = runCliJson(["daemon", "status"], stateDir);
    expect(status.ok).toBe(true);
    daemonPids.push(status.data.daemon.pid);

    const { socket, alias, sessionId } = await claimAppOverCli(stateDir);
    const bigPayload = { blob: "x".repeat(5000) };
    socket.send(JSON.stringify({ type: "event", session_id: sessionId, name: "big", payload: bigPayload, ts: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const wholeProcess = spawnCliBinary(["events", "since", alias, "0", "--json"], { stateDir });
    let wholeStdout = "";
    wholeProcess.stdout.on("data", (chunk: Buffer) => {
      wholeStdout += chunk.toString("utf8");
    });
    expect(await waitForExit(wholeProcess)).toBe(0);
    const wholeLines = wholeStdout.split("\n").filter((line) => line.length > 0);
    const wholeEvent = JSON.parse(wholeLines[0]!).data;
    expect(wholeEvent.payload).toEqual(bigPayload);
    expect(wholeEvent.truncated).toBeUndefined();

    const cappedProcess = spawnCliBinary(
      ["events", "since", alias, "0", "--payload-max-bytes", "100", "--json"],
      { stateDir },
    );
    let cappedStdout = "";
    cappedProcess.stdout.on("data", (chunk: Buffer) => {
      cappedStdout += chunk.toString("utf8");
    });
    expect(await waitForExit(cappedProcess)).toBe(0);
    const cappedLines = cappedStdout.split("\n").filter((line) => line.length > 0);
    const cappedEvent = JSON.parse(cappedLines[0]!).data;
    expect(cappedEvent.truncated).toBe(true);
    expect(cappedEvent.payload).toBeUndefined();
    expect(typeof cappedEvent.payloadPreview).toBe("string");

    socket.close();
    const stopResult = runCliJson(["daemon", "stop"], stateDir);
    expect(stopResult.ok).toBe(true);
  }, 15_000);
});
