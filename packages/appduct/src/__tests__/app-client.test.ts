import { describe, expect, test } from "vitest";

import { RPC_METHODS } from "@appduct/shared";

import { makeAppClient } from "../client/app-client.js";
import type { DaemonStream } from "../rpc/client.js";

const toolEntry = {
  name: "ping",
  description: "Ping.",
  input_schema: { type: "object" },
  policy: "allow",
};

const streamAnswering = (result: unknown): DaemonStream => {
  return {
    call: async <T>() => result as T,
    onNotification: () => () => {},
    onClose: () => () => {},
    close: () => {},
  };
};

describe("AppClient.tools()", () => {
  test("unwraps the `{ tools, total }` tools.list result", async () => {
    const listed = { ...toolEntry, group: "diagnostics" };
    const client = makeAppClient(streamAnswering({ tools: [listed], total: 1 }), "s1", async () => streamAnswering({}));
    expect(await client.tools()).toEqual([listed]);
  });

  test("still accepts a bare array from a daemon that predates `{ tools, total }`", async () => {
    const client = makeAppClient(streamAnswering([toolEntry]), "s1", async () => streamAnswering({}));
    // That daemon predates tool groups too and sends no `group` key. Every entry carries one, so
    // `tool.group === null` answers "ungrouped" here as it does anywhere else.
    expect(await client.tools()).toEqual([{ ...toolEntry, group: null }]);
  });
});

describe("AppClient.events()", () => {
  /** Captures the last `events.since` call's params, alongside answering with `raw`. */
  const streamRecordingEventsSince = (raw: unknown): { stream: DaemonStream; lastParams: () => unknown } => {
    let lastParams: unknown;

    const stream: DaemonStream = {
      call: async <T>(method: string, params?: unknown) => {
        if (method === RPC_METHODS.eventsSince) {
          lastParams = params;
        }

        return raw as T;
      },
      onNotification: () => () => {},
      onClose: () => () => {},
      close: () => {},
    };

    return { stream, lastParams: () => lastParams };
  };

  test("without payloadMaxBytes, does not send it to events.since and returns FullAppEvent (payload readable unnarrowed)", async () => {
    const { stream, lastParams } = streamRecordingEventsSince({
      events: [{ kind: "app_event", sessionId: "s1", ts: 1, seq: 1, data: { name: "greeting", payload: { hi: true } } }],
      cursor: 1,
      dropped: 0,
      remaining: 0,
    });
    const client = makeAppClient(stream, "s1", async () => stream);

    const result = await client.events();

    expect(lastParams()).toMatchObject({ payloadMaxBytes: undefined });
    expect(result.dropped).toBe(0);
    expect(result.remaining).toBe(0);
    const event = result.events[0]!;
    // No narrowing needed: `FullAppEvent.payload` is unconditional.
    expect(event.payload).toEqual({ hi: true });
  });

  test("with payloadMaxBytes, forwards it to events.since and surfaces dropped/remaining", async () => {
    const { stream, lastParams } = streamRecordingEventsSince({
      events: [
        { kind: "app_event", sessionId: "s1", ts: 1, seq: 5, data: { name: "big", payloadPreview: "{\"a", truncated: true, payloadBytes: 500 } },
      ],
      cursor: 5,
      dropped: 3,
      remaining: 7,
    });
    const client = makeAppClient(stream, "s1", async () => stream);

    const result = await client.events({ payloadMaxBytes: 10 });

    expect(lastParams()).toMatchObject({ payloadMaxBytes: 10 });
    expect(result.dropped).toBe(3);
    expect(result.remaining).toBe(7);
    const event = result.events[0]!;
    expect(event.truncated).toBe(true);

    // A caller that DID pass `payloadMaxBytes` must narrow on `truncated` before reading
    // `payload` — the union no longer guarantees it (issue #113's overload decision).
    // @ts-expect-error -- `payload` is not on `TruncatedAppEvent`; only readable after narrowing.
    expect(event.payload).toBeUndefined();

    if (!event.truncated) {
      // Reachable at runtime only for a non-truncated event; here purely to prove this branch
      // type-checks (`event.payload` compiles once narrowed).
      expect(event.payload).toBeDefined();
    } else {
      expect(event.payloadPreview).toBe("{\"a");
      expect(event.payloadBytes).toBe(500);
    }
  });

  test("a payloadMaxBytes passed through an object-literal-typed variable still requires narrowing (issue #113)", async () => {
    const { stream } = streamRecordingEventsSince({
      events: [{ kind: "app_event", sessionId: "s1", ts: 1, seq: 5, data: { name: "big", payloadPreview: "{\"a", truncated: true, payloadBytes: 500 } }],
      cursor: 5,
      dropped: 3,
      remaining: 7,
    });
    const client = makeAppClient(stream, "s1", async () => stream);

    // Excess-property checks only apply to object literals passed directly as an argument, so a
    // capped options bag routed through a variable must still resolve to the capped overload —
    // never to `FullEventsResult`, whose `payload` reads are unnarrowed.
    const opts = { since: 0, payloadMaxBytes: 64 };
    const result = await client.events(opts);
    const event = result.events[0]!;

    // @ts-expect-error -- `payload` is not on `TruncatedAppEvent`; only readable after narrowing.
    expect(event.payload).toBeUndefined();
    if (event.truncated) {
      expect(event.payloadPreview).toBe("{\"a");
    }
  });

  test("an explicitly-typed payloadMaxBytes options object still requires narrowing (issue #113)", async () => {
    const { stream } = streamRecordingEventsSince({
      events: [{ kind: "app_event", sessionId: "s1", ts: 1, seq: 5, data: { name: "big", payloadPreview: "{\"a", truncated: true, payloadBytes: 500 } }],
      cursor: 5,
      dropped: 3,
      remaining: 7,
    });
    const client = makeAppClient(stream, "s1", async () => stream);

    const opts: { since?: number; payloadMaxBytes?: number } = { since: 0, payloadMaxBytes: 64 };
    const result = await client.events(opts);
    const event = result.events[0]!;

    // @ts-expect-error -- `payload` is not on `TruncatedAppEvent`; only readable after narrowing.
    expect(event.payload).toBeUndefined();
    if (event.truncated) {
      expect(event.payloadPreview).toBe("{\"a");
    }
  });
});

