import { describe, expect, vi, test } from "vitest";

import { createAppductClient } from "../client";
import type {
  AppductNativeEvents,
  AppductNativeModuleLike,
} from "../client-types";
import { logger } from "../logger";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/**
 * Issue #48 phase 2 moved reconnect/backoff, the tool registry's wire deltas, claim/resume, and
 * per-call timeout entirely into the native core (see
 * `packages/native/ios/Tests/AppductCoreTests/AppductClientTests.swift` for that behavioral
 * spec). This file covers the bridge contract instead: `createAppductClient` against a mocked
 * `AppductNativeModuleLike` that emits `onToolCall`/`onToolCancel`/`onStateChange`/
 * `onSessionChange`/`onError` the way the real TurboModule does, asserting the thin JS layer wires
 * them onto the public surface correctly.
 */

type Listener<K extends keyof AppductNativeEvents> =
  AppductNativeEvents[K];

const createFakeNativeModule = () => {
  const listeners: { [K in keyof AppductNativeEvents]: Set<Listener<K>> } = {
    toolCall: new Set(),
    toolCancel: new Set(),
    stateChange: new Set(),
    sessionChange: new Set(),
    error: new Set(),
  };

  const registerToolCalls: string[] = [];
  const unregisterToolCalls: string[] = [];
  const respondCalls: {
    id: string;
    resultJson: string | null;
    errorJson: string | null;
  }[] = [];
  const progressCalls: {
    id: string;
    progress: number | null;
    message: string | null;
  }[] = [];
  const connectCalls: { inputJson: string; supersede: boolean }[] = [];
  let sessionId: string | null = null;
  let state = "idle";
  let registeredToolsJson = "[]";

  const emit = <K extends keyof AppductNativeEvents>(
    kind: K,
    event: Parameters<Listener<K>>[0],
  ) => {
    for (const listener of listeners[kind]) {
      (listener as (e: typeof event) => void)(event);
    }
  };

  const module: AppductNativeModuleLike = {
    registerTool: (descriptorJson) => registerToolCalls.push(descriptorJson),
    unregisterTool: (name) => unregisterToolCalls.push(name),
    handleUrl: (url) => url.includes("appduct="),
    connect: async (inputJson, supersede) => {
      connectCalls.push({ inputJson, supersede });
    },
    restoreSession: async () => false,
    disconnect: async () => {},
    postEvent: async () => {},
    respondToToolCall: (id, resultJson, errorJson) =>
      respondCalls.push({ id, resultJson, errorJson }),
    reportToolProgress: (id, progress, message) =>
      progressCalls.push({ id, progress, message }),
    getState: () => state,
    getSessionId: () => sessionId,
    getRegisteredToolsJson: () => registeredToolsJson,
    addListener: (eventName, listener) => {
      listeners[eventName].add(listener as never);
      return { remove: () => listeners[eventName].delete(listener as never) };
    },
  };

  return {
    module,
    emit,
    registerToolCalls,
    unregisterToolCalls,
    respondCalls,
    progressCalls,
    connectCalls,
    setSessionId: (value: string | null) => {
      sessionId = value;
    },
    setState: (value: string) => {
      state = value;
    },
    setRegisteredToolsJson: (value: string) => {
      registeredToolsJson = value;
    },
  };
};

