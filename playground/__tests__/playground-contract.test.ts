import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAppduct, type AppductCore } from "@appduct/shared/sdk";

import * as expo from "../playground-tools";
import * as web from "../../playground-web/src/playground-tools";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/** The wire descriptors every playground must announce (docs/internal/playground-contract.md). */
const CONTRACT_TOOLS = [
  {
    name: "sum",
    description: "Adds two numbers. Counts as a call in call_count.",
    group: undefined,
    annotations: undefined,
    timeout_ms: undefined,
  },
  {
    name: "call_count",
    description: "Reports how many times the counted tools (sum, slow_task) have run. Read-only.",
    group: "counter",
    annotations: { readOnlyHint: true },
    timeout_ms: undefined,
  },
  {
    name: "reset_counter",
    description: "Resets the call counter to zero. Destructive; a no-op when it is already zero.",
    group: "counter",
    annotations: { destructiveHint: true, idempotentHint: true },
    timeout_ms: undefined,
  },
  {
    name: "slow_task",
    description:
      "Takes about 1.5 s and reports progress along the way. Counts as a call in call_count.",
    group: "diagnostics/progress",
    annotations: undefined,
    timeout_ms: 5000,
  },
  {
    name: "throwing_tool",
    description: "Always fails with tool_execution_error. Changes nothing.",
    group: "diagnostics",
    annotations: { readOnlyHint: true },
    timeout_ms: undefined,
  },
];

type Playground = {
  playgroundTools: typeof expo.playgroundTools;
  playgroundPingEvent: typeof expo.playgroundPingEvent;
};

/** A client over a recording core, the way a native module would drive it. */
function connectedClient() {
  const tools: Record<string, any> = {};
  const events: Record<string, any> = {};
  const responses: { id: string; result: unknown; error: any }[] = [];
  const progress: { id: string; progress: number | null; message: string | null }[] = [];
  const listeners: Record<string, (event: any) => void> = {};
  const core = {
    registerTool: (json: string) => {
      const descriptor = JSON.parse(json);
      tools[descriptor.name] = descriptor;
    },
    unregisterTool: () => {},
    registerEvent: (json: string) => {
      const descriptor = JSON.parse(json);
      events[descriptor.name] = descriptor;
    },
    unregisterEvent: () => {},
    handleUrl: () => false,
    connect: async () => {},
    restoreSession: async () => false,
    disconnect: async () => {},
    postEvent: async () => {},
    respondToToolCall: (id: string, resultJson: string | null, errorJson: string | null) => {
      responses.push({
        id,
        result: resultJson === null ? undefined : JSON.parse(resultJson),
        error: errorJson === null ? undefined : JSON.parse(errorJson),
      });
    },
    reportToolProgress: (id: string, p: number | null, message: string | null) => {
      progress.push({ id, progress: p, message });
    },
    getState: () => "idle",
    getSessionId: () => "session-1",
    getRegisteredToolsJson: () => "[]",
    addListener: (name: string, listener: (event: any) => void) => {
      listeners[name] = listener;
      return { remove() {} };
    },
  } as unknown as AppductCore;
  const { client } = createAppduct(core);
  let next = 0;
  const call = async (name: string, args: unknown = {}) => {
    const id = `call-${next++}`;
    listeners.toolCall!({ id, name, argsJson: JSON.stringify(args) });
    return id;
  };
  const lastResponse = () => responses[responses.length - 1];
  return { client, tools, events, responses, progress, call, lastResponse };
}

describe.each([
  ["Expo", expo],
  ["web", web],
] as [string, Playground][])("the %s playground", (_name, playground) => {
  function setup() {
    const harness = connectedClient();
    let count = 0;
    const counter = { read: () => count, bump: () => void (count += 1), reset: () => void (count = 0) };
    const tools = playground.playgroundTools(counter);
    for (const registration of Object.values(tools)) {
      harness.client.registerTool(registration as never);
    }
    harness.client.registerEvent(playground.playgroundPingEvent as never);
    return { ...harness, counter };
  }

  test("announces the five tools with the contract's names, groups, annotations and descriptions", () => {
    const { tools } = setup();
    expect(Object.keys(tools)).toEqual(CONTRACT_TOOLS.map((tool) => tool.name));
    for (const expected of CONTRACT_TOOLS) {
      const announced = tools[expected.name];
      expect({
        name: announced.name,
        description: announced.description,
        group: announced.group,
        annotations: announced.annotations,
        timeout_ms: announced.timeout_ms,
      }).toEqual(expected);
    }
  });

  test("declares playground_ping with the Status screen description and a required at", () => {
    const { events } = setup();
    expect(events.playground_ping.description).toBe(
      "The Send playground_ping button on the Status screen was pressed.",
    );
    expect(events.playground_ping.payload_schema.required).toEqual(["at"]);
    expect(events.playground_ping.payload_schema.properties.at.type).toBe("number");
  });

  test("sum requires both inputs", () => {
    const { tools } = setup();
    expect(tools.sum.input_schema.required).toEqual(["a", "b"]);
    expect(tools.sum.input_schema.properties.a.type).toBe("number");
    expect(tools.sum.input_schema.properties.b.type).toBe("number");
  });

  test("sum adds as numbers and counts as a call", async () => {
    const { call, lastResponse, counter } = setup();
    await call("sum", { a: 1.5, b: 2 });
    await vi.waitFor(() => expect(lastResponse()?.result).toEqual({ total: 3.5 }));
    expect(counter.read()).toBe(1);
  });

  test("call_count reports the count and reset_counter zeroes it", async () => {
    const { call, lastResponse, counter } = setup();
    counter.bump();
    counter.bump();
    await call("call_count");
    await vi.waitFor(() => expect(lastResponse()?.result).toEqual({ count: 2 }));
    await call("reset_counter");
    await vi.waitFor(() => expect(lastResponse()?.result).toEqual({ count: 0 }));
    expect(counter.read()).toBe(0);
  });

  test("throwing_tool fails with tool_execution_error and the exact message", async () => {
    const { call, lastResponse } = setup();
    await call("throwing_tool");
    await vi.waitFor(() => expect(lastResponse()?.error).toBeDefined());
    expect(lastResponse()!.error.type).toBe("tool_execution_error");
    expect(lastResponse()!.error.message).toBe("throwing_tool always fails on purpose.");
  });

  describe("slow_task", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test("reports three progress steps 500 ms apart, then counts as a call", async () => {
      const { call, progress, lastResponse, counter } = setup();
      await call("slow_task");
      await vi.advanceTimersByTimeAsync(499);
      expect(progress).toEqual([]);
      await vi.advanceTimersByTimeAsync(1100);
      expect(progress.map((p) => [p.progress, p.message])).toEqual([
        [0.33, "warming up"],
        [0.66, "almost there"],
        [1, "done"],
      ]);
      expect(lastResponse()?.result).toEqual({ done: true });
      expect(counter.read()).toBe(1);
    });
  });
});
