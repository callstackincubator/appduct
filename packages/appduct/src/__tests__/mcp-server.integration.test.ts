/**
 * The MCP server (ARCHITECTURE.md §9) proxying a **real** daemon's RPC surface. Drives a real
 * daemon + fake app-client (same harness pattern as `tool-invocation.integration.test.ts`), and
 * drives the MCP server with the SDK's own `Client` (over `InMemoryTransport` for the functional
 * cases, over a real `StdioServerTransport` wired to plain Node streams for the stdout-purity
 * assertion).
 *
 * Only what genuinely needs the real transport lives here: a declared `timeout_ms` surviving the
 * whole round trip, progress correlation over the second daemon stream, cancellation reaching the
 * app as `tool_cancel`, the `appduct_connect`/`appduct_wait_for_session` delivery paths, the
 * events tools, the `appduct://sessions` resource, stdout purity, and version drift. The
 * list/describe/call built-ins' own behaviour lives in `mcp-server.test.ts`, which runs them
 * against an in-memory daemon.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { connect as connectUds, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { decodeBootstrap, RPC_METHODS, type ToolDescriptor } from "@appduct/shared";

import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { createMcpServer, type McpServerHandle } from "../mcp/server.js";
import type { ExecFn } from "../cli/open-target.js";
import { DAEMON_VERSION_OVERRIDE_ENV, getPackageVersion } from "../package-version.js";
import { openDaemonStream, resetDaemonVersionChecks, type SpawnFn } from "../rpc/client.js";
import { makeTempStateDir, removeStateDir } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];
const mcpHandles: McpServerHandle[] = [];

afterEach(async () => {
  // Issue #30's daemon-version seam and per-process check cache are both process-global; leaking
  // either would silently change what the next test's daemon reports, or skip its check entirely.
  delete process.env[DAEMON_VERSION_OVERRIDE_ENV];
  resetDaemonVersionChecks();

  while (mcpHandles.length > 0) {
    await mcpHandles.pop()?.close();
  }

  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (stateDirs.length > 0) {
    await removeStateDir(stateDirs.pop()!);
  }
});

const failIfCalled = (): never => {
  throw new Error("auto-spawn should never be needed: the test daemon is already running.");
};

type TestDaemon = {
  daemon: RunningDaemon;
  stateDir: string;
};

const startTestDaemon = async (extraConfig: Record<string, unknown> = {}): Promise<TestDaemon> => {
  const stateDir = await makeTempStateDir({ scheme: "appduct", ...extraConfig }, { prefix: "appduct-mcp-" });
  stateDirs.push(stateDir);

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);

  return { daemon, stateDir };
};

/** A project root (distinct from the state dir — `appId` resolution never reads the state dir's
 * config.json; see `resolveAppId`) carrying its own `.appduct/config.json`, for tests that
 * exercise `appduct_connect`'s project-config tier of `appId` resolution. */
const writeProjectConfig = async (config: Record<string, unknown>): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "appduct-mcp-project-"));
  stateDirs.push(root);

  const dir = path.join(root, ".appduct");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), JSON.stringify(config));

  return root;
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

const waitForEvent = (daemon: RunningDaemon, kind: string): Promise<{ kind: string; sessionId?: string; alias?: string }> => {
  return new Promise((resolve) => {
    const unsubscribe = daemon.eventBus.subscribe((event) => {
      if (event.kind === kind) {
        unsubscribe();
        resolve(event as { kind: string; sessionId?: string; alias?: string });
      }
    });
  });
};

/** The daemon's `config.json` asks for an OS-assigned port (`wssPort: 0`), so the real port is
 * only knowable from the listener that bound it — never pre-picked, which is what used to race
 * another vitest process for the same number. */
