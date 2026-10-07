import { describe, expect, it } from "vitest";

import { START_MS, SESSION_ID, ack, connectInput, settle, setup, toolDescriptor, DEVICE, type Harness } from "./harness.js";
import type { MemoryConnection } from "../core/index.js";

const ofType = (connection: MemoryConnection, type: string) => connection.frames().filter((frame) => frame.type === type);

describe("claiming a session", () => {
  it("opens a plain WebSocket to the advertised address and sends session_claim first", async () => {
    const h = setup();
    const connecting = h.startClaim();

    const socket = h.last();
    expect(socket.url).toBe("ws://127.0.0.1:49152");
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(socket.frames()).toEqual([
      {
        type: "session_claim",
        protocol_version: 2,
        session_id: SESSION_ID,
        token: "claim-token",
        device_manufacturer: DEVICE.manufacturer,
        device_model: DEVICE.model,
        device_os: DEVICE.os,
      },
    ]);

    socket.receive(ack());
    await connecting;
  });

  it("resolves connect on the ack, goes active and announces the claim", async () => {
    const h = setup();
    expect(h.core.getState()).toBe("idle");
    const connecting = h.startClaim();
    expect(h.core.getState()).toBe("connecting");
    expect(h.core.getSessionId()).toBe(SESSION_ID);

    h.last().open();
    h.last().receive(ack());
    await connecting;

    expect(h.core.getState()).toBe("active");
    expect(h.recorded.states.map((s) => s.state)).toEqual(["connecting", "active"]);
    expect(h.recorded.sessions).toEqual([{ type: "claimed", sessionId: SESSION_ID, alias: "chrome" }]);
  });

  it("brackets an IPv6 address in the socket URL", () => {
    const h = setup();
    void h.startClaim({ ip: "::1" }).catch(() => undefined);
    expect(h.last().url).toBe("ws://[::1]:49152");
  });

  it("accepts a decoded bootstrap payload as input", async () => {
    const h = setup();
    const connecting = h.core.connect(
      JSON.stringify({
        family: 4,
        address: "127.0.0.1",
        port: 49152,
        sessionId: SESSION_ID,
        token: "claim-token",
        expiresAt: Math.floor(START_MS / 1000) + 60,
      }),
      false,
    );
    h.last().open();
    expect(h.last().frames()[0]).toMatchObject({ type: "session_claim", token: "claim-token" });
    h.last().receive(ack());
    await connecting;
  });

  it("rejects an expired payload without opening a socket", async () => {
    const h = setup();
    await expect(h.startClaim({ expiresAt: Math.floor(START_MS / 1000) - 1 })).rejects.toThrow(/expired/i);
    expect(h.transport.connections).toEqual([]);
  });

  it("rejects a second connect while one is in flight unless it supersedes", async () => {
    const h = setup();
    void h.startClaim().catch(() => undefined);

    await expect(h.startClaim({ sessionId: "other" })).rejects.toThrow(/already connecting or active/);

    const superseding = h.core.connect(JSON.stringify(connectInput({ sessionId: "other" })), true);
    expect(h.last().url).toBe("ws://127.0.0.1:49152");
    expect(h.transport.connections).toHaveLength(2);
    expect(h.transport.connections[0]?.closedByCore).toBeDefined();
    h.last().open();
    h.last().receive(ack({ sessionId: "other" }));
    await superseding;
    expect(h.core.getSessionId()).toBe("other");
  });

  it("surfaces a claim the daemon refuses as an error from connect", async () => {
    const h = setup();
    const connecting = h.startClaim();
    const rejected = expect(connecting).rejects.toThrow("invalid_token");

    h.last().open();
    h.last().closeFromDaemon(1008, "invalid_token");
    await rejected;

    expect(h.core.getState()).toBe("closed");
    expect(h.core.getSessionId()).toBeNull();
    expect(h.recorded.states.at(-1)).toEqual({ state: "closed", reason: "connect_error" });
    expect(h.recorded.errors).toEqual([expect.objectContaining({ phase: "connect", message: "invalid_token" })]);
    expect(h.sessionStore.value()).toBeNull();
    expect(h.recorded.sessions).toEqual([]);
  });

  it("surfaces a socket that never opens as an error from connect", async () => {
    const h = setup();
    const connecting = h.startClaim();
    const rejected = expect(connecting).rejects.toThrow("refused");
    h.last().drop("refused");
    await rejected;
    expect(h.core.getState()).toBe("closed");
  });

  it("surfaces a transport that cannot open as an error from connect", async () => {
    const h = setup();
    h.transport.failNextOpen(new Error("bad url"));
    await expect(h.startClaim()).rejects.toThrow("bad url");
    expect(h.core.getState()).toBe("closed");
  });

  it("refuses an ack for another session by closing the socket with 4008 invalid_ack", async () => {
    const h = setup();
    const connecting = h.startClaim();
    const rejected = expect(connecting).rejects.toThrow("invalid_ack");
    h.last().open();
    h.last().receive(ack({ sessionId: "someone-else" }));
    await rejected;
    expect(h.transport.connections[0]?.closedByCore).toEqual({ code: 4008, reason: "invalid_ack" });
  });

  it("ignores a url because link handling belongs to the browser entry", () => {
    const h = setup();
    expect(h.core.handleUrl("https://example.test/#appduct=abc")).toBe(false);
    expect(h.transport.connections).toEqual([]);
  });
});

