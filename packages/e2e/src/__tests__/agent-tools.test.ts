import { describe, expect, it } from "vitest";

import { appductTools, offerToAgent } from "../agent-tools.js";
import type { Appduct } from "../session.js";

const session = (calls: unknown[]): Appduct => ({
  call: async (name, args) => {
    calls.push([name, args]);
    return { total: 3 };
  },
  tools: async () => [],
  waitForEvent: async () => {
    throw new Error("unused");
  },
});

const run = (name: "appduct_call" | "appduct_tools", input: unknown) =>
  appductTools()[name].tool.execute!(input as never, { toolCallId: "1", messages: [], context: {} });

describe("appductTools", () => {
  it("calls the app's tool in the running test's session", async () => {
    const calls: unknown[] = [];
    const withdraw = offerToAgent(session(calls));

    expect(await run("appduct_call", { name: "sum", args: { a: 1, b: 2 } })).toEqual({ total: 3 });
    expect(calls).toEqual([["sum", { a: 1, b: 2 }]]);
    withdraw();
  });

  it("refuses once the test has ended", async () => {
    offerToAgent(session([]))();

    await expect(run("appduct_tools", {})).rejects.toThrow("No Appduct session");
  });

  it("marks calling a tool as changing app state and listing them as not", () => {
    expect(appductTools().appduct_call.annotations.mutates).toBe(true);
    expect(appductTools().appduct_tools.annotations.mutates).toBe(false);
  });
});