describe("createAppductClient (bridge contract)", () => {
  test("registerTool sends the descriptor to native and returns an identity-safe disposer", () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    const registration = client.registerTool({
      name: "seed_cart",
      description: "Fill the cart.",
      handler: () => undefined,
    });

    expect(fake.registerToolCalls).toHaveLength(1);
    expect(JSON.parse(fake.registerToolCalls[0]!)).toMatchObject({
      name: "seed_cart",
    });

    // Stale disposer: a newer registration under the same name replaces this one.
    const second = client.registerTool({
      name: "seed_cart",
      description: "Fill the cart, v2.",
      handler: () => undefined,
    });
    registration.remove();
    expect(fake.unregisterToolCalls).toEqual([]);
    second.remove();
    expect(fake.unregisterToolCalls).toEqual(["seed_cart"]);
  });

  test("registerTool puts group on the wire descriptor only when one is declared", () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    client.registerTool({
      name: "pay",
      description: "Pay.",
      group: "checkout/payment",
      handler: () => undefined,
    });
    client.registerTool({
      name: "ping",
      description: "Ping.",
      handler: () => undefined,
    });

    expect(JSON.parse(fake.registerToolCalls[0]!)).toMatchObject({
      name: "pay",
      group: "checkout/payment",
    });
    expect(JSON.parse(fake.registerToolCalls[1]!)).not.toHaveProperty("group");
  });

  test("createToolGroup binds the group onto every registration it makes", async () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);
    const { createToolGroupFactory } = await import("../tool-group");

    const registerCartTool = createToolGroupFactory((registration) =>
      client.registerTool(registration),
    )("cart");
    const registration = registerCartTool({
      name: "add_item",
      description: "Add.",
      handler: () => undefined,
    });
    registerCartTool({
      name: "clear",
      description: "Clear.",
      handler: () => undefined,
    });

    const groups = fake.registerToolCalls.map((json) => JSON.parse(json).group);
    expect(groups).toEqual(["cart", "cart"]);

    registration.remove();
    expect(fake.unregisterToolCalls).toEqual(["add_item"]);
  });

  test("onToolCall dispatches to the registered handler and answers via respondToToolCall", async () => {
    const fake = createFakeNativeModule();
    fake.setSessionId("session-1");
    const client = createAppductClient(fake.module);

    client.registerTool({
      name: "echo",
      description: "Echo.",
      // A raw (schema-less) JSON Schema object accepts args/results unvalidated -- otherwise a
      // tool with no schema at all only accepts empty input and must return nothing (see
      // tool-invocation.test.ts).
      inputSchema: { type: "object" },
      outputSchema: {},
      handler: (args: unknown) => ({ echoed: args }),
    });

    fake.emit("toolCall", {
      id: "call-1",
      name: "echo",
      argsJson: JSON.stringify({ a: 1 }),
    });
    await vi.waitFor(() => expect(fake.respondCalls).toHaveLength(1));

    expect(fake.respondCalls[0]?.errorJson).toBeNull();
    expect(JSON.parse(fake.respondCalls[0]!.resultJson!)).toEqual({
      echoed: { a: 1 },
    });
  });

  test("onToolCancel aborts the matching handler's signal", async () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);
    let sawAbort = false;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });

    client.registerTool({
      name: "slow",
      description: "Slow.",
      handler: async (_args: unknown, context) => {
        started();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          });
        });
      },
    });

    fake.emit("toolCall", { id: "call-1", name: "slow", argsJson: "{}" });
    await startedPromise;
    fake.emit("toolCancel", { id: "call-1", reason: "timeout" });
    await vi.waitFor(() => expect(sawAbort).toBe(true));
  });

  test("onStateChange/onSessionChange/onError forward onto addAppductListener", () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    const states: unknown[] = [];
    const sessions: unknown[] = [];
    const errors: unknown[] = [];
    client.addAppductListener("stateChange", (e) => states.push(e));
    client.addAppductListener("sessionChange", (e) => sessions.push(e));
    client.addAppductListener("error", (e) => errors.push(e));

    fake.emit("stateChange", { state: "active", reason: undefined });
    fake.emit("sessionChange", {
      type: "claimed",
      sessionId: "session-1",
      alias: "iphone-1",
    });
    fake.emit("error", { phase: "tool", message: "boom" });

    expect(states).toEqual([{ state: "active", reason: undefined }]);
    expect(sessions).toEqual([
      {
        type: "claimed",
        sessionId: "session-1",
        alias: "iphone-1",
        reason: undefined,
      },
    ]);
    expect(errors).toEqual([
      expect.objectContaining({ phase: "tool", message: "boom" }),
    ]);
  });

  test("sessionChange carries type/reason for claim, resume, and every lost cause", () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);
    const sessions: unknown[] = [];
    client.addAppductListener("sessionChange", (e) => sessions.push(e));

    fake.emit("sessionChange", {
      type: "claimed",
      sessionId: "session-1",
      alias: "iphone-1",
    });
    fake.emit("sessionChange", {
      type: "resumed",
      sessionId: "session-1",
      alias: "iphone-1",
    });
    fake.emit("sessionChange", {
      type: "lost",
      sessionId: null,
      alias: null,
      reason: "revoked",
    });
    fake.emit("sessionChange", {
      type: "lost",
      sessionId: null,
      alias: null,
      reason: "grace_expired",
    });
    fake.emit("sessionChange", {
      type: "lost",
      sessionId: null,
      alias: null,
      reason: "closed_by_app",
    });

    expect(sessions).toEqual([
      {
        type: "claimed",
        sessionId: "session-1",
        alias: "iphone-1",
        reason: undefined,
      },
      {
        type: "resumed",
        sessionId: "session-1",
        alias: "iphone-1",
        reason: undefined,
      },
      { type: "lost", sessionId: null, alias: null, reason: "revoked" },
      { type: "lost", sessionId: null, alias: null, reason: "grace_expired" },
      { type: "lost", sessionId: null, alias: null, reason: "closed_by_app" },
    ]);
  });

  test("connect() serializes the input to JSON and forwards supersede", async () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    await client.connect(
      {
        ip: "10.0.0.1",
        port: 8443,
        sessionId: "s",
        token: "t",
        expiresAt: 123,
      },
      { supersede: true },
    );

    expect(fake.connectCalls).toHaveLength(1);
    expect(fake.connectCalls[0]?.supersede).toBe(true);
    expect(JSON.parse(fake.connectCalls[0]!.inputJson)).toMatchObject({
      sessionId: "s",
    });
  });

  test("getClientState()/getState() both read native's unified state", () => {
    const fake = createFakeNativeModule();
    fake.setState("reconnecting");
    const client = createAppductClient(fake.module);

    expect(client.getClientState()).toBe("reconnecting");
    expect(client.getState()).toBe("reconnecting");
  });

  test("getRegisteredTools() reads straight from native", () => {
    const fake = createFakeNativeModule();
    fake.setRegisteredToolsJson(
      JSON.stringify([{ name: "a", description: "x" }]),
    );
    const client = createAppductClient(fake.module);

    expect(client.getRegisteredTools()).toEqual([
      { name: "a", description: "x" },
    ]);
  });

  test("handleUrl() forwards to native", () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    expect(client.handleUrl("myapp://open?appduct=abc")).toBe(true);
    expect(client.handleUrl("myapp://open")).toBe(false);
  });

  test("destroy() removes every native subscription", () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    client.addAppductListener("error", () => {});
    client.destroy();

    fake.emit("toolCall", { id: "call-1", name: "anything", argsJson: "{}" });
    // No respond call: the toolCall listener was removed by destroy().
    expect(fake.respondCalls).toEqual([]);
  });

  describe("postEvent", () => {
    test("never throws, even when native rejects", async () => {
      const fake = createFakeNativeModule();
      fake.module.postEvent = async () => {
        throw new Error("boom");
      };
      const client = createAppductClient(fake.module);

      await expect(client.postEvent("screen_changed")).resolves.toBeUndefined();
    });

    test('a rejection carrying code "E_APPDUCT_NOT_ACTIVE" is a dev-only drop, not an `error` event', async () => {
      const fake = createFakeNativeModule();
      fake.module.postEvent = async () => {
        const error = new Error("no active session") as Error & {
          code?: string;
        };
        error.code = "E_APPDUCT_NOT_ACTIVE";
        throw error;
      };
      const client = createAppductClient(fake.module);
      const devWarnSpy = vi.spyOn(logger, "devWarn");
      const warnSpy = vi.spyOn(logger, "warn");
      const errorEvents: unknown[] = [];
      client.addAppductListener("error", (event) => {
        errorEvents.push(event);
      });

      await client.postEvent("screen_changed");

      expect(devWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('postEvent("screen_changed") dropped'),
      );
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorEvents).toEqual([]);
    });

    test("any other rejection is a warning plus an `error` listener event (phase socket)", async () => {
      const fake = createFakeNativeModule();
      fake.module.postEvent = async () => {
        throw new Error("socket write failed");
      };
      const client = createAppductClient(fake.module);
      const warnSpy = vi.spyOn(logger, "warn");
      const errorEvents: { phase: string; message: string }[] = [];
      client.addAppductListener("error", (event) => {
        errorEvents.push(event);
      });

      await client.postEvent("screen_changed");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('postEvent("screen_changed") failed to send'),
        expect.anything(),
      );
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        phase: "socket",
        message: 'Failed to send event "screen_changed".',
      });
    });
  });
});
