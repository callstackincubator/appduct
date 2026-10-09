import { createAppduct, jsonSchema } from "@appduct/shared/sdk";
import { describe, expect, it } from "vitest";

import { SESSION_ID, ack, connectInput, settle, setup } from "./harness.js";

/** The web core under the real SDK layer from `@appduct/shared/sdk`, with only the ports faked. */
describe("createAppduct over the web core", () => {
  it("claims a session, syncs a tool and answers a call from the daemon", async () => {
    const h = setup();
    const { client } = createAppduct(h.core);

    client.registerTool({
      name: "sum",
      description: "Add two numbers.",
      inputSchema: jsonSchema<{ a: number; b: number }>({
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      }),
      outputSchema: jsonSchema<{ total: number }>({ type: "object", properties: { total: { type: "number" } } }),
      handler: ({ a, b }) => ({ total: a + b }),
    });

    const connecting = client.connect(connectInput() as never);
    h.last().open();
    h.last().receive(ack());
    await connecting;
    expect(client.getClientState()).toBe("active");

    const snapshot = h.last().frames().find((frame) => frame.type === "tool_registry_snapshot");
    expect(snapshot).toMatchObject({ tools: [{ name: "sum", description: "Add two numbers." }] });

    h.last().receive({ type: "tool_call", session_id: SESSION_ID, id: "call_1", name: "sum", args: { a: 2, b: 3 } });
    await settle();

    expect(h.last().frames().filter((frame) => frame.type === "tool_result")).toEqual([
      { type: "tool_result", session_id: SESSION_ID, id: "call_1", result: { total: 5 } },
    ]);
  });

  it("surfaces a refused claim as a rejected connect", async () => {
    const h = setup();
    const { client } = createAppduct(h.core);
    const connecting = client.connect(connectInput() as never);
    const rejected = expect(connecting).rejects.toThrow("invalid_token");
    h.last().open();
    h.last().closeFromDaemon(1008, "invalid_token");
    await rejected;
  });
});
