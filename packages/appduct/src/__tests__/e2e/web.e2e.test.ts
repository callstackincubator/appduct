/**
 * E2E scenario: a plain-JS web page through `@appduct/web` (issue #171, slice 4 of #164). A real
 * daemon subprocess, a real Chromium page loading the real `@appduct/web` bundle from a local
 * server, and the real CLI, MCP server and `appduct/client` as the callers. Nothing is faked.
 */
import { createServer, type Server } from "node:http";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, beforeAll, afterAll, describe, expect, test } from "vitest";

import { connect, link } from "../../client/index.js";
import {
  binEntry,
  cleanupAfterEach,
  ensureDaemon,
  makeTempStateDir,
  packageRoot,
  runCliJson,
  trackCleanup,
  waitUntil,
} from "./harness.js";

afterEach(cleanupAfterEach);

const WEB_ENTRY = path.resolve(packageRoot, "..", "web", "src", "index.ts");

/** The page's own code, as an app author writes it: import the entry, register a tool and an event. */
const APP_SCRIPT = `
import { registerTool, registerEvent, postEvent } from "/appduct-web.js";
registerTool({
  name: "add",
  description: "Add two numbers.",
  outputSchema: { type: "object", properties: { total: { type: "number" } } },
  handler: ({ a, b }) => ({ total: a + b }),
});
registerEvent({ name: "saved", description: "A document was saved." });
window.postSaved = (id) => postEvent("saved", { id });
`;

const pageHtml = `<!doctype html><title>Appduct web e2e</title><script type="module">${APP_SCRIPT}</script>`;

let bundle = "";
let server: Server;
let origin = "";
let browser: Browser;