describe("syncing the tool registry", () => {
  it("sends a snapshot of the registered tools in registration order right after the ack", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("b_tool", { timeout_ms: 5000 }));
    h.core.registerTool(toolDescriptor("a_tool"));
    h.core.registerTool(toolDescriptor("b_tool", { timeout_ms: 5000, group: "math" }));

    const socket = await h.claim();

    expect(ofType(socket, "tool_registry_snapshot")).toEqual([
      {
        type: "tool_registry_snapshot",
        session_id: SESSION_ID,
        tools: [
          { name: "b_tool", description: "The b_tool tool.", timeout_ms: 5000, group: "math" },
          { name: "a_tool", description: "The a_tool tool." },
        ],
      },
    ]);
    expect(socket.frames()[1]?.type).toBe("tool_registry_snapshot");
  });

  it("clamps a declared timeout into one second to ten minutes", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("fast", { timeout_ms: 5 }));
    h.core.registerTool(toolDescriptor("slow", { timeout_ms: 9_999_999 }));
    const tools = JSON.parse(h.core.getRegisteredToolsJson()) as { name: string; timeout_ms: number }[];
    expect(tools.map((tool) => [tool.name, tool.timeout_ms])).toEqual([
      ["fast", 1000],
      ["slow", 600_000],
    ]);
  });

  it("sends a delta for a tool added or removed while active", async () => {
    const h = setup();
    const socket = await h.claim();

    h.core.registerTool(toolDescriptor("later"));
    h.core.unregisterTool("later");
    h.core.unregisterTool("never_registered");

    expect(ofType(socket, "tool_registry_delta")).toEqual([
      {
        type: "tool_registry_delta",
        session_id: SESSION_ID,
        operation: "upsert",
        tool: { name: "later", description: "The later tool." },
      },
      { type: "tool_registry_delta", session_id: SESSION_ID, operation: "remove", name: "later" },
    ]);
  });

  it("sends nothing for a tool registered before a session exists", () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("early"));
    expect(h.transport.connections).toEqual([]);
    expect(JSON.parse(h.core.getRegisteredToolsJson())).toEqual([{ name: "early", description: "The early tool." }]);
  });

  it("throws on an invalid descriptor and keeps the registry unchanged", () => {
    const h = setup();
    expect(() => h.core.registerTool(toolDescriptor("bad name"))).toThrow();
    expect(JSON.parse(h.core.getRegisteredToolsJson())).toEqual([]);
  });
});