describe("AppClient.waitForEvent()", () => {
  /** A `DaemonStream` fake that also records every `call()` and whether `close()` ran, for
   * asserting `waitForEvent` opens and closes its own stream (issue #114). */
  const makeFakeWaitStream = (
    respond: (method: string, params: unknown) => unknown,
  ): DaemonStream & { calls: Array<{ method: string; params: unknown }>; closed: () => boolean } => {
    let closed = false;
    const calls: Array<{ method: string; params: unknown }> = [];

    return {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        return respond(method, params) as T;
      },
      onNotification: () => () => {},
      onClose: () => () => {},
      close: () => {
        closed = true;
      },
      calls,
      closed: () => closed,
    };
  };

  const answerWithEvent = (method: string, params: unknown): unknown => {
    if (method === RPC_METHODS.eventsSubscribe) {
      return { ok: true };
    }

    if (method === RPC_METHODS.eventsSince) {
      return {
        events: [{ kind: "app_event", sessionId: "s1", ts: 1, seq: 1, data: { name: "ping", payload: { n: 1 } } }],
        cursor: 1,
        dropped: 0,
        remaining: 0,
      };
    }

    throw new Error(`unexpected method ${method} (${JSON.stringify(params)})`);
  };

  test("opens its own stream for the wait, closes it once settled, and leaves the shared stream open", async () => {
    let sharedClosed = false;
    const sharedStream = streamAnswering({});
    sharedStream.close = () => {
      sharedClosed = true;
    };

    const waitStream = makeFakeWaitStream(answerWithEvent);
    let openCount = 0;
    const client = makeAppClient(sharedStream, "s1", async () => {
      openCount++;
      return waitStream;
    });

    const event = await client.waitForEvent("ping");

    expect(openCount).toBe(1);
    expect(event).toMatchObject({ name: "ping", payload: { n: 1 } });
    expect(waitStream.closed()).toBe(true);
    expect(sharedClosed).toBe(false);
  });

  test("never sends payloadMaxBytes to events.subscribe or events.since (issue #114: no payloadMaxBytes overload here)", async () => {
    const waitStream = makeFakeWaitStream(answerWithEvent);
    const client = makeAppClient(streamAnswering({}), "s1", async () => waitStream);

    await client.waitForEvent("ping");

    expect(waitStream.calls.find((call) => call.method === RPC_METHODS.eventsSubscribe)?.params).toMatchObject({
      payloadMaxBytes: undefined,
    });
    expect(waitStream.calls.find((call) => call.method === RPC_METHODS.eventsSince)?.params).toMatchObject({
      payloadMaxBytes: undefined,
    });
  });

  test("WaitForEventOptions has no match (issue #114): passing one is a type error", async () => {
    const waitStream = makeFakeWaitStream(answerWithEvent);
    const client = makeAppClient(streamAnswering({}), "s1", async () => waitStream);

    // @ts-expect-error -- `match` was removed from `WaitForEventOptions`; a payload predicate is
    // no longer offered on any surface (loop on `waitForEvent` with `since` instead).
    await client.waitForEvent("ping", { match: () => true });
  });
});