beforeAll(async () => {
  const built = await build({
    entryPoints: [WEB_ENTRY],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  bundle = built.outputFiles[0]!.text;

  server = createServer((request, response) => {
    if (request.url === "/appduct-web.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end(bundle);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end(pageHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;

  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
});

type SessionRow = { alias: string; sessionId: string; state: string; toolCount: number };

const sessions = async (stateDir: string): Promise<SessionRow[]> => {
  const result = await runCliJson<SessionRow[]>(["sessions", "ls"], stateDir);
  return result.data ?? [];
};

const waitForActiveSession = async (stateDir: string): Promise<SessionRow> => {
  let found: SessionRow | undefined;
  await waitUntil(
    async () => {
      found = (await sessions(stateDir)).find((row) => row.state === "active" && row.toolCount > 0);
      return found !== undefined;
    },
    { timeoutMs: 15_000, description: "an active web session with its tool synced" },
  );
  return found!;
};

const startPage = async (): Promise<Page> => {
  const context = await browser.newContext();
  trackCleanup(() => context.close());
  return context.newPage();
};

const mintWebLink = async (stateDir: string, url = `${origin}/`, ttlSeconds?: number) =>
  (await link({ stateDir, target: "web", url, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) })) as unknown as {
    url: string;
    script: string;
  };

const connectScriptResult = (page: Page, script: string): Promise<string> =>
  page.evaluate(
    (code) =>
      (0, eval)(code).then(
        () => "connected",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    script,
  );

describe("e2e: web page through @appduct/web", () => {
  test(
    "opening the URL from appduct_connect claims a session whose tool and event reach the CLI, MCP and appduct/client",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [binEntry, "mcp"],
        cwd: packageRoot,
        env: { ...(process.env as Record<string, string>), APPDUCT_STATE_DIR: stateDir },
        stderr: "pipe",
      });
      const mcp = new Client({ name: "e2e-web-mcp-client", version: "0.0.0" });
      trackCleanup(() => mcp.close());
      await mcp.connect(transport);
      const callMcp = (name: string, args: Record<string, unknown>) =>
        mcp.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);

      const connected = await callMcp("appduct_connect", { target: "web", url: `${origin}/` });
      const { url } = connected.structuredContent as { url: string };

      const page = await startPage();
      await page.goto(url);
      await waitForActiveSession(stateDir);

      expect(page.url()).toBe(`${origin}/`);
      expect(await page.evaluate<string>("location.href")).not.toContain("appduct");

      const listed = await runCliJson<{ tools: { name: string }[] } | { name: string }[]>(["tools", "ls"], stateDir);
      expect(JSON.stringify(listed.data)).toContain('"add"');

      const viaCli = await runCliJson(["tools", "call", "add", "--input", JSON.stringify({ a: 2, b: 3 })], stateDir);
      expect(viaCli.data).toEqual({ total: 5 });

      const viaMcp = await callMcp("appduct_call_tool", { name: "add", args: { a: 4, b: 5 } });
      expect(viaMcp.structuredContent).toEqual({ total: 9 });

      const app = await connect({ stateDir });
      trackCleanup(() => app.close());
      expect(await app.call("add", { a: 10, b: 20 })).toEqual({ total: 30 });

      const waiting = callMcp("appduct_wait_for_event", { name: "saved", timeoutMs: 10_000 });
      await page.evaluate("window.postSaved(7)");
      const event = await waiting;
      expect(event.structuredContent).toMatchObject({ name: "saved", payload: { id: 7 } });
    },
    60_000,
  );

  test(
    "running the returned script on a loaded page claims a session without reloading it",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const { script } = await mintWebLink(stateDir);

      const page = await startPage();
      await page.goto(`${origin}/`);
      await page.evaluate('window.marker = "still here"');

      expect(await connectScriptResult(page, script)).toBe("connected");
      await waitForActiveSession(stateDir);

      expect(await page.evaluate("window.marker")).toBe("still here");
    },
    60_000,
  );

  test(
    "reloading the page resumes the session",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const { url } = await mintWebLink(stateDir);

      const page = await startPage();
      await page.goto(url);
      const before = await waitForActiveSession(stateDir);

      await page.reload();
      await waitUntil(
        async () => {
          const rows = await sessions(stateDir);
          return rows.length === 1 && rows[0]!.state === "active" && rows[0]!.toolCount > 0;
        },
        { timeoutMs: 15_000, description: "the reloaded page to resume its session" },
      );

      const rows = await sessions(stateDir);
      expect(rows.map((row) => row.sessionId)).toEqual([before.sessionId]);
      const called = await runCliJson(["tools", "call", "add", "--input", JSON.stringify({ a: 1, b: 1 })], stateDir);
      expect(called.data).toEqual({ total: 2 });
    },
    60_000,
  );

  test(
    "a missing, used or expired link is refused",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const used = await mintWebLink(stateDir);
      const expired = await mintWebLink(stateDir, `${origin}/`, 1);

      const first = await startPage();
      await first.goto(used.url);
      await waitForActiveSession(stateDir);

      const second = await startPage();
      await second.goto(`${origin}/`);
      expect(await connectScriptResult(second, used.script)).toMatch(/already_claimed|invalid_token|unknown_session/u);
      expect(await connectScriptResult(second, 'window.__APPDUCT__.connect("")')).toMatch(/link/iu);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await connectScriptResult(second, expired.script)).toMatch(/expired/iu);

      expect(await sessions(stateDir)).toHaveLength(1);
    },
    60_000,
  );

  test(
    "a page on a foreign origin is refused",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const { script } = await mintWebLink(stateDir, "http://evil.example/");

      const page = await startPage();
      await page.route("http://evil.example/**", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/appduct-web.js") {
          return route.fulfill({ contentType: "text/javascript", body: bundle });
        }
        return route.fulfill({ contentType: "text/html", body: pageHtml });
      });
      await page.goto("http://evil.example/");

      expect(await connectScriptResult(page, script)).not.toBe("connected");
      expect(await sessions(stateDir)).toEqual([]);
    },
    60_000,
  );
});
