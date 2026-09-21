/**
 * The MCP server's own behaviour (ARCHITECTURE.md §9), against an in-memory daemon
 * (`mcp-daemon-fake.ts`) rather than a real one: the fixed `tools/list`, and the
 * `appduct_list_tools` / `appduct_describe_tool` / `appduct_call_tool` built-ins an agent reaches
 * the app's tools through.
 *
 * None of that depends on the transport underneath. The server is driven by the SDK's own `Client`
 * over `InMemoryTransport`, so what the client sees is what a real client would see; only the
 * daemon behind it is a fake.
 *
 * `mcp-server.integration.test.ts` keeps everything that genuinely needs the real thing: a
 * declared deadline surviving the round trip, progress correlation over the second daemon stream,
 * cancellation, the `appduct_connect` delivery paths, the resource, stdout purity, and version
 * drift.
 */

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { RPC_METHODS } from "@appduct/shared";

import { createMcpServer, type McpServerHandle } from "../mcp/server.js";
import { createFakeDaemon, toolError, type FakeDaemon } from "./mcp-daemon-fake.js";

const mcpHandles: McpServerHandle[] = [];

afterEach(async () => {
  while (mcpHandles.length > 0) {
    await mcpHandles.pop()?.close();
  }
});

const BUILTIN_TOOL_NAMES = [
  "appduct_call_tool",
  "appduct_connect",
  "appduct_describe_tool",
  "appduct_events",
  "appduct_list_tools",
  "appduct_wait_for_event",
  "appduct_wait_for_session",
];

/** Starts an MCP server over `daemon` and connects an SDK `Client` to it in-process. `stateDir` is
 * never touched: nothing here reaches the filesystem, because `openStream` is the only path the
 * server has to a daemon and it is the fake's. */
const startServerWithClient = async (daemon: FakeDaemon): Promise<Client> => {
  const handle = await createMcpServer({
    stateDir: "/nonexistent-state-dir",
    openStream: daemon.openStream,
    scheme: "appduct",
    env: {},
  });
  mcpHandles.push(handle);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
};

const callBuiltin = async (client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
  return client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);
};

const errorText = (result: CallToolResult): string => {
  expect(result.isError).toBe(true);
  return (result.content[0] as { text: string }).text;
};

describe("mcp: tools/list", () => {
  test("lists exactly the fixed built-ins, never the app's own tools", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([{ name: "echo" }, { name: "seed_cart" }]);

    const client = await startServerWithClient(daemon);
    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(BUILTIN_TOOL_NAMES);
  });

  test("the built-in tool shapes match the locked snapshot", async () => {
    const daemon = createFakeDaemon();
    const client = await startServerWithClient(daemon);

    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    // Schemas only, sorted: free-text descriptions would make this snapshot brittle against
    // unrelated wording tweaks.
    const shapes = listed.tools
      .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(shapes).toMatchSnapshot();
  });

  test("never fires list_changed or advertises it: sessions and registries changing leave tools/list alone", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([{ name: "echo" }]);

    const client = await startServerWithClient(daemon);
    expect(client.getServerCapabilities()?.tools?.listChanged).not.toBe(true);

    let listChangedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChangedCount += 1;
    });

    daemon.addSession({ alias: "iphone-15" }).setTools([{ name: "echo" }]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(listChangedCount).toBe(0);
  });

  test("calling an app tool directly by name points the agent at the built-ins", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([{ name: "echo" }]);

    const client = await startServerWithClient(daemon);
    const text = errorText(await callBuiltin(client, "echo", {}));

    expect(text).toContain("tool_not_found");
    expect(text).toContain("appduct_list_tools");
    expect(text).toContain("appduct_call_tool");
  });
});

