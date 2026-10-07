/**
 * E2E scenario: the daemon attaches to a Chrome that was launched with `--remote-debugging-port`
 * (issue #178, slice 2 of #167). A real daemon subprocess, a real Chromium process with its own
 * profile, an `https` page that loads the real `@appduct/web` bundle, and the real `appduct mcp` and
 * CLI subprocesses as callers. Nothing is faked. Playwright only observes and drives the browser
 * from outside, over the same debugging port.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { connect } from "../../client/index.js";
import { binEntry, cleanupAfterEach, ensureDaemon, makeTempStateDir, packageRoot, runCliJson, trackCleanup, waitUntil } from "./harness.js";

afterEach(cleanupAfterEach);

const WEB_ENTRY = fileURLToPath(import.meta.resolve("@appduct/web/enabled"));
const HOST = "staging.example";

const APP_SCRIPT = `
import { registerTool } from "/appduct-web.js";
registerTool({
  name: "add",
  description: "Add two numbers.",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  outputSchema: { type: "object", properties: { total: { type: "number" } } },
  handler: ({ a, b }) => ({ total: a + b }),
});
`;

let bundle = "";
let scratch = "";
let origin = "";
let server: Server;
let chromeProcess: ChildProcess;
let browserUrl = "";
let observer: Browser;
let context: BrowserContext;

beforeAll(async () => {
  bundle = readFileSync(WEB_ENTRY, "utf8");
  scratch = await mkdtemp(path.join(tmpdir(), "appduct-devtools-e2e-"));

  // An https origin on a name that is not loopback, so Chrome treats the page as a public site.
  const keyPath = path.join(scratch, "key.pem");
  const certPath = path.join(scratch, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`],
    { stdio: "ignore" },
  );
  server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
    if (request.url === "/appduct-web.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end(bundle);
    } else {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(`<!doctype html><title>Appduct devtools e2e ${request.url}</title><script type="module">${APP_SCRIPT}</script>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://${HOST}:${(server.address() as { port: number }).port}`;

  // The browser a user would launch for an agent: a debugging port and a profile of its own.
  const profile = path.join(scratch, "profile");
  chromeProcess = spawn(
    chromium.executablePath(),
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--ignore-certificate-errors",
      "--no-proxy-server",
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port = "";
  await waitUntil(
    async () => {
      try {
        port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
        return port !== "";
      } catch {
        return false;
      }
    },
    { timeoutMs: 30_000, description: "Chromium to publish its debugging port" },
  );
  browserUrl = `http://127.0.0.1:${port}`;
  observer = await chromium.connectOverCDP(browserUrl);
  context = observer.contexts()[0]!;
}, 90_000);

afterAll(async () => {
  await observer?.close().catch(() => undefined);
  // Chromium's helper processes can still be writing to the profile right after the kill, so wait
  // for the browser to exit and retry the removal while they finish.
  if (chromeProcess && chromeProcess.exitCode === null && chromeProcess.signalCode === null) {
    const exited = new Promise((resolve) => chromeProcess!.once("exit", resolve));
    chromeProcess.kill("SIGKILL");
    await exited;
  }
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

type SessionRow = { alias: string; sessionId: string; state: string; toolCount: number };
type Tab = { id: string; url: string; type: string };

/** Every tab the browser lists, as chrome-devtools-mcp and agent-browser see them. */
const listedTabs = async (): Promise<Tab[]> =>
  ((await (await fetch(`${browserUrl}/json/list`)).json()) as Tab[]).filter((tab) => tab.type === "page");

const targetIdOf = async (url: string): Promise<string> => (await listedTabs()).find((tab) => tab.url === url)!.id;

/** Opens a tab on the https origin and records every connection the page itself makes to this machine. */
const openTab = async (pathname: string): Promise<{ page: Page; pageConnections: string[] }> => {
  const page = await context.newPage();
  trackCleanup(() => page.close().catch(() => undefined));
  const pageConnections: string[] = [];
  page.on("websocket", (socket) => pageConnections.push(socket.url()));
  page.on("request", (request) => {
    if (/127\.0\.0\.1|localhost|\[::1\]/u.test(request.url())) pageConnections.push(request.url());
  });
  await page.goto(`${origin}${pathname}`);
  return { page, pageConnections };
};

const startMcp = async (stateDir: string): Promise<Client> => {
  const client = new Client({ name: "devtools-e2e-client", version: "0.0.0" });
  trackCleanup(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [binEntry, "mcp"],
      cwd: packageRoot,
      env: { ...(process.env as Record<string, string>), APPDUCT_STATE_DIR: stateDir },
      stderr: "pipe",
    }),
  );
  return client;
};

