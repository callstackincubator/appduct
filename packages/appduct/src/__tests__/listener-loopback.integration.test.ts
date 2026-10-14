/**
 * Issue #249: a client dialing `127.0.0.1:<wss port>` must always reach the daemon. On macOS a
 * listener bound only to the wildcard address lets another process bind `127.0.0.1` on the same
 * port, and loopback dialers then reach that process instead. Every case drives a real daemon.
 */

import { X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:net";
import { connect as connectTls } from "node:tls";

import { afterEach, describe, expect, test } from "vitest";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { makeTempStateDir, removeStateDir } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];
const otherServers: Server[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (otherServers.length > 0) {
    const server = otherServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  while (stateDirs.length > 0) {
    await removeStateDir(stateDirs.pop()!);
  }
});

const startTestDaemon = async (config: Record<string, unknown> = {}): Promise<RunningDaemon> => {
  const stateDir = await makeTempStateDir(config, { prefix: "appduct-loopback-" });
  stateDirs.push(stateDir);

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);

  return daemon;
};

/** Another program's server on `127.0.0.1:<port>`. Resolves once bound, rejects with the bind error. */
const bindOtherServer = (port: number): Promise<Server> => {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      otherServers.push(server);
      resolve(server);
    });
  });
};

const boundPort = (server: Server): number => {
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("expected a TCP server");
  }

  return address.port;
};

describe("the daemon's TLS listener on loopback", () => {
  test("owns 127.0.0.1 on its OS-assigned port, so no other program can bind it", async () => {
    const daemon = await startTestDaemon();
    const port = daemon.listener.port()!;

    await expect(bindOtherServer(port)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  test("refuses to start on a configured port another program holds on 127.0.0.1", async () => {
    const other = await bindOtherServer(0);
    const port = boundPort(other);

    await expect(startTestDaemon({ wssPort: port })).rejects.toThrow(new RegExp(`${port}.*in use`, "u"));
  });

  test("completes a TLS handshake on 127.0.0.1 with the daemon's certificate", async () => {
    const daemon = await startTestDaemon();
    const port = daemon.listener.port()!;
    const { certPem } = daemon.tls.current();
    const expected = new X509Certificate(certPem).raw;

    const presented = await new Promise<Buffer>((resolve, reject) => {
      const socket = connectTls({ host: "127.0.0.1", port, ca: certPem }, () => {
        const raw = socket.getPeerCertificate().raw;
        socket.destroy();
        resolve(raw);
      });

      socket.once("error", reject);
    });

    expect(presented.equals(expected)).toBe(true);
  });
});