describe("mcp: appduct_list_tools", () => {
  test("returns one signature, summary and policy per tool, sorted by name, for the sole session", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([
      {
        name: "seed_cart",
        description: "Seeds the cart.\nLonger explanation that stays out of the listing.",
        input_schema: {
          type: "object",
          properties: { items: { type: "integer" }, sku: { type: "string" } },
          required: ["items"],
        },
        output_schema: { type: "object", properties: { added: { type: "integer" } }, required: ["added"] },
        annotations: { destructiveHint: true },
        policy: "prompt",
      },
      { name: "echo", description: "Echoes its input." },
    ]);

    const client = await startServerWithClient(daemon);
    const result = await callBuiltin(client, "appduct_list_tools", {});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      session: "pixel-8",
      total: 2,
      tools: [
        { name: "echo", signature: "echo()", summary: "Echoes its input.", policy: "allow" },
        {
          name: "seed_cart",
          signature: "seed_cart(items: int, sku?: string) -> { added: int }",
          summary: "Seeds the cart.",
          policy: "prompt",
          annotations: { destructiveHint: true },
        },
      ],
    });
  });

  test("forwards filter/limit/offset to the daemon, echoes them, and reports total before paging", async () => {
    const daemon = createFakeDaemon();
    daemon
      .addSession({ alias: "pixel-8" })
      .setTools([{ name: "cart_add" }, { name: "cart_clear" }, { name: "cart_remove" }, { name: "login" }]);

    const client = await startServerWithClient(daemon);
    const result = await callBuiltin(client, "appduct_list_tools", { filter: "CART", limit: 1, offset: 1 });

    expect(result.structuredContent).toMatchObject({
      session: "pixel-8",
      total: 3,
      filter: "CART",
      limit: 1,
      offset: 1,
      tools: [{ name: "cart_clear" }],
    });
    expect(daemon.calls().filter((call) => call.method === RPC_METHODS.toolsList).at(-1)?.params).toEqual({
      selector: "pixel-8",
      filter: "CART",
      limit: 1,
      offset: 1,
    });
  });

  test("with several sessions, needs a selector, which may be an alias or a session id", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([{ name: "android_only" }]);
    daemon.addSession({ alias: "iphone-15", sessionId: "session-ios" }).setTools([{ name: "ios_only" }]);

    const client = await startServerWithClient(daemon);

    const ambiguous = errorText(await callBuiltin(client, "appduct_list_tools", {}));
    expect(ambiguous).toContain("ambiguous_session");
    expect(ambiguous).toContain("pixel-8");
    expect(ambiguous).toContain("iphone-15");

    const byAlias = await callBuiltin(client, "appduct_list_tools", { selector: "pixel-8" });
    expect(byAlias.structuredContent).toMatchObject({ session: "pixel-8", tools: [{ name: "android_only" }] });

    // A session id resolves to the same session, and the result still names it by alias.
    const byId = await callBuiltin(client, "appduct_list_tools", { selector: "session-ios" });
    expect(byId.structuredContent).toMatchObject({ session: "iphone-15", tools: [{ name: "ios_only" }] });
  });

  test("with no session at all, says so", async () => {
    const client = await startServerWithClient(createFakeDaemon());
    expect(errorText(await callBuiltin(client, "appduct_list_tools", {}))).toContain("no_session");
  });

  test("an empty selector is an invalid request", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" });

    const client = await startServerWithClient(daemon);
    expect(errorText(await callBuiltin(client, "appduct_list_tools", { selector: "" }))).toContain("invalid_request");
  });
});

describe("mcp: appduct_describe_tool", () => {
  test("returns the whole descriptor, its signature and policy, with every schema exactly as registered", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([
      {
        name: "list_todos",
        description: "Returns the todos.",
        // Not object-rooted: MCP's own `Tool.outputSchema` could never carry this, but as data it
        // reaches the agent intact.
        output_schema: { type: "array", items: { type: "string" } },
        annotations: { readOnlyHint: true },
        timeout_ms: 30_000,
      },
    ]);

    const client = await startServerWithClient(daemon);
    const result = await callBuiltin(client, "appduct_describe_tool", { name: "list_todos" });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      session: "pixel-8",
      signature: "list_todos() -> string[]",
      policy: "allow",
      name: "list_todos",
      description: "Returns the todos.",
      output_schema: { type: "array", items: { type: "string" } },
      annotations: { readOnlyHint: true },
      timeout_ms: 30_000,
    });
  });

  test("an unknown tool is tool_not_found and points at appduct_list_tools", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([{ name: "echo" }]);

    const client = await startServerWithClient(daemon);
    const text = errorText(await callBuiltin(client, "appduct_describe_tool", { name: "ech" }));

    expect(text).toContain("tool_not_found");
    expect(text).toContain("pixel-8");
    expect(text).toContain("appduct_list_tools");
  });

  test("a missing name is an invalid request", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" });

    const client = await startServerWithClient(daemon);
    expect(errorText(await callBuiltin(client, "appduct_describe_tool", {}))).toContain("invalid_request");
  });
});

