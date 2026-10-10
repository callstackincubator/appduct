import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "vitest";

import { appductBin } from "../src/cli.js";
import { until } from "../src/process.js";
import { linkReloadable } from "../src/reload.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("a call running when the app reloads fails at once with session_suspended", async (context) => {
  if (!suite.target.reload) {
    return context.skip("the native playgrounds have no JS or Dart state to restart in place");
  }
  const { app, reload, stop } = await linkReloadable(suite);
  // MCP, not appduct/client: its progress notifications say when slow_task's handler is running,
  // so the reload lands mid-call every time instead of racing the call.
  const mcp = new Client({ name: "appduct-e2e-device", version: "0.0.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [appductBin, "mcp"],
      env: { ...(process.env as Record<string, string>), APPDUCT_STATE_DIR: suite.stateDir },
      stderr: "pipe",
    }),
  );
  try {
    const progress: number[] = [];
    const startedAt = Date.now();
    let settledAt = 0;
    const call = mcp
      .request(
        { method: "tools/call", params: { name: "appduct_call_tool", arguments: { selector: app.sessionId, name: "slow_task", args: {} } } },
        CallToolResultSchema,
        { onprogress: ({ progress: value }) => progress.push(value), timeout: 30_000 },
      )
      .finally(() => {
        settledAt = Date.now();
      });

    await until(async () => (progress.length > 0 ? true : undefined), "slow_task to report its first progress", 15_000);
    expect(progress).toEqual([0.33]);
    await reload();

    const result = await call;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("session_suspended");
    // slow_task's own timeout is 5 s; the call must not wait for it.
    expect(settledAt - startedAt).toBeLessThan(4_000);

    await until(() => app.call("call_count", {}).catch(() => undefined), "the session to answer again", 30_000);
  } finally {
    await mcp.close();
    await stop();
  }
});
