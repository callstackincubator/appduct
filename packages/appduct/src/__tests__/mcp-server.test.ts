/**
 * The MCP server's own behaviour (ARCHITECTURE.md §9), against an in-memory daemon
 * (`mcp-daemon-fake.ts`) rather than a real one: tool-name mapping, output-schema degradation
 * (issue #26), `<alias>__<name>` namespacing and `notifications/tools/list_changed`.
 *
 * None of that depends on the transport underneath. These cases used to boot a real daemon — a
 * pidfile, a self-signed certificate, a wss listener — and script a fake app over a real
 * WebSocket, to assert on a JSON schema the server rewrote on its way out. The server is driven by
 * the SDK's own `Client` over `InMemoryTransport` exactly as before, so what the client sees is
 * still what a real client would see; only the daemon behind it is a fake.
 *
 * `mcp-server.integration.test.ts` keeps everything that genuinely needs the real thing: progress
 * correlation over the second daemon stream, cancellation, the `appduct_connect` delivery paths,
 * the resource, stdout purity, and version drift.
 */

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer, type McpServerHandle } from "../mcp/server.js";
import { createFakeDaemon, toolError, type FakeDaemon } from "./mcp-daemon-fake.js";

const mcpHandles: McpServerHandle[] = [];

afterEach(async () => {
  while (mcpHandles.length > 0) {
    await mcpHandles.pop()?.close();
  }
});

const BUILTIN_TOOL_NAMES = new Set([
  "appduct_connect",
  "appduct_wait_for_session",
  "appduct_events",
  "appduct_wait_for_event",
]);

/** Every `tools/list` response always includes the built-in management tools alongside whatever
 * proxied device tools are live; tests that care only about the proxied tools filter them here. */
const withoutBuiltinTools = <T extends { name: string }>(tools: T[]): T[] => {
  return tools.filter((tool) => !BUILTIN_TOOL_NAMES.has(tool.name));
};

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