describe("mcp: appduct_call_tool", () => {
  test("round-trips args and returns an object result as structuredContent", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([{ name: "echo", input_schema: { type: "object", properties: { text: { type: "string" } } } }]);
    app.onCall("echo", (args) => ({ echoed: args.text }));

    const client = await startServerWithClient(daemon);
    const result = await callBuiltin(client, "appduct_call_tool", { name: "echo", args: { text: "hello" } });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ echoed: "hello" });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ echoed: "hello" }) }]);
  });

  test("a non-object result travels as JSON text, whatever the tool's output schema declares", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([
      { name: "list_todos", output_schema: { type: "array", items: { type: "string" } } },
      // No longer an MCP-level contract violation: the call tool declares no output schema, so a
      // client has nothing to enforce, and the app's own validation is the only check.
      { name: "claims_object", output_schema: { type: "object" } },
    ]);
    app.onCall("list_todos", () => ["write tests", "ship it"]);
    app.onCall("claims_object", () => 42);

    const client = await startServerWithClient(daemon);

    const todos = await callBuiltin(client, "appduct_call_tool", { name: "list_todos" });
    expect(todos.isError).not.toBe(true);
    expect(todos.structuredContent).toBeUndefined();
    expect(todos.content).toEqual([{ type: "text", text: JSON.stringify(["write tests", "ship it"]) }]);

    const number = await callBuiltin(client, "appduct_call_tool", { name: "claims_object" });
    expect(number.isError).not.toBe(true);
    expect(number.content).toEqual([{ type: "text", text: "42" }]);
  });

  test("omitted args reach the tool as an empty object; non-object args are an invalid request", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([{ name: "ping" }]);
    app.onCall("ping", (args) => ({ received: args }));

    const client = await startServerWithClient(daemon);

    const omitted = await callBuiltin(client, "appduct_call_tool", { name: "ping" });
    expect(omitted.structuredContent).toEqual({ received: {} });

    const invalid = errorText(await callBuiltin(client, "appduct_call_tool", { name: "ping", args: [1, 2] }));
    expect(invalid).toContain("invalid_request");
  });

  test("an app tool_error's type and message are preserved in the error content, not thrown as a protocol error", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([{ name: "boom" }]);
    app.onCall("boom", () => {
      throw toolError("tool_execution_error", "boom failed");
    });

    const client = await startServerWithClient(daemon);
    const text = errorText(await callBuiltin(client, "appduct_call_tool", { name: "boom" }));

    expect(text).toContain("tool_execution_error");
    expect(text).toContain("boom failed");
  });

  test("an unregistered tool is tool_not_found and never reaches the daemon's tools.call", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([{ name: "echo" }]);

    const client = await startServerWithClient(daemon);
    const text = errorText(await callBuiltin(client, "appduct_call_tool", { name: "does-not-exist" }));

    expect(text).toContain("tool_not_found");
    expect(daemon.calls().some((call) => call.method === RPC_METHODS.toolsCall)).toBe(false);
  });

  test("the selector routes the call to that session when several share a tool name", async () => {
    const daemon = createFakeDaemon();
    const android = daemon.addSession({ alias: "pixel-8" });
    android.setTools([{ name: "whoami" }]);
    android.onCall("whoami", () => ({ platform: "android" }));
    const ios = daemon.addSession({ alias: "iphone-15" });
    ios.setTools([{ name: "whoami" }]);
    ios.onCall("whoami", () => ({ platform: "ios" }));

    const client = await startServerWithClient(daemon);

    expect(errorText(await callBuiltin(client, "appduct_call_tool", { name: "whoami" }))).toContain(
      "ambiguous_session",
    );

    const result = await callBuiltin(client, "appduct_call_tool", { selector: "iphone-15", name: "whoami" });
    expect(result.structuredContent).toEqual({ platform: "ios" });
  });

  test("runs under the tool's declared deadline, or the caller's timeoutMs when given", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([{ name: "slow", timeout_ms: 30_000 }]);
    app.onCall("slow", () => ({ ok: true }));

    const client = await startServerWithClient(daemon);
    const sentTimeouts = () =>
      daemon
        .calls()
        .filter((call) => call.method === RPC_METHODS.toolsCall)
        .map((call) => (call.params as { timeoutMs?: number }).timeoutMs);

    await callBuiltin(client, "appduct_call_tool", { name: "slow" });
    await callBuiltin(client, "appduct_call_tool", { name: "slow", timeoutMs: 45_000 });

    expect(sentTimeouts()).toEqual([30_000, 45_000]);

    const invalid = errorText(await callBuiltin(client, "appduct_call_tool", { name: "slow", timeoutMs: -1 }));
    expect(invalid).toContain("invalid_request");
  });
});
