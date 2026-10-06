import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ack, connectInput, settle, setup } from "./harness.js";

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
