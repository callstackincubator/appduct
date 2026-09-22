/**
 * E2E scenario: MCP. An MCP client over stdio against a real `appduct mcp` *subprocess*
 * (consolidating `mcp-server.integration.test.ts`'s in-process coverage at the subprocess level):
 * listing, describing and calling the fake app's tools through the built-ins.
 */

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { FakeAppClient } from "./app-client.js";
import {
  daemonWssPort,
  binEntry,
  cleanupAfterEach,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  packageRoot,
  subscribeToEvents,
  trackCleanup,
} from "./harness.js";

afterEach(cleanupAfterEach);

describe("e2e: mcp (real stdio subprocess)", () => {
  test(
    "list, describe and call app tools through the built-ins against a real `appduct mcp` subprocess",
    async () => {
      const { stateDir } = await makeTempStateDir({ scheme: "appduct-mcp-e2e" });
      // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
      // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
      const port = await daemonWssPort(stateDir);
      // The daemon is brought up first (via a real CLI subprocess) so the `mcp` subprocess never
      // needs to win an auto-spawn race with this test's own setup, and so the pin can be fetched
      // before the fake app ever connects.
      await ensureDaemon(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8" });
      const alias = ack.alias;
      const toolsChanged = events.waitFor("tools_changed");
      app.registerTools([
        {
          name: "echo",
          description: "Echoes its input.",
          input_schema: { type: "object", properties: { text: { type: "string" } } },
        },
      ]);
      await toolsChanged;
      events.close();

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [binEntry, "mcp"],
        cwd: packageRoot,
        env: { ...(process.env as Record<string, string>), APPDUCT_STATE_DIR: stateDir },
        stderr: "pipe",
      });

      const client = new Client({ name: "e2e-mcp-client", version: "0.0.0" });
      trackCleanup(() => client.close());
      await client.connect(transport);

      const listed = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
      const listedNames = listed.tools.map((tool) => tool.name);
      expect(listedNames).toContain("appduct_list_tools");
      expect(listedNames).not.toContain("echo");

      const appTools = await client.request(
        { method: "tools/call", params: { name: "appduct_list_tools", arguments: {} } },
        CallToolResultSchema,
      );
      expect(appTools.structuredContent).toEqual({
        session: alias,
        total: 1,
        limit: 50,
        // `group: null` on the entry, `group: null` in the summary below: the same "no group" in both
        // halves of the result, so a caller never compares `undefined` in one and `null` in the other.
        tools: [
          { name: "echo", signature: "echo(text?: string)", summary: "Echoes its input.", group: null, policy: "allow" },
        ],
        groups: [{ group: null, total: 1 }],
      });

      const described = await client.request(
        { method: "tools/call", params: { name: "appduct_describe_tool", arguments: { name: "echo" } } },
        CallToolResultSchema,
      );
      expect(described.structuredContent).toMatchObject({
        name: "echo",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
      });

      app.answerCalls((call) => ({ result: { echoed: (call.args as Record<string, unknown>).text } }));

      const called = await client.request(
        {
          method: "tools/call",
          params: { name: "appduct_call_tool", arguments: { name: "echo", args: { text: "hello-mcp" } } },
        },
        CallToolResultSchema,
      );
      expect(called.isError).not.toBe(true);
      expect(called.structuredContent).toEqual({ echoed: "hello-mcp" });

      // A second device connecting changes nothing in tools/list; its tools are reached with a
      // selector instead.
      let listChangedCount = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        listChangedCount += 1;
      });

      const secondEvents = await subscribeToEvents(stateDir);
      const secondToolsChanged = secondEvents.waitFor("tools_changed");
      const secondLink = await mintLink(stateDir);
      const secondApp = new FakeAppClient(port, pinnedKeys);
      const secondAck = await secondApp.claim(secondLink, { model: "iPhone 15" });
      secondApp.registerTools([{ name: "whoami", description: "Names the device." }]);
      await secondToolsChanged;
      secondEvents.close();
      secondApp.answerCalls(() => ({ result: { device: "iphone" } }));

      const relisted = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
      expect(relisted.tools.map((tool) => tool.name)).toEqual(listedNames);
      expect(listChangedCount).toBe(0);

      const ambiguous = await client.request(
        { method: "tools/call", params: { name: "appduct_list_tools", arguments: {} } },
        CallToolResultSchema,
      );
      expect(ambiguous.isError).toBe(true);
      expect((ambiguous.content[0] as { text: string }).text).toContain("ambiguous_session");

      const secondCall = await client.request(
        {
          method: "tools/call",
          params: { name: "appduct_call_tool", arguments: { selector: secondAck.alias, name: "whoami" } },
        },
        CallToolResultSchema,
      );
      expect(secondCall.structuredContent).toEqual({ device: "iphone" });

      app.close();
      secondApp.close();
      await client.close();
    },
    20_000,
  );

  /*
   * Issue #29's second acceptance criterion, through the *real* argv path: `appduct mcp
   * --scheme myapp` with an empty state dir. The in-process tests in
   * `mcp-command.integration.test.ts` call `handleMcpCommand({ scheme })` directly, which proves
   * the command honours the option but not that `create-cli.ts` declares it or that `dispatch.ts`
   * passes it through — the exact wiring an MCP config entry depends on.
   */
  test(
    "`appduct mcp --scheme` reaches appduct_connect with no scheme configured anywhere",
    async () => {
      const { stateDir } = await makeTempStateDir({ scheme: undefined });
      await ensureDaemon(stateDir);

      // Built explicitly rather than spread-and-override: an exported APPDUCT_SCHEME on the
      // developer's machine would otherwise be able to satisfy this test without the flag working.
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        APPDUCT_STATE_DIR: stateDir,
      };
      delete env.APPDUCT_SCHEME;

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [binEntry, "mcp", "--scheme", "flag-scheme"],
        // `packageRoot` has no `app.json`, so discovery cannot supply the scheme either.
        cwd: packageRoot,
        env,
        stderr: "pipe",
      });

      const client = new Client({ name: "e2e-mcp-scheme-client", version: "0.0.0" });
      trackCleanup(() => client.close());
      await client.connect(transport);

      // `target: "none"` keeps this about scheme resolution rather than whatever simulators the
      // machine running the suite happens to have booted.
      const connected = await client.request(
        {
          method: "tools/call",
          params: { name: "appduct_connect", arguments: { target: "none" } },
        },
        CallToolResultSchema,
      );

      expect(connected.isError).not.toBe(true);
      expect((connected.structuredContent as { deepLink: string }).deepLink).toMatch(
        /^flag-scheme:\/\/\/\?appduct=/u,
      );

      await client.close();
    },
    20_000,
  );
});
