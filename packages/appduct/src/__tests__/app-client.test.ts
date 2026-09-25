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
    const client = makeAppClient(streamAnswering({ tools: [listed], total: 1 }), "s1");
    expect(await client.tools()).toEqual([listed]);
  });

  test("still accepts a bare array from a daemon that predates `{ tools, total }`", async () => {
    const client = makeAppClient(streamAnswering([toolEntry]), "s1");
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
    const client = makeAppClient(stream, "s1");

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
    const client = makeAppClient(stream, "s1");

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
    const client = makeAppClient(stream, "s1");

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
    const client = makeAppClient(stream, "s1");

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
