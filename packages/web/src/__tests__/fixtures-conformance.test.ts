import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SESSION_ID, ack, connectInput, settle, setup } from "./harness.js";

/**
 * The shared vectors in `packages/native/fixtures`, asserted through the web core's public
 * API the way the Swift and Kotlin suites assert them through theirs. `bootstrap-payloads.json`,
 * `bootstrap-links.json` and `spki-pin.json` are not run here: the web core never decodes a link
 * (the browser entry does, slice 4) and has no TLS pin.
 */
const FIXTURES_DIR = fileURLToPath(new URL("../../../native/fixtures/", import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, "utf8")) as T;

type DescriptorVector = { name: string; descriptor: unknown; valid: boolean };

describe("tool-descriptors.json", () => {
  const vectors = load<DescriptorVector[]>("tool-descriptors.json");

  it("has vectors", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))("registerTool: %s", (_name, vector) => {
    const { core } = setup();
    const register = () => core.registerTool(JSON.stringify(vector.descriptor));
    if (vector.valid) {
      expect(register).not.toThrow();
    } else {
      expect(register).toThrow();
    }
  });
});

describe("event-descriptors.json", () => {
  const vectors = load<DescriptorVector[]>("event-descriptors.json");

  it("has vectors", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))("registerEvent: %s", (_name, vector) => {
    const { core } = setup();
    const register = () => core.registerEvent(JSON.stringify(vector.descriptor));
    if (vector.valid) {
      expect(register).not.toThrow();
    } else {
      expect(register).toThrow();
    }
  });
});

type RegistryFramesVector = {
  name: string;
  sessionId: string;
  declaredBeforeAck: unknown[];
  afterAck: ({ op: "register"; event: unknown } | { op: "remove"; name: string })[];
  frames: unknown[];
};

describe("event-registry-frames.json", () => {
  const vectors = load<RegistryFramesVector[]>("event-registry-frames.json");

  it("has vectors", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))("%s", async (_name, vector) => {
    const h = setup();
    for (const event of vector.declaredBeforeAck) h.core.registerEvent(JSON.stringify(event));

    const connecting = h.core.connect(JSON.stringify(connectInput({ sessionId: vector.sessionId })), false);
    h.last().open();
    h.last().receive(ack({ sessionId: vector.sessionId, eventRegistry: true }));
    await connecting;

    for (const step of vector.afterAck) {
      if (step.op === "register") h.core.registerEvent(JSON.stringify(step.event));
      else h.core.unregisterEvent(step.name);
    }
    await settle();

    const eventFrames = h
      .last()
      .frames()
      .filter((frame) => String(frame.type).startsWith("event_registry_"));
    expect(eventFrames).toEqual(vector.frames);
  });
});

type CloseCodeVector = { code: number | null; reason: string | null; terminal: boolean };