const callConnect = (client: Client, args: Record<string, unknown>) =>
  client.request({ method: "tools/call", params: { name: "appduct_connect", arguments: { target: "web", browserUrl, ...args } } }, CallToolResultSchema);

const sessions = async (stateDir: string): Promise<SessionRow[]> => (await runCliJson<SessionRow[]>(["sessions", "ls"], stateDir)).data ?? [];

const startDaemon = async (): Promise<string> => {
  const { stateDir } = await makeTempStateDir({ webOrigins: [origin] });
  await ensureDaemon(stateDir);
  return stateDir;
};

const expectAddWorks = async (stateDir: string, a: number, b: number) => {
  const app = await connect({ stateDir });
  trackCleanup(() => app.close());
  expect(await app.call("add", { a, b })).toEqual({ total: a + b });
};

describe("e2e: the daemon attaches to a debugging-port Chrome", () => {
  test(
    "appduct_connect claims a session on an https page with no page-side connection",
    async () => {
      const stateDir = await startDaemon();
      const { pageConnections } = await openTab("/only-one");
      const client = await startMcp(stateDir);

      const result = await callConnect(client, { url: `${origin}/only-one` });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ attached: true });
      expect((await sessions(stateDir)).map((row) => row.state)).toEqual(["active"]);
      await expectAddWorks(stateDir, 2, 3);
      expect(pageConnections).toEqual([]);
    },
    90_000,
  );

  test(
    "appduct_connect fails with the open tabs listed when none matches the url",
    async () => {
      const stateDir = await startDaemon();
      await openTab("/somewhere");
      const client = await startMcp(stateDir);

      const result = await callConnect(client, { url: `${origin}/nowhere` });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain(`${origin}/somewhere`);
      expect(await sessions(stateDir)).toEqual([]);
    },
    90_000,
  );

  test(
    "appduct_connect fails with each tab's target id when several tabs match the url",
    async () => {
      const stateDir = await startDaemon();
      await openTab("/shop/a");
      await openTab("/shop/b");
      const client = await startMcp(stateDir);

      const result = await callConnect(client, { url: `${origin}/shop` });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain(await targetIdOf(`${origin}/shop/a`));
      expect(text).toContain(await targetIdOf(`${origin}/shop/b`));
      expect(await sessions(stateDir)).toEqual([]);
    },
    90_000,
  );

  test(
    "appduct_connect with a targetId claims that tab even when several tabs match the url",
    async () => {
      const stateDir = await startDaemon();
      await openTab("/pick/a");
      const { page: second } = await openTab("/pick/b");
      const client = await startMcp(stateDir);

      const result = await callConnect(client, { url: `${origin}/pick`, targetId: await targetIdOf(`${origin}/pick/b`) });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ attached: true, targetId: await targetIdOf(`${origin}/pick/b`) });
      await expectAddWorks(stateDir, 4, 4);
      // The tool ran in the picked tab: it is the one whose page now holds the session.
      expect(await second.evaluate("typeof window.__APPDUCT__")).toBe("object");
    },
    90_000,
  );

  test(
    "reloading the attached page resumes the session",
    async () => {
      const stateDir = await startDaemon();
      const { page, pageConnections } = await openTab("/reload-me");
      const client = await startMcp(stateDir);
      await callConnect(client, { url: `${origin}/reload-me` });
      const [before] = await sessions(stateDir);

      await page.reload();
      await waitUntil(
        async () => {
          const rows = await sessions(stateDir);
          return rows.length === 1 && rows[0]!.state === "active" && rows[0]!.toolCount > 0;
        },
        { timeoutMs: 15_000, description: "the reloaded page to resume its session" },
      );

      expect((await sessions(stateDir)).map((row) => row.sessionId)).toEqual([before!.sessionId]);
      await expectAddWorks(stateDir, 1, 1);
      expect(pageConnections).toEqual([]);
    },
    90_000,
  );

  test(
    "appduct sessions link --open web --browser-url --target-id attaches the picked tab",
    async () => {
      const stateDir = await startDaemon();
      await openTab("/cli/a");
      await openTab("/cli/b");
      const targetId = await targetIdOf(`${origin}/cli/a`);

      const result = await runCliJson(["sessions", "link", "--open", "web", `${origin}/cli`, "--browser-url", browserUrl, "--target-id", targetId], stateDir);

      expect(result.ok).toBe(true);
      await expectAddWorks(stateDir, 5, 6);
    },
    90_000,
  );
});
