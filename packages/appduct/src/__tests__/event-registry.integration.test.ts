/**
 * Issue #124: apps declare the events they post over `event_registry_snapshot` /
 * `event_registry_delta`, and `events.list` returns them. Every case drives a real pinned-TLS
 * `wss://` socket against a real daemon, like `session-engine.integration.test.ts`, and observes
 * only the wire, the control-plane RPC and `events.log`.
 */

import { readFile } from "node:fs/promises";
import { connect as connectUds, type Socket } from "node:net";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import {
  decodeBootstrap,
  type EventDescriptor,
  type EventKind,
  type EventNotification,
  type EventsListResult,
} from "@appduct/shared";

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

const startTestDaemon = async (): Promise<RunningDaemon> => {
  const stateDir = await makeTempStateDir({}, { prefix: "appduct-event-registry-" });
  stateDirs.push(stateDir);

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);
  return daemon;
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

const connectSocket = (daemon: RunningDaemon): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${daemon.listener.port()!}`, { ca: daemon.tls.current().certPem });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
};

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> => {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
  });
};

const nextClose = (socket: WebSocket): Promise<{ code: number; reason: string }> => {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
};

type App = { socket: WebSocket; sessionId: string; ack: Record<string, unknown> };

const claimApp = async (daemon: RunningDaemon): Promise<App> => {
  const link = (await rpcCall(daemon.paths.socketPath, "link.create", { ttlSeconds: 60 })) as {
    deepLinkPayload: string;
  };
  const decoded = decodeBootstrap(link.deepLinkPayload)!;
  const socket = await connectSocket(daemon);
  const ack = nextMessage(socket);

  socket.send(
    JSON.stringify({
      type: "session_claim",
      protocol_version: 2,
      session_id: decoded.sessionId,
      token: decoded.token,
      device_model: "Pixel 8",
    }),
  );

  return { socket, sessionId: decoded.sessionId, ack: await ack };
};

const declare = async (daemon: RunningDaemon, app: App, events: EventDescriptor[]): Promise<void> => {
  const changed = waitForEvent(daemon, "events_changed");
  app.socket.send(JSON.stringify({ type: "event_registry_snapshot", session_id: app.sessionId, events }));
  await changed;
};

const listEvents = async (daemon: RunningDaemon, params: Record<string, unknown> = {}): Promise<EventsListResult> => {
  return (await rpcCall(daemon.paths.socketPath, "events.list", params)) as EventsListResult;
};

const checkout: EventDescriptor = {
  name: "checkout_completed",
  description: "Fired once an order finishes checkout.",
  payload_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
};
const itemAdded: EventDescriptor = { name: "cart.item_added", description: "An item went into the cart." };
const itemRemoved: EventDescriptor = { name: "cart.item_removed", description: "An item left the cart." };

describe("event registry", () => {
  test("every ack tells the app this daemon accepts event registry frames", async () => {
    const daemon = await startTestDaemon();
    const app = await claimApp(daemon);

    expect(app.ack).toMatchObject({ type: "session_ack", status: "ok", event_registry: true });
  });

  test("a snapshot makes events.list return the event, and a remove delta takes it out", async () => {
    const daemon = await startTestDaemon();
    const app = await claimApp(daemon);

    await declare(daemon, app, [checkout]);
    expect(await listEvents(daemon)).toEqual({ events: [checkout], total: 1 });

    const changed = waitForEvent(daemon, "events_changed");
    app.socket.send(
      JSON.stringify({
        type: "event_registry_delta",
        session_id: app.sessionId,
        operation: "remove",
        name: "checkout_completed",
      }),
    );
    await changed;

    expect(await listEvents(daemon)).toEqual({ events: [], total: 0 });
  });

  test("an upsert delta adds an event and replaces one of the same name", async () => {
    const daemon = await startTestDaemon();
    const app = await claimApp(daemon);
    await declare(daemon, app, [itemAdded]);

    const changed = waitForEvent(daemon, "events_changed");
    app.socket.send(
      JSON.stringify({
        type: "event_registry_delta",
        session_id: app.sessionId,
        operation: "upsert",
        event: { ...itemAdded, description: "Reworded." },
      }),
    );
    await changed;

    expect(await listEvents(daemon)).toEqual({
      events: [{ ...itemAdded, description: "Reworded." }],
      total: 1,
    });
  });

  test("a session that sends no event frames lists no events", async () => {
    const daemon = await startTestDaemon();
    await claimApp(daemon);

    expect(await listEvents(daemon)).toEqual({ events: [], total: 0 });
  });

  test("a snapshot sent after a resume replaces the session's event registry", async () => {
    const daemon = await startTestDaemon();
    const app = await claimApp(daemon);
    await declare(daemon, app, [checkout, itemAdded]);

    const suspended = waitForEvent(daemon, "session_suspended");
    app.socket.close();
    await suspended;

    // Events stay listable while the session is suspended.
    expect((await listEvents(daemon)).total).toBe(2);

    const resumed = await connectSocket(daemon);
    const resumeAck = nextMessage(resumed);
    resumed.send(
      JSON.stringify({
        type: "session_resume",
        protocol_version: 2,
        session_id: app.sessionId,
        resume_token: app.ack.resume_token,
      }),
    );
    expect(await resumeAck).toMatchObject({ event_registry: true });

    await declare(daemon, { ...app, socket: resumed }, [itemRemoved]);

    expect(await listEvents(daemon)).toEqual({ events: [itemRemoved], total: 1 });
  });

  test.each([
    ["a snapshot whose events array holds null", { type: "event_registry_snapshot", events: [null] }],
    ["a snapshot with an event that has no description", { type: "event_registry_snapshot", events: [{ name: "x" }] }],
    ["a snapshot whose events is not an array", { type: "event_registry_snapshot", events: {} }],
    ["an upsert delta with a non-object event", { type: "event_registry_delta", operation: "upsert", event: "x" }],
    ["a remove delta with no name", { type: "event_registry_delta", operation: "remove" }],
    ["a delta with an unknown operation", { type: "event_registry_delta", operation: "replace" }],
  ])("%s closes the session with 1008 invalid_registry", async (_label, frame) => {
    const daemon = await startTestDaemon();
    const app = await claimApp(daemon);

    const closed = nextClose(app.socket);
    app.socket.send(JSON.stringify({ ...frame, session_id: app.sessionId }));

    expect(await closed).toEqual({ code: 1008, reason: "invalid_registry" });
  });

  test("events.list sorts by name, applies the name glob before total, then pages", async () => {
    const daemon = await startTestDaemon();
    const app = await claimApp(daemon);
    await declare(daemon, app, [itemRemoved, checkout, itemAdded]);

    expect((await listEvents(daemon)).events.map((event) => event.name)).toEqual([
      "cart.item_added",
      "cart.item_removed",
      "checkout_completed",
    ]);
    expect(await listEvents(daemon, { name: "cart.*" })).toMatchObject({ total: 2 });
    expect(await listEvents(daemon, { name: "checkout_completed" })).toEqual({ events: [checkout], total: 1 });
    expect(await listEvents(daemon, { name: "nope" })).toEqual({ events: [], total: 0 });

    const page = await listEvents(daemon, { name: "cart.*", limit: 1, offset: 1 });
    expect(page.events.map((event) => event.name)).toEqual(["cart.item_removed"]);
    expect(page.total).toBe(2);
  });

  test("events.list rejects a bad limit", async () => {
    const daemon = await startTestDaemon();
    await claimApp(daemon);

    await expect(listEvents(daemon, { limit: 0 })).rejects.toThrow(/limit/);
  });

  test("events_changed lands in events.log and is never retained for events.since", async () => {
    const daemon = await startTestDaemon();
    const app = await claimApp(daemon);
    await declare(daemon, app, [checkout]);

    const since = (await rpcCall(daemon.paths.socketPath, "events.since", { since: 0 })) as { events: unknown[] };
    expect(since.events).toEqual([]);

    runningDaemons.splice(runningDaemons.indexOf(daemon), 1);
    await daemon.shutdown();

    const lines = (await readFile(daemon.paths.eventsLogPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as EventNotification);

    expect(lines.filter((line) => line.kind === "events_changed")).toHaveLength(1);
    expect(lines.find((line) => line.kind === "events_changed")).toMatchObject({
      sessionId: app.sessionId,
      data: { eventCount: 1 },
    });
  });
});