describe("close-codes.json", () => {
  const vectors = load<CloseCodeVector[]>("close-codes.json");

  it("has vectors", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  // A 1000 close is the daemon ending the session on purpose (the web core, like the Swift and
  // Kotlin ones, reports it as lost "revoked"); it is covered in web-core.test.ts.
  const midSession = vectors.filter((vector) => vector.code !== 1000);

  it.each(midSession.map((vector) => [`${vector.code} ${vector.reason}`, vector] as const))(
    "a close with %s during the session",
    async (_label, vector) => {
      const h = setup();
      const socket = await h.claim();

      socket.closeFromDaemon(vector.code ?? undefined, vector.reason ?? undefined);
      await settle();

      if (vector.terminal) {
        expect(h.core.getState()).toBe("closed");
        expect(h.recorded.sessions.at(-1)).toEqual({
          type: "lost",
          sessionId: null,
          alias: null,
          reason: vector.reason ?? "rejected_by_daemon",
        });
      } else {
        expect(h.core.getState()).toBe("reconnecting");
        expect(h.recorded.sessions.map((session) => session.type)).toEqual(["claimed"]);
      }
    },
  );

  it.each(midSession.filter((vector) => vector.terminal).map((vector) => [String(vector.reason), vector] as const))(
    "a resume refused with %s is final",
    async (_label, vector) => {
      const h = setup();
      const socket = await h.claim();
      socket.drop();
      await settle();
      h.clock.advance(250);
      h.last().open();
      h.last().closeFromDaemon(vector.code ?? undefined, vector.reason ?? undefined);
      await settle();

      expect(h.recorded.sessions.at(-1)).toMatchObject({ type: "lost", reason: vector.reason });
      h.clock.advance(60_000);
      expect(h.transport.connections).toHaveLength(2);
    },
  );
});

type FrameLimits = {
  limitBytes: number;
  vectors: { name: string; frameBytes: number; filler: string; sent: boolean }[];
};

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** A string that makes a frame carrying it exactly `frameBytes` long, given the frame's size with `""`. */
const padding = (vector: FrameLimits["vectors"][number], emptyFrameBytes: number) => {
  const pad = vector.frameBytes - emptyFrameBytes;
  const unit = utf8Bytes(vector.filler);
  const count = Math.floor(pad / unit);
  return vector.filler.repeat(count) + "a".repeat(pad - count * unit);
};

describe("frame-limits.json", () => {
  const { limitBytes, vectors } = load<FrameLimits>("frame-limits.json");

  it("has vectors", () => {
    expect(limitBytes).toBe(262_144);
    expect(vectors.length).toBeGreaterThan(0);
  });

  describe.each(vectors.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
    it("answers a tool result as sent or as tool_serialization_error naming the size, and keeps the session active", async () => {
      const h = setup();
      h.core.registerTool(JSON.stringify({ name: "big", description: "Returns a string." }));
      const socket = await h.claim();
      const call = (id: string) => socket.receive({ type: "tool_call", session_id: SESSION_ID, id, name: "big", args: {} });
      const frames = (type: string) => socket.frames().filter((frame) => frame.type === type);

      call("id-a");
      h.core.respondToToolCall("id-a", '""', null);
      const emptyFrameBytes = utf8Bytes(socket.sent.at(-1) as string);

      call("id-b");
      h.core.respondToToolCall("id-b", JSON.stringify(padding(vector, emptyFrameBytes)), null);

      if (vector.sent) {
        expect(frames("tool_result").map((frame) => frame.id)).toEqual(["id-a", "id-b"]);
        expect(utf8Bytes(socket.sent.at(-1) as string)).toBe(vector.frameBytes);
      } else {
        expect(frames("tool_result").map((frame) => frame.id)).toEqual(["id-a"]);
        expect(frames("tool_error")).toEqual([
          {
            type: "tool_error",
            session_id: SESSION_ID,
            id: "id-b",
            error: {
              type: "tool_serialization_error",
              message: `Appduct frame is ${vector.frameBytes} bytes, over the ${limitBytes}-byte limit.`,
            },
          },
        ]);
      }
      expect(h.core.getState()).toBe("active");
      expect(socket.closedByCore).toBeUndefined();
    });

    it("sends an event as is or reports it to the error listener naming the size, and keeps the session active", async () => {
      const h = setup();
      const socket = await h.claim();
      const events = () => socket.frames().filter((frame) => frame.type === "event");

      await h.core.postEvent("big", '""');
      const emptyFrameBytes = utf8Bytes(socket.sent.at(-1) as string);
      await h.core.postEvent("big", JSON.stringify(padding(vector, emptyFrameBytes)));

      if (vector.sent) {
        expect(events()).toHaveLength(2);
        expect(utf8Bytes(socket.sent.at(-1) as string)).toBe(vector.frameBytes);
        expect(h.recorded.errors).toEqual([]);
      } else {
        expect(events()).toHaveLength(1);
        expect(h.recorded.errors).toEqual([
          {
            phase: "socket",
            message: `Appduct frame is ${vector.frameBytes} bytes, over the ${limitBytes}-byte limit.`,
          },
        ]);
      }
      expect(h.core.getState()).toBe("active");
      expect(socket.closedByCore).toBeUndefined();
    });
  });
});
