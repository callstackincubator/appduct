/**
 * Pure unit tests for `toAppEvent` (issue #112/#113): the one implementation `appduct/client` and
 * the built-in `appduct_events` MCP tool both call to narrow a daemon `EventNotification` to the
 * flat `AppEvent` shape a consumer wants — including the truncated shape a `payloadMaxBytes` cap
 * produces (`daemon/event-bus.ts`'s `projectAppEvent` decides full vs. truncated before this ever
 * runs; this only reads whichever shape it produced).
 */

import { describe, expect, test } from "vitest";

import { toAppEvent, type EventNotification } from "../domains/rpc.js";

const notification = (data: unknown, overrides: Partial<EventNotification> = {}): EventNotification => ({
  kind: "app_event",
  sessionId: "s1",
  ts: 1000,
  seq: 3,
  data,
  ...overrides,
});

describe("toAppEvent", () => {
  test("narrows a full (untruncated) app_event to { name, payload, ts, sessionId, seq }", () => {
    const event = toAppEvent(notification({ name: "greeting", payload: { hi: true } }), "s1");

    expect(event).toEqual({
      name: "greeting",
      payload: { hi: true },
      ts: 1000,
      sessionId: "s1",
      alias: undefined,
      seq: 3,
    });
  });

  test("narrows a truncated app_event to { name, payloadPreview, truncated: true, payloadBytes }, no payload", () => {
    const event = toAppEvent(
      notification({ name: "big", payloadPreview: '{"a":1', truncated: true, payloadBytes: 500 }),
      "s1",
    );

    expect(event).toEqual({
      name: "big",
      payloadPreview: '{"a":1',
      payloadBytes: 500,
      truncated: true,
      ts: 1000,
      sessionId: "s1",
      alias: undefined,
      seq: 3,
    });
    expect(event).not.toHaveProperty("payload");
  });

  test("returns undefined for a non-app_event kind, a different sessionId, or a missing name", () => {
    expect(toAppEvent(notification({ name: "x" }, { kind: "tools_changed" }), "s1")).toBeUndefined();
    expect(toAppEvent(notification({ name: "x" }, { sessionId: "s2" }), "s1")).toBeUndefined();
    expect(toAppEvent(notification({ payload: 1 }), "s1")).toBeUndefined();
  });
});
