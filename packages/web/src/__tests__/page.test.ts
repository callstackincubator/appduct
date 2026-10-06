import { encodeBootstrap } from "@appduct/shared";
import { describe, expect, it } from "vitest";

import { createManualClock, createMemorySessionStore, createMemoryTransport } from "../core/index.js";
import { createMemoryPage, createWebAppduct } from "../page/index.js";
import { DEVICE, SESSION_ID, START_MS, ack, settle } from "./harness.js";

const PAGE = "http://localhost:5173/dashboard";

const payload = encodeBootstrap({
  family: 4,
  address: "127.0.0.1",
  port: 49152,
  sessionId: SESSION_ID,
  token: "A".repeat(43),
  expiresAt: Math.floor(START_MS / 1000) + 60,
});

/** A page load: fresh entry over the given ports, as after a navigation or a reload. */
const load = (
  href: string,
  ports = {
    transport: createMemoryTransport(),
    sessionStore: createMemorySessionStore(),
    clock: createManualClock(START_MS),
  },
) => {
  const page = createMemoryPage(href);
  const appduct = createWebAppduct({ ports: { ...ports, random: () => 0.5, device: DEVICE }, page });
  return { appduct, page, ports, socket: () => ports.transport.connections.at(-1)! };
};

describe("the plain-JS entry", () => {
  it("claims a session with the link in the address bar on load", () => {
    const { socket } = load(`${PAGE}#appduct=${payload}`);

    socket().open();

    expect(socket().url).toBe("ws://127.0.0.1:49152");
    expect(socket().frames()[0]).toMatchObject({ type: "session_claim", session_id: SESSION_ID });
  });

  it("removes the link from the address bar on load", () => {
    const { page } = load(`${PAGE}#appduct=${payload}`);

    expect(page.href()).toBe(PAGE);
  });

  it("leaves the page alone when the address has no link and nothing to resume", async () => {
    const { page, ports } = load(PAGE);
    await settle();

    expect(ports.transport.connections).toEqual([]);
    expect(page.replaceCount).toBe(0);
  });

  it("claims a session from window.__APPDUCT__.connect on a loaded page without changing its address", async () => {
    const { page, socket, ports } = load(PAGE);

    const connecting = page.connect!(payload);
    socket().open();
    socket().receive(ack());
    await connecting;

    expect(socket().frames()[0]).toMatchObject({ type: "session_claim", session_id: SESSION_ID });
    expect(page.href()).toBe(PAGE);
    expect(page.replaceCount).toBe(0);
    expect(ports.transport.connections).toHaveLength(1);
  });

  it("rejects a link that is not a bootstrap payload", async () => {
    const { appduct, ports } = load(PAGE);

    await expect(appduct.connect("not-a-link")).rejects.toThrow(/link/iu);
    expect(ports.transport.connections).toEqual([]);
  });

  it("rejects an expired link without opening a socket", async () => {
    const { appduct, ports } = load(PAGE);
    ports.clock.advance(61_000);

    await expect(appduct.connect(payload)).rejects.toThrow(/expired/iu);
    expect(ports.transport.connections).toEqual([]);
  });

  it("rejects connect when the daemon refuses the link", async () => {
    const { appduct, socket } = load(PAGE);

    const connecting = appduct.connect(payload);
    const rejected = expect(connecting).rejects.toThrow("invalid_token");
    socket().open();
    socket().closeFromDaemon(1008, "invalid_token");

    await rejected;
  });

  it("resumes the session when the page reloads", async () => {
    const first = load(`${PAGE}#appduct=${payload}`);
    first.socket().open();
    first.socket().receive(ack({ resumeToken: "resume-9" }));
    await settle();

    const reloaded = load(PAGE, first.ports);
    reloaded.socket().open();

    expect(reloaded.ports.transport.connections).toHaveLength(2);
    expect(reloaded.socket().frames()[0]).toMatchObject({ type: "session_resume", resume_token: "resume-9" });
  });

  it("answers a call for a tool registered before the session was claimed", async () => {
    const { appduct, socket } = load(PAGE);
    appduct.registerTool({ name: "ping", description: "Say pong.", handler: () => "pong" });

    const connecting = appduct.connect(payload);
    socket().open();
    socket().receive(ack());
    await connecting;
    socket().receive({ type: "tool_call", session_id: SESSION_ID, id: "c1", name: "ping", args: {} });
    await settle();

    expect(socket().frames()).toContainEqual(
      expect.objectContaining({ type: "tool_registry_snapshot", tools: [expect.objectContaining({ name: "ping" })] }),
    );
    expect(socket().frames()).toContainEqual({ type: "tool_result", session_id: SESSION_ID, id: "c1", result: "pong" });
  });

  it("sends a posted event once it is registered", async () => {
    const { appduct, socket } = load(PAGE);
    appduct.registerEvent({ name: "saved", description: "A document was saved." });

    const connecting = appduct.connect(payload);
    socket().open();
    socket().receive(ack({ eventRegistry: true }));
    await connecting;
    await appduct.postEvent("saved", { id: 1 });

    expect(socket().frames()).toContainEqual(
      expect.objectContaining({ type: "event", name: "saved", payload: { id: 1 } }),
    );
  });

  it("closes the session on disconnect", async () => {
    const { appduct, socket } = load(PAGE);
    const connecting = appduct.connect(payload);
    socket().open();
    socket().receive(ack());
    await connecting;

    await appduct.disconnect();

    expect(socket().closedByCore?.code).toBe(1000);
  });
});
