/**
 * E2E scenario: background. The fake app closes its socket with `1001 app_backgrounded`, the way
 * the iOS and Android SDKs do when the app leaves the foreground. `sessions ls`, `tools call` and
 * the MCP `appduct_call_tool` must all say so, and a resume must clear it.
 */

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { FakeAppClient } from "./app-client.js";
import {
  binEntry,
  cleanupAfterEach,
  daemonWssPort,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  packageRoot,
  runCliJson,
  subscribeToEvents,
  trackCleanup,
} from "./harness.js";

afterEach(cleanupAfterEach);

describe("e2e: background", () => {
  test(
    "ls, tools call and the MCP call all report the background; a resume clears it",
    async () => {
      const { stateDir } = await makeTempStateDir({});
      await ensureDaemon(stateDir);
      const port = await daemonWssPort(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);
      const events = await subscribeToEvents(stateDir);

      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const { alias } = await app.claim(link, { model: "Pixel 8" });
      app.registerTools([{ name: "echo" }]);
      await events.waitFor("tools_changed");

      const suspended = events.waitFor("session_suspended");
      app.closeForBackground();
      await suspended;

      const message = `Session "${alias}" is suspended because the app is in the background. Bring the app to the foreground to resume it.`;

      const ls = await runCliJson<Array<{ state: string; suspendReason?: string }>>(["sessions", "ls"], stateDir);
      expect(ls.data).toEqual([expect.objectContaining({ state: "suspended", suspendReason: "app_backgrounded" })]);

      const cliCall = await runCliJson(["tools", "call", alias, "echo", "--input", "{}"], stateDir);
      expect(cliCall.ok).toBe(false);
      expect(cliCall.error?.type).toBe("session_suspended");
      expect(cliCall.error?.message).toBe(message);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [binEntry, "mcp"],
        cwd: packageRoot,
        env: { ...(process.env as Record<string, string>), APPDUCT_STATE_DIR: stateDir },
        stderr: "pipe",
      });
      const client = new Client({ name: "e2e-background-client", version: "0.0.0" });
      trackCleanup(() => client.close());
      await client.connect(transport);

      const mcpCall = await client.request(
        { method: "tools/call", params: { name: "appduct_call_tool", arguments: { name: "echo", args: {} } } },
        CallToolResultSchema,
      );
      expect(mcpCall.isError).toBe(true);
      const mcpText = (mcpCall.content[0] as { text: string }).text;
      expect(mcpText).toContain("session_suspended");
      expect(mcpText).toContain(message);

      const resumed = events.waitFor("session_resumed");
      await app.resume();
      await resumed;

      const after = await runCliJson<Array<{ state: string; suspendReason?: string }>>(["sessions", "ls"], stateDir);
      expect(after.data![0]).toMatchObject({ state: "active" });
      expect(after.data![0]).not.toHaveProperty("suspendReason");
    },
    30_000,
  );
});
