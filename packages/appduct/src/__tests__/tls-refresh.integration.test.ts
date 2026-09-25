/**
 * Review finding: `TlsManager.refresh()` (daemon/tls.ts) existed but was never wired up — the https
 * listener was created once with startup-time cert material and never re-minted, so a long-lived
 * daemon that changed networks kept advertising a stale address with a stale cert SAN. This exercises
 * the fix: `link.create` re-detects the advertised address on every mint, re-mints the leaf cert via
 * `refresh()` when it changed, and applies the new material to the live listener via
 * `httpsServer.setSecureContext` — all without dropping the ability to accept new TLS connections.
 *
 * A real daemon + real pinned-TLS socket is used (per the task-04/05 harness pattern) rather than
 * mocking the listener; only advertised-address detection is faked (via `DaemonOptions.detectAddress`)
 * so the "network changed" case is deterministic without touching `os.networkInterfaces()` globally.
 */

import { connect as connectUds, type Socket } from "node:net";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { makeTempStateDir, removeStateDir } from "./fixtures.js";

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

      const line = buffer.slice(0, newlineIndex);
      socket.destroy();

      const parsed = JSON.parse(line) as { result?: unknown; error?: { message: string; data?: unknown } };

      if (parsed.error) {
        reject(Object.assign(new Error(parsed.error.message), { data: parsed.error.data }));
        return;
      }

      resolve(parsed.result);
    });

    socket.once("error", reject);
  });
};

const connectClient = (daemon: RunningDaemon): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${daemon.listener.port()!}`, { ca: daemon.tls.current().certPem });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
};

describe("TLS re-mint on advertised-IP change", () => {
  test("link.create re-detects the address, re-mints on change, and the listener keeps accepting connections", async () => {
    // `advertisedIp` is deliberately left out: this case injects `detectAddress` below and the
    // whole point is what detection returns, not a configured override.
    const stateDir = await makeTempStateDir({ advertisedIp: undefined }, { prefix: "appduct-tls-refresh-" });
    stateDirs.push(stateDir);

    // Startup consumes the first call (initial mint); the daemon starts advertising "127.0.0.1".
    // The next call ("still 127.0.0.1") must not force a re-mint; the call after that simulates the
    // operator moving networks.
    const addresses = ["127.0.0.1", "127.0.0.1", "10.0.0.5", "10.0.0.5"];
    let callCount = 0;
    const detectAddress = (): { family: 4; address: string } => {
      const address = addresses[Math.min(callCount, addresses.length - 1)]!;
      callCount += 1;
      return { family: 4, address };
    };

    const daemon = await startDaemon({ stateDir, detectAddress });
    runningDaemons.push(daemon);

    const before = (await rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds: 60 })) as {
      endpoint: { address: string };
    };
    expect(before.endpoint.address).toBe("127.0.0.1");

    const after = (await rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds: 60 })) as {
      endpoint: { address: string };
    };
    expect(after.endpoint.address).toBe("10.0.0.5");

    // The re-mint applied a fresh secure context to the *live* https server — new TLS handshakes
    // must still succeed (this is exactly what a bare cert/key swap without `setSecureContext`
    // would fail to achieve: the old context would keep serving the stale SAN, or worse, the server
    // would need a restart).
    const socket = await connectClient(daemon);
    socket.close();

    const status = (await rpcCall(daemon.paths.socketPath, "daemon.status")) as { pid: number };
    expect(status.pid).toBe(process.pid);
  });
});