describe("answering tool calls", () => {
  const toolCall = (id: string, name: string, args: unknown = {}) => ({
    type: "tool_call",
    session_id: SESSION_ID,
    id,
    name,
    args,
  });

  it("hands a call to the SDK and sends its result", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("sum"));
    const socket = await h.claim();

    socket.receive(toolCall("call_1", "sum", { a: 2, b: 3 }));
    expect(h.recorded.toolCalls).toEqual([{ id: "call_1", name: "sum", argsJson: '{"a":2,"b":3}' }]);

    h.core.respondToToolCall("call_1", '{"total":5}', null);
    expect(ofType(socket, "tool_result")).toEqual([
      { type: "tool_result", session_id: SESSION_ID, id: "call_1", result: { total: 5 } },
    ]);
  });

  it("sends an error from the SDK with its type unchanged", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("sum"));
    const socket = await h.claim();
    socket.receive(toolCall("call_1", "sum"));

    const error = { type: "tool_input_validation_error", message: "bad", details: { issues: [] } };
    h.core.respondToToolCall("call_1", null, JSON.stringify(error));

    expect(ofType(socket, "tool_error")).toEqual([
      { type: "tool_error", session_id: SESSION_ID, id: "call_1", error },
    ]);
  });

  it("answers a call to an unknown tool with tool_not_found without involving the SDK", async () => {
    const h = setup();
    const socket = await h.claim();
    socket.receive(toolCall("call_1", "ghost"));

    expect(h.recorded.toolCalls).toEqual([]);
    expect(ofType(socket, "tool_error")).toEqual([
      {
        type: "tool_error",
        session_id: SESSION_ID,
        id: "call_1",
        error: { type: "tool_not_found", message: 'Tool "ghost" is not registered in the app.' },
      },
    ]);
  });

  it("reports a call that overruns its declared deadline and tells the SDK to abort it", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("slow", { timeout_ms: 2000 }));
    const socket = await h.claim();
    socket.receive(toolCall("call_1", "slow"));

    h.clock.advance(1999);
    expect(ofType(socket, "tool_error")).toEqual([]);

    h.clock.advance(1);
    expect(ofType(socket, "tool_error")).toEqual([
      {
        type: "tool_error",
        session_id: SESSION_ID,
        id: "call_1",
        error: { type: "tool_timeout", message: 'Tool "slow" did not respond within 2000ms.' },
      },
    ]);
    expect(h.recorded.toolCancels).toEqual([{ id: "call_1", reason: "timeout" }]);

    h.core.respondToToolCall("call_1", "1", null);
    expect(ofType(socket, "tool_result")).toEqual([]);
  });

  it("gives a tool with no declared deadline ten seconds", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("plain"));
    const socket = await h.claim();
    socket.receive(toolCall("call_1", "plain"));

    h.clock.advance(9999);
    expect(ofType(socket, "tool_error")).toEqual([]);
    h.clock.advance(1);
    expect(ofType(socket, "tool_error")).toHaveLength(1);
  });

  it("stops the deadline timer once the call is answered", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("plain"));
    const socket = await h.claim();
    socket.receive(toolCall("call_1", "plain"));
    h.core.respondToToolCall("call_1", "null", null);

    h.clock.advance(60_000);
    expect(ofType(socket, "tool_error")).toEqual([]);
    expect(ofType(socket, "tool_result")).toHaveLength(1);
  });

  it("cancels a call on tool_cancel, replies tool_cancelled and ignores an unknown id", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("plain"));
    const socket = await h.claim();
    socket.receive(toolCall("call_1", "plain"));

    socket.receive({ type: "tool_cancel", session_id: SESSION_ID, id: "unknown", reason: "client_cancelled" });
    expect(ofType(socket, "tool_error")).toEqual([]);

    socket.receive({ type: "tool_cancel", session_id: SESSION_ID, id: "call_1", reason: "client_cancelled" });
    expect(ofType(socket, "tool_error")).toEqual([
      {
        type: "tool_error",
        session_id: SESSION_ID,
        id: "call_1",
        error: { type: "tool_cancelled", message: 'Tool "plain" was cancelled.' },
      },
    ]);
    expect(h.recorded.toolCancels).toEqual([{ id: "call_1", reason: "client_cancelled" }]);
  });

  it("sends progress for an in-flight call and drops it for a finished one", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("plain"));
    const socket = await h.claim();
    socket.receive(toolCall("call_1", "plain"));

    h.core.reportToolProgress("call_1", 0.5, "Halfway there");
    h.core.reportToolProgress("call_1", null, null);
    h.core.respondToToolCall("call_1", "null", null);
    h.core.reportToolProgress("call_1", 1, null);

    expect(ofType(socket, "tool_call_progress")).toEqual([
      { type: "tool_call_progress", session_id: SESSION_ID, id: "call_1", progress: 0.5, message: "Halfway there" },
      { type: "tool_call_progress", session_id: SESSION_ID, id: "call_1" },
    ]);
  });

  it("aborts calls in flight when the socket drops, without sending anything", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("plain"));
    const socket = await h.claim();
    socket.receive(toolCall("call_1", "plain"));

    socket.drop();
    await settle();

    expect(h.recorded.toolCancels).toEqual([{ id: "call_1", reason: "session_suspended" }]);
    expect(ofType(socket, "tool_error")).toEqual([]);
  });

  it("closes the socket with 4008 session_mismatch on a frame for another session", async () => {
    const h = setup();
    const socket = await h.claim();
    socket.receive({ type: "tool_cancel", session_id: "other", id: "x", reason: "client_cancelled" });
    expect(socket.closedByCore).toEqual({ code: 4008, reason: "session_mismatch" });
  });

  it("ends the session without retrying after it closed the socket for a session mismatch", async () => {
    const h = setup();
    const socket = await h.claim();
    socket.receive({ type: "tool_cancel", session_id: "other", id: "x", reason: "client_cancelled" });
    await settle();

    expect(h.recorded.sessions.at(-1)).toMatchObject({ type: "lost", reason: "session_mismatch" });
    expect(h.core.getState()).toBe("closed");
    h.clock.advance(60_000);
    expect(h.transport.connections).toHaveLength(1);
  });
});

