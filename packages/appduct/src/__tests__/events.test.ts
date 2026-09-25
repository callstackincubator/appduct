/**
 * Unit tests for `events/index.ts`'s `waitForAppEvent` (issue #114): the module through its
 * public API only, against a fake `DaemonStream` — no real daemon, no socket.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { RPC_METHODS, type EventNotification, type EventsSinceResult } from "@appduct/shared";

import {
  waitForAppEvent,
  WaitForAppEventConnectionClosedError,
  WaitForAppEventTimeoutError,
} from "../events/index.js";
import type { DaemonStream } from "../rpc/client.js";

type FakeStream = DaemonStream & {
  calls: Array<{ method: string; params: unknown }>;
  notify: (payload: unknown) => void;
  triggerClose: () => void;
};

const makeFakeStream = (respond: (method: string, params: unknown) => unknown): FakeStream => {
  const notificationListeners = new Set<(payload: unknown) => void>();
  const closeListeners = new Set<() => void>();
  const calls: Array<{ method: string; params: unknown }> = [];

  const stream: FakeStream = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return respond(method, params) as T;
    },
    onNotification: (callback) => {
      notificationListeners.add(callback);
      return () => notificationListeners.delete(callback);
    },
    onClose: (callback) => {
      closeListeners.add(callback);
      return () => closeListeners.delete(callback);
    },
    close: () => {},
    calls,
    notify: (payload) => {
      for (const callback of notificationListeners) {
        callback(payload);
      }
    },
    triggerClose: () => {
      for (const callback of closeListeners) {
        callback();
      }
    },
  };

  return stream;
};

const appEventNotification = (seq: number, name: string, payload: unknown, sessionId = "s1"): EventNotification => ({
  kind: "app_event",
  sessionId,
  alias: "a1",
  ts: 1_000,
  seq,
  data: { name, payload },
});

const emptySince = (): EventsSinceResult => ({ events: [], cursor: 0, dropped: 0, remaining: 0 });

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForAppEvent", () => {
  test("forwards name, since and payloadMaxBytes to both events.subscribe and events.since", async () => {
    const stream = makeFakeStream((method) => {
      if (method === RPC_METHODS.eventsSubscribe) {
        return { ok: true };
      }

      if (method === RPC_METHODS.eventsSince) {
        return { events: [appEventNotification(6, "cart.item_added", { id: 1 })], cursor: 6, dropped: 0, remaining: 0 };
      }

      throw new Error(`unexpected method ${method}`);
    });

    const result = await waitForAppEvent(stream, {
      sessionId: "s1",
      name: "cart.*",
      since: 5,
      timeoutMs: 1000,
      payloadMaxBytes: 128,
    });

    expect(stream.calls.find((call) => call.method === RPC_METHODS.eventsSubscribe)?.params).toMatchObject({
      sessionSelector: "s1",
      kinds: ["app_event"],
      name: "cart.*",
      payloadMaxBytes: 128,
    });
    expect(stream.calls.find((call) => call.method === RPC_METHODS.eventsSince)?.params).toMatchObject({
      selector: "s1",
      since: 5,
      name: "cart.*",
      payloadMaxBytes: 128,
    });
    expect(result.event).toMatchObject({ name: "cart.item_added", payload: { id: 1 } });
  });

  test("resolves from the drained backlog when a match is already retained, reporting events.since's dropped", async () => {
    const stream = makeFakeStream((method) => {
      if (method === RPC_METHODS.eventsSubscribe) {
        return { ok: true };
      }

      if (method === RPC_METHODS.eventsSince) {
        return { events: [appEventNotification(3, "ping", { n: 1 })], cursor: 3, dropped: 2, remaining: 0 };
      }

      throw new Error("unexpected method");
    });

    const result = await waitForAppEvent(stream, { sessionId: "s1", name: "ping", timeoutMs: 1000 });

    expect(result.event).toMatchObject({ name: "ping", payload: { n: 1 } });
    expect(result.dropped).toBe(2);
  });

  test("resolves once a live-only matching event arrives after an empty drain", async () => {
    const stream = makeFakeStream((method) => {
      if (method === RPC_METHODS.eventsSubscribe) {
        return { ok: true };
      }

      if (method === RPC_METHODS.eventsSince) {
        return emptySince();
      }

      throw new Error("unexpected method");
    });

    const waiting = waitForAppEvent(stream, { sessionId: "s1", name: "ping", timeoutMs: 1000 });

    // Let the drain complete and the module switch over to its live handler before the event
    // arrives, so this exercises the live half rather than the backlog merge.
    await new Promise((resolve) => setImmediate(resolve));
    stream.notify(appEventNotification(1, "ping", { n: 1 }));

    const result = await waiting;
    expect(result.event).toMatchObject({ name: "ping", payload: { n: 1 } });
    expect(result.dropped).toBe(0);
  });

  test("an event that arrives in the gap between events.subscribe resolving and events.since being sent still resolves the wait", async () => {
    let stream!: FakeStream;

    stream = makeFakeStream((method) => {
      if (method === RPC_METHODS.eventsSubscribe) {
        // Simulates a notification landing in the same socket chunk as this response — i.e.
        // before `events.since` is even sent, not merely before it resolves.
        stream.notify(appEventNotification(1, "ping", { n: 1 }));
        return { ok: true };
      }

      if (method === RPC_METHODS.eventsSince) {
        return emptySince();
      }

      throw new Error("unexpected method");
    });

    const result = await waitForAppEvent(stream, { sessionId: "s1", name: "ping", timeoutMs: 1000 });
    expect(result.event).toMatchObject({ name: "ping", payload: { n: 1 } });
  });

  test("rejects with WaitForAppEventTimeoutError after timeoutMs when nothing matches", async () => {
    vi.useFakeTimers();

    const stream = makeFakeStream((method) => {
      if (method === RPC_METHODS.eventsSubscribe) {
        return { ok: true };
      }

      if (method === RPC_METHODS.eventsSince) {
        return emptySince();
      }

      throw new Error("unexpected method");
    });

    const waiting = waitForAppEvent(stream, { sessionId: "s1", name: "never-arrives", timeoutMs: 1000 });
    const assertion = expect(waiting).rejects.toBeInstanceOf(WaitForAppEventTimeoutError);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  test("rejects with WaitForAppEventConnectionClosedError when the stream closes during a live wait", async () => {
    const stream = makeFakeStream((method) => {
      if (method === RPC_METHODS.eventsSubscribe) {
        return { ok: true };
      }

      if (method === RPC_METHODS.eventsSince) {
        return emptySince();
      }

      throw new Error("unexpected method");
    });

    const waiting = waitForAppEvent(stream, { sessionId: "s1", name: "ping", timeoutMs: 5000 });
    await new Promise((resolve) => setImmediate(resolve));
    stream.triggerClose();

    await expect(waiting).rejects.toBeInstanceOf(WaitForAppEventConnectionClosedError);
  });
});
