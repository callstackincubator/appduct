import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod4";

import type { AppductCore } from "../index.js";
import { createAppductClient } from "../index.js";

const setDev = (value: boolean) => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = value;
};

const createFakeNativeModule = () => {
  const registerEventCalls: string[] = [];
  const unregisterEventCalls: string[] = [];
  const postEventCalls: { name: string; payloadJson: string | null }[] = [];
  const module = {
    registerEvent: (descriptorJson: string) => {
      registerEventCalls.push(descriptorJson);
    },
    unregisterEvent: (name: string) => {
      unregisterEventCalls.push(name);
    },
    postEvent: async (name: string, payloadJson: string | null) => {
      postEventCalls.push({ name, payloadJson });
    },
    registerTool: () => {},
    unregisterTool: () => {},
    handleUrl: () => false,
    connect: async () => {},
    restoreSession: async () => false,
    disconnect: async () => {},
    respondToToolCall: () => {},
    reportToolProgress: () => {},
    getState: () => "active",
    getSessionId: () => "s1",
    getRegisteredToolsJson: () => "[]",
    addListener: () => ({ remove: () => {} }),
  } satisfies AppductCore;
  return { module, registerEventCalls, unregisterEventCalls, postEventCalls };
};

const warnings = () => vi.spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => {
  vi.restoreAllMocks();
  setDev(true);
});

describe("registerEvent", () => {
  test("hands native the wire descriptor with the payload JSON Schema", () => {
    setDev(true);
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    client.registerEvent({
      name: "checkout_completed",
      description: "An order was paid.",
      payloadSchema: z.object({ orderId: z.string() }),
    });

    expect(fake.registerEventCalls).toHaveLength(1);
    const descriptor = JSON.parse(fake.registerEventCalls[0]!);
    expect(descriptor).toMatchObject({
      name: "checkout_completed",
      description: "An order was paid.",
      payload_schema: { type: "object", properties: { orderId: {} } },
    });
  });

  test("accepts a raw JSON Schema and omits payload_schema when none is given", () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    client.registerEvent({
      name: "cart.item_added",
      description: "An item joined the cart.",
      payloadSchema: { type: "object", properties: { sku: { type: "string" } } },
    });
    client.registerEvent({ name: "app_ready", description: "Startup finished." });

    expect(JSON.parse(fake.registerEventCalls[0]!).payload_schema).toEqual({
      type: "object",
      properties: { sku: { type: "string" } },
    });
    expect(JSON.parse(fake.registerEventCalls[1]!)).not.toHaveProperty(
      "payload_schema",
    );
  });

  test("the disposer withdraws the event from native, and a stale disposer does not", () => {
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    const first = client.registerEvent({ name: "e", description: "first" });
    const second = client.registerEvent({ name: "e", description: "second" });
    first.remove();
    expect(fake.unregisterEventCalls).toEqual([]);
    second.remove();
    expect(fake.unregisterEventCalls).toEqual(["e"]);
  });
});

describe("postEvent in development", () => {
  test("warns about an undeclared name, names it, and still posts", async () => {
    setDev(true);
    const warn = warnings();
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);

    await client.postEvent("screen_changed", { to: "cart" });

    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("screen_changed"),
    );
    expect(fake.postEventCalls).toEqual([
      { name: "screen_changed", payloadJson: '{"to":"cart"}' },
    ]);
  });

  test("does not warn about a declared name without a schema", async () => {
    setDev(true);
    const warn = warnings();
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);
    client.registerEvent({ name: "app_ready", description: "Startup done." });

    await client.postEvent("app_ready");

    expect(warn).not.toHaveBeenCalled();
  });

  test("warns when the payload fails the declared schema, and still posts", async () => {
    setDev(true);
    const warn = warnings();
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);
    client.registerEvent({
      name: "checkout_completed",
      description: "An order was paid.",
      payloadSchema: z.object({ orderId: z.string() }),
    });

    await client.postEvent("checkout_completed", { orderId: 42 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toContain("checkout_completed");
    expect(fake.postEventCalls).toEqual([
      { name: "checkout_completed", payloadJson: '{"orderId":42}' },
    ]);
  });

  test("stays quiet for a payload that matches the declared schema", async () => {
    setDev(true);
    const warn = warnings();
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);
    client.registerEvent({
      name: "checkout_completed",
      description: "An order was paid.",
      payloadSchema: z.object({ orderId: z.string() }),
    });

    await client.postEvent("checkout_completed", { orderId: "o-1" });

    expect(warn).not.toHaveBeenCalled();
  });

  test("a raw JSON Schema is listed but never checked against the payload", async () => {
    setDev(true);
    const warn = warnings();
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);
    client.registerEvent({
      name: "e",
      description: "d",
      payloadSchema: { type: "object", properties: { a: { type: "string" } } },
    });

    await client.postEvent("e", { a: 1 });

    expect(warn).not.toHaveBeenCalled();
  });

  test("warns again for a name whose declaration was withdrawn", async () => {
    setDev(true);
    const warn = warnings();
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);
    const registration = client.registerEvent({ name: "e", description: "d" });
    registration.remove();

    await client.postEvent("e");

    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('"e"'),
    );
  });
});

describe("postEvent in production", () => {
  test("posts as-is with no warnings, declared or not", async () => {
    setDev(false);
    const warn = warnings();
    const fake = createFakeNativeModule();
    const client = createAppductClient(fake.module);
    client.registerEvent({
      name: "checkout_completed",
      description: "An order was paid.",
      payloadSchema: z.object({ orderId: z.string() }),
    });

    await client.postEvent("checkout_completed", { orderId: 42 });
    await client.postEvent("undeclared", { x: 1 });

    expect(warn).not.toHaveBeenCalled();
    expect(fake.postEventCalls.map((call) => call.payloadJson)).toEqual([
      '{"orderId":42}',
      '{"x":1}',
    ]);
  });
});