describe("posting events", () => {
  it("sends an event frame stamped with the clock", async () => {
    const h = setup();
    const socket = await h.claim();
    h.clock.advance(1234);

    await h.core.postEvent("screen_changed", '{"screen":"Checkout"}');
    await h.core.postEvent("bare", null);

    expect(ofType(socket, "event")).toEqual([
      {
        type: "event",
        session_id: SESSION_ID,
        name: "screen_changed",
        payload: { screen: "Checkout" },
        ts: START_MS + 1234,
      },
      { type: "event", session_id: SESSION_ID, name: "bare", ts: START_MS + 1234 },
    ]);
  });

  it("rejects with E_APPDUCT_NOT_ACTIVE while no session is active", async () => {
    const h = setup();
    await expect(h.core.postEvent("early", null)).rejects.toMatchObject({ code: "E_APPDUCT_NOT_ACTIVE" });
  });
});

describe("a tool registry snapshot over the frame limit", () => {
  it("is reported to the error listener and leaves the session active", async () => {
    const h = setup();
    for (let i = 0; i < 70; i++) {
      h.core.registerTool(JSON.stringify({ name: `tool_${i}`, description: "x".repeat(4096) }));
    }

    const socket = await h.claim();

    expect(ofType(socket, "tool_registry_snapshot")).toEqual([]);
    expect(h.recorded.errors).toHaveLength(1);
    expect(h.recorded.errors[0]?.phase).toBe("tool");
    expect(h.recorded.errors[0]?.message).toMatch(/^Appduct frame is \d+ bytes, over the 262144-byte limit\.$/);
    expect(h.core.getState()).toBe("active");
  });
});

describe("declaring events", () => {
  const event = (name: string) => JSON.stringify({ name, description: `The ${name} event.` });

  it("sends no event frames when the ack does not accept them", async () => {
    const h = setup();
    h.core.registerEvent(event("early"));
    const socket = await h.claim({ eventRegistry: false });
    h.core.registerEvent(event("later"));
    h.core.unregisterEvent("later");
    expect(socket.frames().filter((frame) => String(frame.type).startsWith("event_registry_"))).toEqual([]);
  });

  it("sends a delta for an event declared or withdrawn while active", async () => {
    const h = setup();
    const socket = await h.claim({ eventRegistry: true });
    h.core.registerEvent(event("later"));
    h.core.unregisterEvent("later");
    h.core.unregisterEvent("never_declared");

    expect(ofType(socket, "event_registry_delta")).toEqual([
      {
        type: "event_registry_delta",
        session_id: SESSION_ID,
        operation: "upsert",
        event: { name: "later", description: "The later event." },
      },
      { type: "event_registry_delta", session_id: SESSION_ID, operation: "remove", name: "later" },
    ]);
  });

  it("covers a declaration made while handling the ack in the snapshot instead of a delta", async () => {
    const h = setup();
    h.core.addListener("sessionChange", () => h.core.registerEvent(event("from_listener")));
    const socket = await h.claim({ eventRegistry: true });

    expect(ofType(socket, "event_registry_delta")).toEqual([]);
    expect(ofType(socket, "event_registry_snapshot")).toEqual([
      {
        type: "event_registry_snapshot",
        session_id: SESSION_ID,
        events: [{ name: "from_listener", description: "The from_listener event." }],
      },
    ]);
  });
});