describe("mcp: tools/list and tools/call", () => {
  test("a fake app's registered tools appear in tools/list with schemas and round-trip through tools/call", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([
      {
        name: "echo",
        description: "Echoes its input.",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
      },
    ]);
    app.onCall("echo", (args) => ({ echoed: args.text }));

    const client = await startServerWithClient(daemon);

    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const proxiedTools = withoutBuiltinTools(listed.tools);
    expect(proxiedTools).toHaveLength(1);
    expect(proxiedTools[0]!.name).toBe("echo");
    expect(proxiedTools[0]!.description).toBe("Echoes its input.");
    expect(proxiedTools[0]!.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } } });

    const called = await client.request(
      { method: "tools/call", params: { name: "echo", arguments: { text: "hello" } } },
      CallToolResultSchema,
    );

    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toEqual({ echoed: "hello" });
  });

  test("a non-object output schema does not break tools/list: both tools list and both stay callable", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([
      {
        name: "get-profile",
        description: "Returns the profile.",
        output_schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        // `z.array(z.string())`: MCP's `Tool.outputSchema.type` is the literal `"object"`, so
        // before issue #26 this single entry made the client reject the whole list.
        name: "list-todos",
        description: "Returns the todos.",
        output_schema: { type: "array", items: { type: "string" } },
      },
      {
        // `z.union([z.object(...), z.object(...)])`: `anyOf` with no root `type`, so MCP rejects
        // it even though every branch — and every result — is an object.
        name: "get-status",
        description: "Returns one of two shapes.",
        output_schema: {
          anyOf: [
            { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
            { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
          ],
        },
      },
    ]);
    app.onCall("get-profile", () => ({ name: "Ada" }));
    app.onCall("list-todos", () => ["write tests", "ship it"]);
    app.onCall("get-status", () => ({ ok: true }));

    const client = await startServerWithClient(daemon);

    // The SDK's own `listTools`, so the result goes through `ListToolsResultSchema` *and* caches
    // the output schemas `callTool` below enforces — exactly what a real client does.
    const listed = await client.listTools();
    const proxiedTools = withoutBuiltinTools(listed.tools);
    expect(proxiedTools.map((tool) => tool.name).sort()).toEqual(["get-profile", "get-status", "list-todos"]);

    const objectTool = proxiedTools.find((tool) => tool.name === "get-profile")!;
    const arrayTool = proxiedTools.find((tool) => tool.name === "list-todos")!;
    const unionTool = proxiedTools.find((tool) => tool.name === "get-status")!;
    expect(objectTool.outputSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(arrayTool.outputSchema).toBeUndefined();
    expect(unionTool.outputSchema).toBeUndefined();

    const profile = await client.callTool({ name: "get-profile", arguments: {} });
    expect(profile.isError).not.toBe(true);
    expect(profile.structuredContent).toEqual({ name: "Ada" });

    // The dropped schema means no `structuredContent` is required or expected; the value still
    // reaches the agent as JSON text.
    const todos = await client.callTool({ name: "list-todos", arguments: {} });
    expect(todos.isError).not.toBe(true);
    expect(todos.structuredContent).toBeUndefined();
    expect(todos.content).toEqual([{ type: "text", text: JSON.stringify(["write tests", "ship it"]) }]);

    // A dropped schema never turns a good result into an error: the union tool's result *is* an
    // object, so it still travels as `structuredContent` — the client just has no schema to
    // validate it against, which is allowed.
    const status = await client.callTool({ name: "get-status", arguments: {} });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toEqual({ ok: true });
    expect(status.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }) }]);
  });

  test("an object output schema paired with a non-object result is a tool_output_validation_error, not a client protocol error", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([
      { name: "lies", description: "Claims an object, returns a number.", output_schema: { type: "object" } },
    ]);
    app.onCall("lies", () => 42);

    const client = await startServerWithClient(daemon);
    await client.listTools();

    // `callTool` (not raw `request`) so the SDK's "has an output schema but did not return
    // structured content" guard is live: an `isError` result is the one shape it accepts.
    const result = await client.callTool({ name: "lies", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("tool_output_validation_error");
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("a number");
  });

  // The issue's own example of a result that breaks the `structuredContent` contract.
  test("an object output schema paired with a null result is a tool_output_validation_error", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([
      { name: "nullish", description: "Claims an object, returns null.", output_schema: { type: "object" } },
    ]);
    app.onCall("nullish", () => null);

    const client = await startServerWithClient(daemon);
    await client.listTools();
    const result = await client.callTool({ name: "nullish", arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("tool_output_validation_error");
    expect(text).toContain("returned null");
    // Never the raw `typeof` wording: "a object" / "a undefined" would read as a bug in the tool.
    expect(text).not.toContain("a undefined");
    expect(text).not.toContain("a object");
  });

  test("the generated MCP tool list (built-ins + one proxied tool) matches the locked mapping", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([
      {
        name: "echo",
        description: "Echoes its input.",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
      },
    ]);

    const client = await startServerWithClient(daemon);

    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    // Names only, sorted: full descriptors (incl. built-ins' free-text descriptions) would make this
    // snapshot brittle against unrelated wording tweaks; the shape/schema mapping is what's locked.
    const shapes = listed.tools
      .map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(shapes).toMatchSnapshot();
  });

  test("a tool without an input_schema gets a permissive object schema", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([{ name: "no-schema" }]);

    const client = await startServerWithClient(daemon);

    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const proxiedTools = withoutBuiltinTools(listed.tools);
    expect(proxiedTools[0]!.inputSchema).toEqual({ type: "object", additionalProperties: true });
  });

  test("annotations map verbatim onto the MCP tool", async () => {
    const daemon = createFakeDaemon();
    daemon.addSession({ alias: "pixel-8" }).setTools([
      {
        name: "destructive-tool",
        description: "Deletes things.",
        annotations: { destructiveHint: true, readOnlyHint: false },
      },
    ]);

    const client = await startServerWithClient(daemon);
    const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const proxiedTools = withoutBuiltinTools(listed.tools);

    expect(proxiedTools[0]!.annotations).toEqual({ destructiveHint: true, readOnlyHint: false });
  });

  test("an app tool_error's type and message are preserved in the MCP error content, not thrown as a protocol error", async () => {
    const daemon = createFakeDaemon();
    const app = daemon.addSession({ alias: "pixel-8" });
    app.setTools([{ name: "boom" }]);
    app.onCall("boom", () => {
      throw toolError("tool_execution_error", "boom failed");
    });

    const client = await startServerWithClient(daemon);

    const result = await client.request(
      { method: "tools/call", params: { name: "boom", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("tool_execution_error");
    expect(text).toContain("boom failed");
  });

  test("calling an unregistered tool returns tool_not_found error content", async () => {
    const daemon = createFakeDaemon();
    const client = await startServerWithClient(daemon);

    const result = await client.request(
      { method: "tools/call", params: { name: "does-not-exist", arguments: {} } },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("tool_not_found");
  });
});

describe("mcp: namespacing and list_changed", () => {
  test("a single live session exposes tools under their own names; a second flips to <alias>__<name> and fires list_changed", async () => {
    const daemon = createFakeDaemon();
    const appA = daemon.addSession({ alias: "pixel-8", deviceModel: "Pixel 8" });
    appA.setTools([{ name: "echo" }]);

    const client = await startServerWithClient(daemon);

    const singleSessionListing = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    expect(withoutBuiltinTools(singleSessionListing.tools).map((tool) => tool.name)).toEqual(["echo"]);

    let listChangedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChangedCount += 1;
    });

    const appB = daemon.addSession({ alias: "iphone-15", deviceModel: "iPhone 15" });
    appB.setTools([{ name: "echo" }]);

    // The daemon event that flips the namespacing (appB's own tools_changed) is pushed
    // synchronously; give the MCP server's own async refresh + notify a beat to catch up.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(listChangedCount).toBeGreaterThan(0);

    const multiSessionListing = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    const names = withoutBuiltinTools(multiSessionListing.tools)
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([`${appA.alias}__echo`, `${appB.alias}__echo`].sort());
  });
});