const connectClient = (daemon: RunningDaemon): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${daemon.listener.port()!}`, { ca: daemon.tls.current().certPem });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
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

type ClaimedApp = {
  socket: WebSocket;
  sessionId: string;
  alias: string;
};

const createLinkAndDecode = async (
  daemon: RunningDaemon,
): Promise<{ sessionId: string; token: string }> => {
  const result = (await rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds: 60 })) as {
    deepLinkPayload: string;
  };
  const decoded = decodeBootstrap(result.deepLinkPayload);
  expect(decoded).not.toBeNull();

  return { sessionId: decoded!.sessionId, token: decoded!.token };
};

const claimApp = async (daemon: RunningDaemon, deviceModel = "Pixel 8"): Promise<ClaimedApp> => {
  const link = await createLinkAndDecode(daemon);
  const socket = await connectClient(daemon);

  const claimed = waitForEvent(daemon, "session_claimed");
  socket.send(
    JSON.stringify({
      type: "session_claim",
      protocol_version: 2,
      session_id: link.sessionId,
      token: link.token,
      device_model: deviceModel,
    }),
  );
  const ack = await nextMessage(socket);
  await claimed;

  return { socket, sessionId: link.sessionId, alias: ack.alias as string };
};

const snapshotTools = async (
  daemon: RunningDaemon,
  app: ClaimedApp,
  tools: Array<Partial<ToolDescriptor> & { name: string }>,
): Promise<void> => {
  const toolsChanged = waitForEvent(daemon, "tools_changed");
  app.socket.send(
    JSON.stringify({
      type: "tool_registry_snapshot",
      session_id: app.sessionId,
      tools: tools.map((tool) => ({ description: "A test tool.", ...tool })),
    }),
  );
  await toolsChanged;
};

/** `xcrun`/`adb` stub reporting an empty machine. `appduct_connect` auto-detects a delivery
 * target when none is given, so without an injected `exec` these tests would shell out to the real
 * toolchain and behave differently depending on whether the developer running them happens to have
 * a simulator booted. Tests that want a device inject their own. */
const noDevicesExec: ExecFn = async (command) => {
  if (command === "xcrun") {
    return { stdout: JSON.stringify({ devices: {} }), stderr: "" };
  }

  return { stdout: "List of devices attached\n\n", stderr: "" };
};

const createMcpHandle = async (
  stateDir: string,
  exec: ExecFn = noDevicesExec,
  cwd?: string,
): Promise<McpServerHandle> => {
  const handle = await createMcpServer({
    stateDir,
    spawn: failIfCalled,
    scheme: "appduct",
    cwd,
    exec,
    env: {},
  });
  mcpHandles.push(handle);
  return handle;
};

/** Connects an SDK `Client` to `handle` over an in-process linked transport pair. */
const connectInMemoryClient = async (handle: McpServerHandle): Promise<Client> => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
};

describe("mcp: calling app tools", () => {
  test("a tool declaring a timeoutMs above the daemon default gets it, over MCP, end to end (issue #25)", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);
    // 20 s > DEFAULT_CALL_TIMEOUT_MS (10 s): before this fix the descriptor's timeout never left
    // the app, the daemon applied its 10 s default, and the answer below arrived to a call that
    // had already been rejected as `tool_timeout`. The gap between the 11 s reply and this 20 s
    // deadline is headroom for a slow runner, so drift cannot turn this into a real timeout.
    await snapshotTools(daemon, app, [
      { name: "slow-login", timeout_ms: 20_000 },
    ]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    // The app tool is not an MCP tool of its own; its declared deadline is visible to an agent
    // through appduct_describe_tool, and is what appduct_call_tool runs it under.
    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    expect(listed.tools.map((tool) => tool.name)).not.toContain("slow-login");

    const described = await client.request(
      { method: "tools/call", params: { name: "appduct_describe_tool", arguments: { name: "slow-login" } } },
      CallToolResultSchema,
    );
    expect(described.structuredContent).toMatchObject({ name: "slow-login", timeout_ms: 20_000 });

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        setTimeout(() => {
          app.socket.send(
            JSON.stringify({
              type: "tool_result",
              session_id: app.sessionId,
              id: msg.id,
              result: { loggedIn: true },
            }),
          );
        }, 11_000);
      }
    });

    const called = await client.request(
      { method: "tools/call", params: { name: "appduct_call_tool", arguments: { name: "slow-login", args: {} } } },
      CallToolResultSchema,
      // Above the MCP server's own derived transport timeout (20 s + 5 s slack) so this client's
      // watchdog can never be what the assertion actually measures.
      { timeout: 35_000 },
    );

    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toEqual({ loggedIn: true });

    app.socket.close();
  }, 45_000);

  test("appduct_list_tools passes filter/limit/offset to the real daemon, which rejects bad values as it does for the CLI", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);
    await snapshotTools(daemon, app, [{ name: "cart_add" }, { name: "cart_clear" }, { name: "login" }]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const page = await client.request(
      { method: "tools/call", params: { name: "appduct_list_tools", arguments: { filter: "cart", limit: 1 } } },
      CallToolResultSchema,
    );
    expect(page.structuredContent).toMatchObject({ total: 2, limit: 1, tools: [{ name: "cart_add" }] });

    for (const bad of [{ limit: 0 }, { offset: -1 }, { limit: 1.5 }]) {
      const rejected = await client.request(
        { method: "tools/call", params: { name: "appduct_list_tools", arguments: bad } },
        CallToolResultSchema,
      );
      expect(rejected.isError).toBe(true);
      expect((rejected.content[0] as { text: string }).text).toContain("invalid_request");
    }

    app.socket.close();
  });

  test("appduct_list_tools narrows to a group on the real daemon, and grouped tools describe and call like any other", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);
    await snapshotTools(daemon, app, [
      { name: "pay", group: "checkout/payment" },
      { name: "begin", group: "checkout" },
      { name: "ping" },
    ]);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const listed = await client.request(
      { method: "tools/call", params: { name: "appduct_list_tools", arguments: { group: "checkout" } } },
      CallToolResultSchema,
    );
    expect(listed.structuredContent).toMatchObject({
      total: 2,
      tools: [
        { name: "begin", group: "checkout" },
        { name: "pay", group: "checkout/payment" },
      ],
      groups: [
        { group: "checkout", total: 2 },
        { group: "checkout/payment", total: 1 },
        { group: null, total: 1 },
      ],
    });

    const badGroup = await client.request(
      { method: "tools/call", params: { name: "appduct_list_tools", arguments: { group: "a/b/c" } } },
      CallToolResultSchema,
    );
    expect(badGroup.isError).toBe(true);
    expect((badGroup.content[0] as { text: string }).text).toContain("invalid_request");

    const described = await client.request(
      { method: "tools/call", params: { name: "appduct_describe_tool", arguments: { name: "pay" } } },
      CallToolResultSchema,
    );
    expect(described.structuredContent).toMatchObject({ name: "pay", group: "checkout/payment" });

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        app.socket.send(
          JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: { paid: true } }),
        );
      }
    });

    const called = await client.request(
      { method: "tools/call", params: { name: "appduct_call_tool", arguments: { name: "pay" } } },
      CallToolResultSchema,
    );
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toEqual({ paid: true });

    app.socket.close();
  });

  test("tool_call_progress frames map to MCP progress notifications when the client sends a progressToken", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);
    await snapshotTools(daemon, app, [{ name: "slow" }]);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;

      if (msg.type === "tool_call") {
        app.socket.send(
          JSON.stringify({ type: "tool_call_progress", session_id: app.sessionId, id: msg.id, progress: 0.5, message: "halfway" }),
        );
        setTimeout(() => {
          app.socket.send(
            JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: "done" }),
          );
        }, 50);
      }
    });

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const progressUpdates: Array<{ progress: number; message?: string }> = [];

    const called = await client.request(
      { method: "tools/call", params: { name: "appduct_call_tool", arguments: { name: "slow", args: {} } } },
      CallToolResultSchema,
      {
        onprogress: (progress) => {
          progressUpdates.push({ progress: progress.progress, message: progress.message });
        },
      },
    );

    expect(called.isError).not.toBe(true);
    expect(progressUpdates).toEqual([{ progress: 0.5, message: "halfway" }]);

    app.socket.close();
  });

  test("an MCP client's notifications/cancelled forwards to the app as tool_cancel (issue #9)", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);
    await snapshotTools(daemon, app, [{ name: "slow" }]);

    const receivedByApp: Record<string, unknown>[] = [];
    const gotToolCancel = new Promise<Record<string, unknown>>((resolve) => {
      app.socket.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        receivedByApp.push(msg);
        // Deliberately never reply to tool_call — the point is that cancellation reaches the app
        // while the call is still pending.
        if (msg.type === "tool_cancel") {
          resolve(msg);
        }
      });
    });

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const controller = new AbortController();
    const callPromise = client
      .request(
        { method: "tools/call", params: { name: "appduct_call_tool", arguments: { name: "slow", args: {} } } },
        CallToolResultSchema,
        // `onprogress` is what makes the SDK attach a progressToken — required for the server's
        // progress-correlation path (mcp/server.ts's callAppTool) to ever learn `callId`.
        { onprogress: () => {}, signal: controller.signal },
      )
      .catch(() => {
        // The SDK rejects the client-side promise locally as soon as it sends the cancellation —
        // that's the SDK's own behavior, not what this test is verifying.
      });

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (receivedByApp.some((msg) => msg.type === "tool_call")) {
          resolve();
        }
      };
      app.socket.on("message", check);
      check();
    });

    controller.abort("user cancelled");

    const cancelMessage = await gotToolCancel;
    expect(cancelMessage).toMatchObject({ type: "tool_cancel", session_id: app.sessionId, reason: "mcp_client_cancelled" });

    const toolCallMessage = receivedByApp.find((msg) => msg.type === "tool_call");
    expect(cancelMessage.id).toBe(toolCallMessage?.id);

    await callPromise;
    app.socket.close();
  });

});

describe("mcp: appduct_connect / appduct_wait_for_session", () => {
  test("no target and no device available: falls back to a QR, with instructions to show it", async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      sessionId: string;
      deepLink: string;
      qr: string;
      note: string;
      instructions: string;
      delivered?: true;
    };
    expect(data.sessionId).toBeTruthy();
    expect(data.qr.length).toBeGreaterThan(0);
    expect(data.delivered).toBeUndefined();
    expect(data.note).toMatch(/no booted iOS simulator or attached Android device/iu);
    // The agent has to be told to render the QR and ask, or it goes straight to a silent wait.
    expect(data.instructions).toMatch(/show the user the "qr" field/iu);
    expect(data.instructions).toMatch(/appduct_wait_for_session/u);

    const payload = data.deepLink.split("appduct=")[1]!.split("&")[0]!;
    const decoded = decodeBootstrap(payload);
    expect(decoded).not.toBeNull();
    expect(decoded!.sessionId).toBe(data.sessionId);
  });

  test("no target but one booted simulator: delivers to it instead of returning a QR", async () => {
    const { stateDir } = await startTestDaemon();

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });

      if (command === "xcrun" && args.includes("--json")) {
        return {
          stdout: JSON.stringify({
            devices: { "iOS 17.0": [{ state: "Booted", udid: "SIM-1", name: "iPhone 15" }] },
          }),
          stderr: "",
        };
      }

      return { stdout: "List of devices attached\n\n", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      delivered?: true;
      autoDetected?: true;
      target?: string;
      device?: string;
      qr?: string;
      note?: string;
    };

    expect(data.delivered).toBe(true);
    expect(data.autoDetected).toBe(true);
    expect(data.target).toBe("ios-sim");
    expect(data.device).toBe("SIM-1");
    // No QR at all on the delivered path: there is nothing for a human to do.
    expect(data.qr).toBeUndefined();
    expect(data.note).toMatch(/iPhone 15 \(SIM-1\)/u);

    expect(calls.some((call) => call.args.includes("openurl") && call.args.includes("SIM-1"))).toBe(true);
  });

  test('target "none" forces the QR path even with a device booted', async () => {
    const { stateDir } = await startTestDaemon();

    const calls: string[] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return {
        stdout: JSON.stringify({
          devices: { "iOS 17.0": [{ state: "Booted", udid: "SIM-1", name: "iPhone 15" }] },
        }),
        stderr: "",
      };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );

    const data = result.structuredContent as { qr?: string; delivered?: true; note?: string };
    expect(data.delivered).toBeUndefined();
    expect(data.qr!.length).toBeGreaterThan(0);
    expect(data.note).toMatch(/target: "none"/u);
    // An explicit opt-out should not even look for devices.
    expect(calls).toEqual([]);
  });

  test("no target and several devices: no arbitrary pick, the note names every candidate", async () => {
    const { stateDir } = await startTestDaemon();

    const exec: ExecFn = async (command) => {
      if (command === "xcrun") {
        return {
          stdout: JSON.stringify({
            devices: {
              "iOS 17.0": [
                { state: "Booted", udid: "SIM-1", name: "iPhone 15" },
                { state: "Booted", udid: "SIM-2", name: "iPad Pro" },
              ],
            },
          }),
          stderr: "",
        };
      }

      return { stdout: "List of devices attached\n\n", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );

    const data = result.structuredContent as { qr?: string; delivered?: true; note?: string };
    expect(data.delivered).toBeUndefined();
    expect(data.qr!.length).toBeGreaterThan(0);
    expect(data.note).toMatch(/SIM-1/u);
    expect(data.note).toMatch(/SIM-2/u);
  });

  test('"device" without an explicit target is rejected rather than guessed at', async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: { device: "SIM-1" } } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/device.{0,4} requires an explicit/u);
  });

  test('explicit target "ios-device" delivers via devicectl with the LAN address, not 127.0.0.1', async () => {
    const { stateDir } = await startTestDaemon({ advertisedIp: "203.0.113.9" });

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });

      const jsonOutputIndex = args.indexOf("--json-output");

      if (jsonOutputIndex !== -1) {
        // `devicectl` writes its listing to the file named in argv, never to stdout.
        await writeFile(
          args[jsonOutputIndex + 1]!,
          JSON.stringify({
            result: {
              devices: [
                {
                  deviceProperties: { name: "My iPhone" },
                  hardwareProperties: { udid: "00008030-AAAA", platform: "iOS" },
                },
              ],
            },
          }),
          "utf8",
        );
      }

      return { stdout: "", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "appduct_connect",
          arguments: { target: "ios-device", appId: "com.example.playground" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      delivered?: true;
      autoDetected?: true;
      target?: string;
      deepLink: string;
      qr?: string;
    };

    expect(data.delivered).toBe(true);
    expect(data.target).toBe("ios-device");
    expect(data.autoDetected).toBeUndefined();
    expect(data.qr).toBeUndefined();

    // The link a physical iPhone gets must carry the machine's LAN address: there is no
    // `adb reverse` equivalent, so `127.0.0.1` would point the phone at itself (issue #31).
    const decoded = decodeBootstrap(data.deepLink.split("appduct=")[1]!.split("&")[0]!);
    expect(decoded).not.toBeNull();
    expect(decoded!.address).toBe("203.0.113.9");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args.slice(0, 5)).toEqual(["devicectl", "list", "devices", "--timeout", "5"]);
    expect(calls[1]!.args).toEqual([
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      "00008030-AAAA",
      "--payload-url",
      data.deepLink,
      "com.example.playground",
    ]);
  });

  test('an explicit "ios-device" whose delivery fails errors the call rather than falling back to a QR', async () => {
    // A routable advertisedIp: the helper's default is 127.0.0.1, which ios-device now refuses
    // outright, and this test is about a *delivery* failure rather than an addressing one.
    const { stateDir } = await startTestDaemon({ advertisedIp: "203.0.113.9" });

    const exec: ExecFn = async (command, args) => {
      const jsonOutputIndex = args.indexOf("--json-output");

      if (jsonOutputIndex !== -1) {
        await writeFile(
          args[jsonOutputIndex + 1]!,
          JSON.stringify({
            result: {
              devices: [
                {
                  deviceProperties: { name: "My iPhone" },
                  hardwareProperties: { udid: "00008030-AAAA", platform: "iOS" },
                  connectionProperties: { tunnelState: "connected", pairingState: "paired" },
                },
              ],
            },
          }),
          "utf8",
        );
        return { stdout: "", stderr: "" };
      }

      throw Object.assign(new Error("Command failed"), {
        stderr: "The application com.example.playground is not installed on the device",
      });
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "appduct_connect",
          arguments: { target: "ios-device", appId: "com.example.playground" },
        },
      },
      CallToolResultSchema,
    );

    // The QR fallback is reserved for an *auto-detected* device nobody asked for. A target the
    // caller named explicitly must surface its failure, not quietly become a QR code — otherwise
    // "the app isn't installed on that phone" reads as "scan this".
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/is not installed on the device/u);
    expect(result.structuredContent).toBeUndefined();
  });

  test("every appduct_connect deep link carries the &pin= param, like the CLI's", async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );

    const data = result.structuredContent as { deepLink: string };

    // Without this, an app whose effective trust is "link" (any build type with no embedded
    // cliPins) cannot pin the daemon from an agent-minted link, though it can from a CLI-minted
    // one. It matters most for ios-device, the first MCP path reaching a phone over the LAN.
    const query = new URLSearchParams(data.deepLink.slice(data.deepLink.indexOf("?") + 1));
    expect(query.get("pin")).toMatch(/^sha256\//u);

    // ...and the bootstrap blob still decodes: the pin is a separate param appended after it, so
    // anything slicing to the end of the string instead of stopping at "&" would corrupt it.
    expect(decodeBootstrap(data.deepLink.split("appduct=")[1]!.split("&")[0]!)).not.toBeNull();
  });

  test("the CLI and MCP deep-link compositions are byte-identical for the same link.create result", async () => {
    const { composeDeepLink } = await import("../link.js");

    // The `&pin=` param went missing from the MCP side precisely because there were two copies of
    // this string. `connect-tool.ts` now imports this exact function; the test pins the shape so a
    // future edit to one path cannot silently diverge from the other.
    const result = {
      sessionId: "s-1",
      deepLinkPayload: "AAAA-payload_x",
      endpoint: { address: "192.168.1.10", port: 8443, family: 4 as const },
      expiresAt: 1_800_000_000,
      // Standard base64: contains the `+`, `/` and `=` that must be percent-encoded.
      pin: "sha256/ab+cd/ef=",
    };

    expect(composeDeepLink("appduct", result)).toBe(
      "appduct:///?appduct=AAAA-payload_x&pin=sha256%2Fab%2Bcd%2Fef%3D",
    );

    // And a real MCP-minted link has the same shape, pin included.
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const called = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );

    const data = called.structuredContent as { deepLink: string };
    expect(data.deepLink).toMatch(/^appduct:\/\/\/\?appduct=[^&]+&pin=sha256%2F/u);
  });

  test('target "ios-device" refuses a loopback advertised address instead of delivering it', async () => {
    // The MCP twin of the CLI guard: a 127.0.0.1 link handed to a phone points it at itself, and
    // appduct_wait_for_session would then block for its whole timeout explaining nothing.
    const { stateDir } = await startTestDaemon({ advertisedIp: "127.0.0.1" });

    const calls: string[] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: "", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "appduct_connect",
          arguments: {
            target: "ios-device",
            device: "00008030-AAAA",
            appId: "com.example.playground",
          },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/advertisedIp/u);
    expect(calls).toEqual([]);
  });

  test('"relaunch" is opt-in and only valid with target "ios-device"', async () => {
    const { stateDir } = await startTestDaemon({ advertisedIp: "203.0.113.9" });

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const delivered = await client.request(
      {
        method: "tools/call",
        params: {
          name: "appduct_connect",
          arguments: {
            target: "ios-device",
            device: "00008030-AAAA",
            appId: "com.example.playground",
            relaunch: true,
          },
        },
      },
      CallToolResultSchema,
    );

    expect(delivered.isError).not.toBe(true);
    expect(calls[0]!.args).toContain("--terminate-existing");

    const misplaced = await client.request(
      {
        method: "tools/call",
        params: { name: "appduct_connect", arguments: { target: "ios-sim", relaunch: true } },
      },
      CallToolResultSchema,
    );

    expect(misplaced.isError).toBe(true);
    expect(JSON.stringify(misplaced.content)).toMatch(/relaunch.{0,4} only applies with target/u);
  });

  test('target "ios-device" falls back to the project config\'s appId.ios when no appId is passed', async () => {
    const { stateDir } = await startTestDaemon({ advertisedIp: "203.0.113.9" });
    const cwd = await writeProjectConfig({ appId: { ios: "com.example.fromconfig" } });

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec, cwd);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "appduct_connect",
          // An explicit device skips the listing, so this exercises the app-id default alone.
          arguments: { target: "ios-device", device: "00008030-BBBB" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { delivered?: true }).delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.at(-1)).toBe("com.example.fromconfig");
  });

  test('target "ios-device" with no app id anywhere is an invalid_request, and mints nothing', async () => {
    const { stateDir } = await startTestDaemon();

    const calls: string[] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: "", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "appduct_connect", arguments: { target: "ios-device" } },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/appId\.ios/u);
    // Rejected before `link.create`, so no pending session is stranded behind a doomed call.
    expect(calls).toEqual([]);
  });

  test('"appId" is rejected with target "ios-sim" or "none", which need no app id', async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const withIosSim = await client.request(
      {
        method: "tools/call",
        params: {
          name: "appduct_connect",
          arguments: { target: "ios-sim", appId: "com.example.playground" },
        },
      },
      CallToolResultSchema,
    );

    expect(withIosSim.isError).toBe(true);
    expect(JSON.stringify(withIosSim.content)).toMatch(/appId.{0,4} only applies with target/u);

    const withNone = await client.request(
      {
        method: "tools/call",
        params: {
          name: "appduct_connect",
          arguments: { target: "none", appId: "com.example.playground" },
        },
      },
      CallToolResultSchema,
    );

    expect(withNone.isError).toBe(true);
    expect(JSON.stringify(withNone.content)).toMatch(/appId.{0,4} only applies with target/u);
  });

  test('target "android" needs an "appId" just like "ios-device" does', async () => {
    const { stateDir } = await startTestDaemon();

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });

      if (args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const missing = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: { target: "android" } } },
      CallToolResultSchema,
    );

    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/appId\.android/u);
    expect(calls).toEqual([]);

    const delivered = await client.request(
      {
        method: "tools/call",
        params: {
          name: "appduct_connect",
          arguments: { target: "android", appId: "com.example.playground" },
        },
      },
      CallToolResultSchema,
    );

    expect(delivered.isError).not.toBe(true);
    expect((delivered.structuredContent as { delivered?: true }).delivered).toBe(true);
    expect(calls.at(-1)!.args.slice(-2)).toEqual(["-p", "com.example.playground"]);
  });

  test("the zero-argument auto-detected android path resolves appId from the project config", async () => {
    const { stateDir } = await startTestDaemon();
    const cwd = await writeProjectConfig({ appId: { android: "com.example.fromconfig" } });

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });

      if (command === "xcrun") {
        return { stdout: JSON.stringify({ devices: {} }), stderr: "" };
      }

      if (args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec, cwd);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );

    const data = result.structuredContent as { delivered?: true; autoDetected?: true; target?: string };
    expect(result.isError).not.toBe(true);
    expect(data.delivered).toBe(true);
    expect(data.autoDetected).toBe(true);
    expect(data.target).toBe("android");
    expect(calls.at(-1)!.args.slice(-2)).toEqual(["-p", "com.example.fromconfig"]);
  });

  test("the zero-argument auto-detected android path is a clear invalid_request when appId cannot be resolved", async () => {
    const { stateDir } = await startTestDaemon();

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });

      if (command === "xcrun") {
        return { stdout: JSON.stringify({ devices: {} }), stderr: "" };
      }

      if (args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/appId\.android/u);
  });

  test("an omitted target never picks a physical iPhone, and says so in the QR note", async () => {
    const { stateDir } = await startTestDaemon();

    const invocations: string[] = [];
    const exec: ExecFn = async (command, args) => {
      invocations.push(`${command} ${args.join(" ")}`);
      return noDevicesExec(command, args);
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );

    const data = result.structuredContent as { delivered?: true; target?: string; note?: string };

    expect(data.delivered).toBeUndefined();
    expect(data.target).toBeUndefined();
    // Auto-detection must never reach devicectl: a paired iPhone is often a personal phone.
    expect(invocations.some((invocation) => invocation.includes("devicectl"))).toBe(false);
    // ...and the note has to tell the agent that the target exists but must be asked for.
    expect(data.note).toMatch(/never auto-detected/iu);
    expect(data.note).toMatch(/ios-device/u);
    expect(data.note).toMatch(/appId/u);
  });

  test("appduct_wait_for_session resolves once a fake client claims the minted session", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const connectResult = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );
    const { sessionId, deepLink } = connectResult.structuredContent as { sessionId: string; deepLink: string };

    const payload = deepLink.split("appduct=")[1]!.split("&")[0]!;
    const decoded = decodeBootstrap(payload)!;

    const waitPromise = client.request(
      { method: "tools/call", params: { name: "appduct_wait_for_session", arguments: { sessionId, timeoutMs: 5000 } } },
      CallToolResultSchema,
    );

    const socket = await connectClient(daemon);
    const claimed = waitForEvent(daemon, "session_claimed");
    socket.send(
      JSON.stringify({
        type: "session_claim",
        protocol_version: 2,
        session_id: decoded.sessionId,
        token: decoded.token,
        device_model: "Pixel 8",
      }),
    );
    await nextMessage(socket);
    await claimed;

    const waitResult = await waitPromise;
    expect(waitResult.isError).not.toBe(true);
    const data = waitResult.structuredContent as { sessionId: string; claimed: true; alias: string };
    expect(data.sessionId).toBe(sessionId);
    expect(data.claimed).toBe(true);
    expect(data.alias.length).toBeGreaterThan(0);

    socket.close();
  }, 10_000);

  test("auto-detected delivery that fails falls back to a QR instead of erroring the call", async () => {
    const { stateDir } = await startTestDaemon();

    // One booted simulator, but `openurl` fails on it — the app simply isn't installed there.
    // Nobody asked for this device, so this must not become the caller's error.
    const exec: ExecFn = async (command, args) => {
      if (command === "xcrun" && args.includes("--json")) {
        return {
          stdout: JSON.stringify({
            devices: { "iOS 17.0": [{ state: "Booted", udid: "SIM-1", name: "iPhone 15" }] },
          }),
          stderr: "",
        };
      }

      if (args.includes("openurl")) {
        throw Object.assign(new Error("Command failed"), { stderr: "no matching URL scheme" });
      }

      return { stdout: "List of devices attached\n\n", stderr: "" };
    };

    const handle = await createMcpHandle(stateDir, exec);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as {
      qr?: string;
      delivered?: true;
      note?: string;
      instructions?: string;
      deepLink: string;
    };

    expect(data.delivered).toBeUndefined();
    expect(data.qr!.length).toBeGreaterThan(0);
    expect(data.instructions).toBeTruthy();
    expect(data.note).toMatch(/no matching URL scheme/u);
    expect(data.note).toMatch(/falling back to a QR/iu);

    // The fallback link has to be a fresh mint: the first one was minted for 127.0.0.1 on the
    // assumption it was going to a local simulator, which is the wrong address for a scanner.
    expect(decodeBootstrap(data.deepLink.split("appduct=")[1]!.split("&")[0]!)).not.toBeNull();
  });

  test("appduct_wait_for_session returns immediately for a session claimed before it was called", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    // The claim is already in the past, so no `session_claimed` event will ever arrive on a
    // subscription opened now — only the catch-up describe can resolve this.
    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "appduct_wait_for_session", arguments: { sessionId: app.sessionId, timeoutMs: 5000 } },
      },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { sessionId: string; claimed: true; alias: string };
    expect(data.sessionId).toBe(app.sessionId);
    expect(data.claimed).toBe(true);
    expect(data.alias).toBe(app.alias);

    app.socket.close();
  }, 10_000);

  test("appduct_wait_for_session reports a daemon that goes away instead of waiting out its timeout", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const connectResult = await client.request(
      { method: "tools/call", params: { name: "appduct_connect", arguments: { target: "none" } } },
      CallToolResultSchema,
    );
    const { sessionId } = connectResult.structuredContent as { sessionId: string };

    // A generous timeout: the point is that the call comes back on the connection dropping, not on
    // the clock. Without an onClose handler this sits silently for the full 30s.
    const waitPromise = client.request(
      {
        method: "tools/call",
        params: { name: "appduct_wait_for_session", arguments: { sessionId, timeoutMs: 30_000 } },
      },
      CallToolResultSchema,
    );

    // Let the tool's stream actually establish before pulling the daemon out from under it.
    // Without this the shutdown races the stream opening, and a connect that lands after the
    // socket file is gone takes the auto-spawn path instead — a different failure than the one
    // this test is about.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    await daemon.shutdown();

    const waitResult = await waitPromise;
    const message = JSON.stringify(waitResult.content);

    // Asserting the contract, not one exact sentence: a daemon disappearing is caught at whichever
    // stage happens to be in flight — opening the stream, the subscribe, the catch-up describe, or
    // the socket's own close — and which one wins is a platform detail (Linux resets where macOS
    // closes cleanly). Every route has to come back promptly, name the daemon and the session, and
    // not be the timeout path. Reaching this line at all proves promptness: the tool was given
    // 30s and this test would have failed at 10s.
    expect(waitResult.isError).toBe(true);
    expect(message).toMatch(/Appduct daemon/u);
    expect(message).toContain(sessionId);
    expect(message).not.toMatch(/Timed out/u);
  }, 10_000);
});

describe("mcp: appduct_events / appduct_wait_for_event", () => {
  test("appduct_events drains app_events already emitted, and honors the returned cursor", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const emitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "greeting", payload: { hi: true }, ts: Date.now() }));
    await emitted;

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const first = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: {} } },
      CallToolResultSchema,
    );
    expect(first.isError).not.toBe(true);
    // Flat `{ name, payload, ts, seq, sessionId, alias }` events (issue #112) — no `kind`/`data`
    // envelope.
    const firstData = first.structuredContent as {
      events: Array<{ name: string; payload: unknown; ts: number; seq: number; sessionId: string; alias?: string; kind?: unknown; data?: unknown }>;
      cursor: number;
    };
    expect(firstData.events.some((event) => event.name === "greeting" && (event.payload as { hi: boolean }).hi === true)).toBe(true);
    for (const event of firstData.events) {
      expect(event.kind).toBeUndefined();
      expect(event.data).toBeUndefined();
      expect(event.sessionId).toBe(app.sessionId);
    }

    const second = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: { since: firstData.cursor } } },
      CallToolResultSchema,
    );
    const secondData = second.structuredContent as { events: unknown[] };
    expect(secondData.events).toEqual([]);

    app.socket.close();
  });

  test("appduct_wait_for_event resolves immediately for an event that already fired before the call", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const emitted = waitForEvent(daemon, "app_event");
    app.socket.send(
      JSON.stringify({ type: "event", session_id: app.sessionId, name: "already-happened", payload: { n: 1 }, ts: Date.now() }),
    );
    await emitted;

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "appduct_wait_for_event", arguments: { name: "already-happened", timeoutMs: 2000 } },
      },
      CallToolResultSchema,
    );

    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { name: string; payload: { n: number } };
    expect(data.name).toBe("already-happened");
    expect(data.payload).toEqual({ n: 1 });

    app.socket.close();
  }, 10_000);

  test("appduct_wait_for_event resolves once a live-only matching event arrives, ignoring non-matching ones", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const waitPromise = client.request(
      {
        method: "tools/call",
        params: { name: "appduct_wait_for_event", arguments: { name: "target", timeoutMs: 5000 } },
      },
      CallToolResultSchema,
    );

    const otherEmitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "not-it", ts: Date.now() }));
    await otherEmitted;

    const targetEmitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "target", payload: { ok: true }, ts: Date.now() }));
    await targetEmitted;

    const result = await waitPromise;
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { name: string; payload: { ok: boolean } };
    expect(data.name).toBe("target");
    expect(data.payload).toEqual({ ok: true });

    app.socket.close();
  }, 10_000);

  test("appduct_wait_for_event rejects with tool_timeout when nothing matches in time", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "appduct_wait_for_event", arguments: { selector: app.alias, name: "never-arrives", timeoutMs: 300 } },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("tool_timeout");

    app.socket.close();
  }, 10_000);

  test("appduct_wait_for_event's match filters by shallow payload equality", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const waitPromise = client.request(
      {
        method: "tools/call",
        params: { name: "appduct_wait_for_event", arguments: { name: "screen_changed", match: { screen: "Checkout" }, timeoutMs: 5000 } },
      },
      CallToolResultSchema,
    );

    const nonMatching = waitForEvent(daemon, "app_event");
    app.socket.send(
      JSON.stringify({ type: "event", session_id: app.sessionId, name: "screen_changed", payload: { screen: "Home" }, ts: Date.now() }),
    );
    await nonMatching;

    const matching = waitForEvent(daemon, "app_event");
    app.socket.send(
      JSON.stringify({ type: "event", session_id: app.sessionId, name: "screen_changed", payload: { screen: "Checkout", total: 42 }, ts: Date.now() }),
    );
    await matching;

    const result = await waitPromise;
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { payload: { screen: string; total: number } };
    expect(data.payload).toEqual({ screen: "Checkout", total: 42 });

    app.socket.close();
  }, 10_000);

  test("appduct_wait_for_event rejects match values that could never match (objects/arrays)", async () => {
    const { stateDir, daemon } = await startTestDaemon();
    const app = await claimApp(daemon);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "appduct_wait_for_event", arguments: { name: "x", match: { nested: { a: 1 } } } },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("invalid_request");

    app.socket.close();
  });

  test("appduct_wait_for_event's since skips an already-retained match and waits for a fresh one", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const first = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "ping", payload: { n: 1 }, ts: Date.now() }));
    await first;

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const drained = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: { selector: app.alias } } },
      CallToolResultSchema,
    );
    const cursor = (drained.structuredContent as { cursor: number }).cursor;

    const waitPromise = client.request(
      {
        method: "tools/call",
        params: { name: "appduct_wait_for_event", arguments: { name: "ping", since: cursor, timeoutMs: 5000 } },
      },
      CallToolResultSchema,
    );

    // Give the tool a beat to have drained the (empty, since-filtered) backlog and be listening
    // live before the second `ping` — the earlier one, already covered by `since`, must not resolve it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "ping", payload: { n: 2 }, ts: Date.now() }));
    await second;

    const result = await waitPromise;
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { payload: { n: number } };
    expect(data.payload).toEqual({ n: 2 });

    app.socket.close();
  }, 10_000);

  test("appduct_events rejects a non-integer since and a zero limit", async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const nonIntegerSince = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: { since: 1.5 } } },
      CallToolResultSchema,
    );
    expect(nonIntegerSince.isError).toBe(true);
    expect((nonIntegerSince.content as Array<{ text: string }>)[0]!.text).toContain("invalid_request");

    const zeroLimit = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: { limit: 0 } } },
      CallToolResultSchema,
    );
    expect(zeroLimit.isError).toBe(true);
  });

  test("appduct_events returns app_event only, never lifecycle or tool-call events", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);
    await snapshotTools(daemon, app, [{ name: "echo" }]);

    app.socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (msg.type === "tool_call") {
        app.socket.send(JSON.stringify({ type: "tool_result", session_id: app.sessionId, id: msg.id, result: "ok" }));
      }
    });

    const finished = waitForEvent(daemon, "tool_call_finished");
    await rpcCall(daemon.paths.socketPath, "tools.call", { selector: app.alias, name: "echo", args: {} });
    await finished;

    const emitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "greeting", ts: Date.now() }));
    await emitted;

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: {} } },
      CallToolResultSchema,
    );
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { events: Array<{ name: string }> };
    expect(data.events.map((event) => event.name)).toEqual(["greeting"]);

    app.socket.close();
  });

  test("appduct_events defaults limit to 50 and pages forward with the returned cursor (issue #112)", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    for (let i = 0; i < 55; i++) {
      const emitted = waitForEvent(daemon, "app_event");
      app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: `e${i}`, ts: Date.now() }));
      await emitted;
    }

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const first = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: {} } },
      CallToolResultSchema,
    );
    expect(first.isError).not.toBe(true);
    const firstData = first.structuredContent as { events: Array<{ name: string }>; cursor: number };
    expect(firstData.events).toHaveLength(50);
    expect(firstData.events[0]!.name).toBe("e0");
    expect(firstData.events[49]!.name).toBe("e49");

    const second = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: { since: firstData.cursor } } },
      CallToolResultSchema,
    );
    const secondData = second.structuredContent as { events: Array<{ name: string }> };
    expect(secondData.events.map((event) => event.name)).toEqual(["e50", "e51", "e52", "e53", "e54"]);

    app.socket.close();
  }, 10_000);

  test("appduct_events filters by a name glob (issue #112)", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    for (const name of ["cart.item_added", "checkout_completed", "cart.item_removed"]) {
      const emitted = waitForEvent(daemon, "app_event");
      app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name, ts: Date.now() }));
      await emitted;
    }

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const result = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: { name: "cart.*" } } },
      CallToolResultSchema,
    );
    expect(result.isError).not.toBe(true);
    const data = result.structuredContent as { events: Array<{ name: string }> };
    expect(data.events.map((event) => event.name)).toEqual(["cart.item_added", "cart.item_removed"]);

    app.socket.close();
  });

  test("appduct_events and appduct_wait_for_event do not offer kinds and reject it with invalid_request", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const emitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "ready", ts: Date.now() }));
    await emitted;

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    for (const name of ["appduct_events", "appduct_wait_for_event"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name)!;
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("kinds");
    }

    const events = await client.request(
      { method: "tools/call", params: { name: "appduct_events", arguments: { kinds: ["app_event"] } } },
      CallToolResultSchema,
    );
    expect(events.isError).toBe(true);
    expect((events.content as Array<{ text: string }>)[0]!.text).toContain("invalid_request");

    const wait = await client.request(
      {
        method: "tools/call",
        params: { name: "appduct_wait_for_event", arguments: { name: "ready", kinds: ["app_event"], timeoutMs: 2000 } },
      },
      CallToolResultSchema,
    );
    expect(wait.isError).toBe(true);
    expect((wait.content as Array<{ text: string }>)[0]!.text).toContain("invalid_request");

    app.socket.close();
  }, 10_000);
});

describe("daemon: events.since / events.subscribe name filter (issue #112)", () => {
  test("events.since with a name glob returns only matching events", async () => {
    const { daemon } = await startTestDaemon();
    const app = await claimApp(daemon);

    for (const name of ["cart.item_added", "checkout_completed", "cart.item_removed"]) {
      const emitted = waitForEvent(daemon, "app_event");
      app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name, ts: Date.now() }));
      await emitted;
    }

    const result = (await rpcCall(daemon.paths.socketPath, "events.since", {
      selector: app.alias,
      name: "cart.*",
    })) as { events: Array<{ data: { name: string } }> };

    expect(result.events.map((event) => event.data.name)).toEqual(["cart.item_added", "cart.item_removed"]);

    app.socket.close();
  });

  test("an exact name never matches a longer name it prefixes", async () => {
    const { daemon } = await startTestDaemon();
    const app = await claimApp(daemon);

    for (const name of ["checkout_completed", "checkout_completed_v2"]) {
      const emitted = waitForEvent(daemon, "app_event");
      app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name, ts: Date.now() }));
      await emitted;
    }

    const result = (await rpcCall(daemon.paths.socketPath, "events.since", {
      selector: app.alias,
      name: "checkout_completed",
    })) as { events: Array<{ data: { name: string } }> };

    expect(result.events.map((event) => event.data.name)).toEqual(["checkout_completed"]);

    app.socket.close();
  });

  test("name matching is case-sensitive", async () => {
    const { daemon } = await startTestDaemon();
    const app = await claimApp(daemon);

    const emitted = waitForEvent(daemon, "app_event");
    app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name: "cart.item_added", ts: Date.now() }));
    await emitted;

    const result = (await rpcCall(daemon.paths.socketPath, "events.since", {
      selector: app.alias,
      name: "Cart.*",
    })) as { events: unknown[] };

    expect(result.events).toEqual([]);

    app.socket.close();
  });

  test("events.subscribe with a name glob delivers only matching live events on that connection", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const stream = await openDaemonStream({ stateDir, spawn: failIfCalled });

    try {
      await stream.call(RPC_METHODS.eventsSubscribe, { sessionSelector: app.sessionId, name: "cart.*" });

      const received: Array<{ data: { name: string } }> = [];
      stream.onNotification((payload) => {
        const event = payload as { kind: string; sessionId?: string; data: { name: string } };
        if (event.kind === "app_event") {
          received.push(event as { data: { name: string } });
        }
      });

      for (const name of ["cart.item_added", "checkout_completed", "cart.item_removed"]) {
        const emitted = waitForEvent(daemon, "app_event");
        app.socket.send(JSON.stringify({ type: "event", session_id: app.sessionId, name, ts: Date.now() }));
        await emitted;
      }

      // `waitForEvent` above only confirms the daemon's own bus emitted — the fan-out notification
      // still has to travel the control socket to `stream` before `received` reflects it, so poll
      // rather than asserting immediately.
      const deadline = Date.now() + 2000;
      while (received.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(received.map((event) => event.data.name)).toEqual(["cart.item_added", "cart.item_removed"]);
    } finally {
      stream.close();
      app.socket.close();
    }
  });
});

describe("mcp: appduct://sessions resource", () => {
  test("lists the resource and reads it back as sessions.list JSON", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const app = await claimApp(daemon);

    const handle = await createMcpHandle(stateDir);
    const client = await connectInMemoryClient(handle);

    const listed = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
    expect(listed.resources.map((resource) => resource.uri)).toContain("appduct://sessions");

    const read = await client.request(
      { method: "resources/read", params: { uri: "appduct://sessions" } },
      ReadResourceResultSchema,
    );
    const text = (read.contents[0] as { text: string }).text;
    const sessions = JSON.parse(text) as Array<{ alias: string }>;
    expect(sessions.map((session) => session.alias)).toContain(app.alias);

    app.socket.close();
  });
});

describe("mcp: stdout purity", () => {
  test("nothing is ever written to the stdio transport's stream except MCP protocol frames", async () => {
    const { stateDir } = await startTestDaemon();
    const handle = await createMcpHandle(stateDir);

    // A real StdioServerTransport wired to plain PassThrough streams (no subprocess): every write
    // captured here is exactly what would have gone to the real process.stdout in production.
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();

    const capturedChunks: string[] = [];
    serverToClient.on("data", (chunk: Buffer) => {
      capturedChunks.push(chunk.toString("utf8"));
    });

    await handle.connect(new StdioServerTransport(clientToServer, serverToClient));

    // A minimal hand-rolled client-side transport speaking the same newline-delimited JSON framing
    // as StdioServerTransport (see `@modelcontextprotocol/sdk/shared/stdio.js`), driving the SDK
    // Client without spawning a subprocess.
    let onmessage: ((message: unknown) => void) | undefined;
    let readBuffer = "";
    serverToClient.on("data", (chunk: Buffer) => {
      readBuffer += chunk.toString("utf8");
      let newlineIndex = readBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = readBuffer.slice(0, newlineIndex);
        readBuffer = readBuffer.slice(newlineIndex + 1);
        newlineIndex = readBuffer.indexOf("\n");
        if (line.length > 0) {
          onmessage?.(JSON.parse(line));
        }
      }
    });

    const clientTransport = {
      start: async () => {},
      send: async (message: unknown) => {
        clientToServer.write(`${JSON.stringify(message)}\n`);
      },
      close: async () => {
        clientToServer.end();
      },
      set onmessage_(_cb: unknown) {},
    };
    Object.defineProperty(clientTransport, "onmessage", {
      set(cb: (message: unknown) => void) {
        onmessage = cb;
      },
      get() {
        return onmessage;
      },
    });

    const client = new Client({ name: "test-stdio-client", version: "0.0.0" });
    await client.connect(clientTransport as never);

    await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);

    expect(capturedChunks.length).toBeGreaterThan(0);

    for (const chunk of capturedChunks) {
      for (const line of chunk.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }

        const parsed = JSON.parse(line) as { jsonrpc?: string };
        expect(parsed.jsonrpc).toBe("2.0");
      }
    }
  });
});

describe("mcp: daemon/CLI version drift (issue #30)", () => {
  const STALE_VERSION = "0.0.1-stale";

  /** Starts a test daemon that reports `STALE_VERSION` — the daemon reads the override on every
   * `daemon.status`, so it stays stale until the variable is cleared for its replacement. */
  const startStaleTestDaemon = async (): Promise<TestDaemon> => {
    process.env[DAEMON_VERSION_OVERRIDE_ENV] = STALE_VERSION;
    return startTestDaemon();
  };

  const readDaemonVersion = async (stateDir: string): Promise<string> => {
    const status = (await rpcCall(path.join(stateDir, "daemon.sock"), "daemon.status")) as {
      version: string;
      sessions: unknown[];
    };
    return status.version;
  };

  test("startup against a mismatched idle daemon restarts it transparently", async () => {
    const { daemon, stateDir } = await startStaleTestDaemon();
    expect(await readDaemonVersion(stateDir)).toBe(STALE_VERSION);

    let spawnCalls = 0;
    const spawn: SpawnFn = async () => {
      spawnCalls += 1;
      // The replacement is this build, so it must not inherit the stale override.
      delete process.env[DAEMON_VERSION_OVERRIDE_ENV];
      const replacement = await startDaemon({ stateDir });
      runningDaemons.push(replacement);
    };

    const handle = await createMcpServer({
      stateDir,
      spawn,
      checkVersion: { clientVersion: getPackageVersion() },
    });
    mcpHandles.push(handle);

    expect(spawnCalls).toBe(1);
    expect(await readDaemonVersion(stateDir)).toBe(getPackageVersion());
    await daemon.exited;

    // The server is fully usable against the daemon it ended up connected to.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport as never);

    const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    expect(tools.tools.length).toBeGreaterThan(0);
  });

  test("startup against a mismatched daemon with a live session fails with both versions", async () => {
    const { daemon, stateDir } = await startStaleTestDaemon();
    const app = await claimApp(daemon);

    const spawn: SpawnFn = () => {
      throw new Error("the daemon must not be replaced while a session is live");
    };

    await expect(
      createMcpServer({ stateDir, spawn, checkVersion: { clientVersion: getPackageVersion() } }),
    ).rejects.toThrow(new RegExp(`${STALE_VERSION}[\\s\\S]*${getPackageVersion()}`, "u"));

    // The app's session survives the refused startup untouched.
    const status = (await rpcCall(path.join(stateDir, "daemon.sock"), "daemon.status")) as {
      version: string;
      sessions: Array<{ sessionId: string }>;
    };
    expect(status.version).toBe(STALE_VERSION);
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]!.sessionId).toBe(app.sessionId);

    app.socket.close();
  });
});