describe("recovering from a lost socket", () => {
  it("resumes after a jittered delay with the resume token from the last ack", async () => {
    const h = setup();
    h.core.registerTool(toolDescriptor("plain"));
    const first = await h.claim({ resumeToken: "resume-1" });

    first.drop();
    await settle();
    expect(h.core.getState()).toBe("reconnecting");
    expect(h.recorded.errors).toEqual([expect.objectContaining({ phase: "socket" })]);

    h.clock.advance(249);
    expect(h.transport.connections).toHaveLength(1);

    h.clock.advance(1);
    expect(h.transport.connections).toHaveLength(2);
    const second = h.last();
    second.open();
    second.receive(ack({ resumeToken: "resume-2" }));
    await settle();
    expect(second.url).toBe("ws://127.0.0.1:49152");
    expect(second.frames()[0]).toEqual({
      type: "session_resume",
      protocol_version: 2,
      session_id: SESSION_ID,
      resume_token: "resume-1",
    });
    expect(h.core.getState()).toBe("active");
    expect(h.recorded.sessions.map((s) => s.type)).toEqual(["claimed", "resumed"]);
    expect(ofType(second, "tool_registry_snapshot")).toHaveLength(1);
  });

  it("uses the newest resume token on every attempt", async () => {
    const h = setup();
    const first = await h.claim({ resumeToken: "resume-1" });
    first.drop();
    await settle();
    h.clock.advance(250);
    h.last().open();
    h.last().receive(ack({ resumeToken: "resume-2" }));
    await settle();

    h.last().drop();
    await settle();
    h.clock.advance(250);
    expect(h.last().url).toBe("ws://127.0.0.1:49152");
    h.last().open();
    expect(h.last().frames()[0]).toMatchObject({ type: "session_resume", resume_token: "resume-2" });
  });

  it("backs off further after a failed attempt and reports why it failed", async () => {
    const h = setup();
    const first = await h.claim();
    first.drop();
    await settle();

    h.clock.advance(250);
    h.last().drop("host unreachable");
    await settle();
    expect(h.recorded.errors.at(-1)?.message).toContain("host unreachable");

    // Second retry: random() = 0.5 of a 1 s ceiling.
    h.clock.advance(499);
    expect(h.transport.connections).toHaveLength(2);
    h.clock.advance(1);
    expect(h.transport.connections).toHaveLength(3);
  });

  it("gives the session up as lost when the daemon refuses the resume for good", async () => {
    const h = setup();
    const first = await h.claim();
    first.drop();
    await settle();
    h.clock.advance(250);
    h.last().open();
    h.last().closeFromDaemon(1008, "invalid_resume_token");
    await settle();

    expect(h.core.getState()).toBe("closed");
    expect(h.core.getSessionId()).toBeNull();
    expect(h.recorded.sessions.at(-1)).toEqual({
      type: "lost",
      sessionId: null,
      alias: null,
      reason: "invalid_resume_token",
    });
    expect(h.sessionStore.value()).toBeNull();
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("gives the session up as lost when the grace window runs out", async () => {
    const h = setup();
    const first = await h.claim({ graceS: 2 });
    first.drop();
    await settle();

    h.clock.advance(2000);
    await settle();

    expect(h.core.getState()).toBe("closed");
    expect(h.recorded.states.at(-1)).toEqual({ state: "closed", reason: "grace_expired" });
    expect(h.recorded.sessions.at(-1)).toEqual({
      type: "lost",
      sessionId: null,
      alias: null,
      reason: "grace_expired",
    });
    expect(h.sessionStore.value()).toBeNull();
  });

  it("treats a 1008 close during the session as a loss, without retrying", async () => {
    const h = setup();
    const socket = await h.claim();
    socket.closeFromDaemon(1008, "invalid_registry");
    await settle();

    expect(h.recorded.sessions.at(-1)).toMatchObject({ type: "lost", reason: "invalid_registry" });
    expect(h.core.getState()).toBe("closed");
    h.clock.advance(60_000);
    expect(h.transport.connections).toHaveLength(1);
  });

  it("treats a 1000 close as the daemon revoking the session", async () => {
    const h = setup();
    const socket = await h.claim();
    socket.closeFromDaemon(1000, "revoked");
    await settle();

    expect(h.recorded.sessions.at(-1)).toMatchObject({ type: "lost", reason: "revoked" });
    expect(h.recorded.states.at(-1)).toEqual({ state: "closed", reason: "revoked" });
    expect(h.sessionStore.value()).toBeNull();
  });
});

describe("resuming after a reload", () => {
  it("resumes the stored session instead of claiming a new one", async () => {
    const before = setup();
    before.core.registerTool(toolDescriptor("plain"));
    await before.claim({ resumeToken: "resume-1" });

    const after = before.reload();
    after.core.registerTool(toolDescriptor("plain"));
    expect(await after.core.restoreSession()).toBe(true);
    expect(after.core.getState()).toBe("reconnecting");
    expect(after.core.getSessionId()).toBe(SESSION_ID);

    const socket = after.last();
    expect(socket).not.toBe(before.transport.connections[0]);
    socket.open();
    expect(socket.frames()).toEqual([
      { type: "session_resume", protocol_version: 2, session_id: SESSION_ID, resume_token: "resume-1" },
    ]);
    socket.receive(ack({ resumeToken: "resume-2" }));
    await settle();

    expect(after.core.getState()).toBe("active");
    expect(after.recorded.sessions).toEqual([{ type: "resumed", sessionId: SESSION_ID, alias: "chrome" }]);
    expect(ofType(socket, "tool_registry_snapshot")).toHaveLength(1);
    expect(ofType(socket, "session_claim")).toEqual([]);
  });

  it("stores the rotated token so a second reload resumes with it", async () => {
    const first = setup();
    await first.claim({ resumeToken: "resume-1" });
    const second = first.reload();
    await second.core.restoreSession();
    second.last().open();
    second.last().receive(ack({ resumeToken: "resume-2" }));
    await settle();

    const third = second.reload();
    await third.core.restoreSession();
    third.last().open();
    expect(third.last().frames()[0]).toMatchObject({ resume_token: "resume-2" });
  });

  it("returns false when nothing is stored", async () => {
    const h = setup();
    expect(await h.core.restoreSession()).toBe(false);
    expect(h.transport.connections).toEqual([]);
  });

  it("returns false and forgets a session whose grace window has run out", async () => {
    const first = setup();
    const socket = await first.claim({ graceS: 30 });
    socket.drop();
    await settle();
    first.clock.advance(30_000);

    const second = first.reload();
    expect(await second.core.restoreSession()).toBe(false);
    expect(second.sessionStore.value()).toBeNull();
  });

  it("returns false and forgets a stored value it cannot read", async () => {
    const h = setup();
    h.sessionStore.write("{not json");
    expect(await h.core.restoreSession()).toBe(false);
    expect(h.sessionStore.value()).toBeNull();
  });

  it("returns false while a session is already active", async () => {
    const h = setup();
    await h.claim();
    expect(await h.core.restoreSession()).toBe(false);
  });
});

describe("disconnecting", () => {
  it("closes the socket, forgets the session and announces the loss", async () => {
    const h = setup();
    const socket = await h.claim();

    await h.core.disconnect();
    await settle();

    expect(socket.closedByCore?.code).toBe(1000);
    expect(h.core.getState()).toBe("closed");
    expect(h.core.getSessionId()).toBeNull();
    expect(h.recorded.states.at(-1)).toEqual({ state: "closed", reason: "closed_by_app" });
    expect(h.recorded.sessions.at(-1)).toEqual({
      type: "lost",
      sessionId: null,
      alias: null,
      reason: "closed_by_app",
    });
    expect(h.sessionStore.value()).toBeNull();
    expect(await h.reload().core.restoreSession()).toBe(false);
  });

  it("fails a connect that is still waiting for its ack", async () => {
    const h = setup();
    const connecting = h.startClaim();
    const rejected = expect(connecting).rejects.toThrow(/closed/);
    await h.core.disconnect();
    await rejected;
  });
});
