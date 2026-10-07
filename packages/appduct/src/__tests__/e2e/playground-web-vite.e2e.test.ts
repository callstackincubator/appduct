/**
 * E2E scenario: the standalone web playground (`playground-web/`), a plain Vite and React page
 * using `@appduct/web` directly. It is built with Vite in development mode (the `development`
 * export condition keeps Appduct enabled), loaded in a real Chromium against a real daemon, and
 * driven only through the real CLI: link, session list, tool list, tool calls, an error path and
 * the event stream. Nothing is faked.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type Browser } from "playwright-core";
import { build as viteBuild } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  cleanupAfterEach,
  ensureDaemon,
  makeTempStateDir,
  packageRoot,
  runCliJson,
  spawnCli,
  trackCleanup,
  waitForExit,
  waitUntil,
} from "./harness.js";

afterEach(cleanupAfterEach);

const playgroundRoot = path.resolve(packageRoot, "../../playground-web");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

let outDir = "";
let server: Server;
let origin = "";
let browser: Browser;

beforeAll(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "appduct-playground-web-vite-"));
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    await viteBuild({
      root: playgroundRoot,
      mode: "development",
      logLevel: "silent",
      build: { outDir, emptyOutDir: true, minify: false },
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }

  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = path.join(outDir, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(outDir) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;

  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

type SessionRow = { alias: string; state: string; toolCount: number };
type EventLine = { kind: string; data: { name?: string; payload?: { at?: number } } };

describe("e2e: playground-web through @appduct/web and the CLI", () => {
  test(
    "its tools are listed and callable, a failing tool reports its error, and its event reaches events tail",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);

      const linked = await runCliJson<{ url: string }>(["sessions", "link", "--open", "web", `${origin}/`], stateDir);
      expect(linked.ok).toBe(true);

      const context = await browser.newContext();
      trackCleanup(() => context.close());
      const page = await context.newPage();
      await page.goto(linked.data!.url);

      let session: SessionRow | undefined;
      await waitUntil(
        async () => {
          const rows = (await runCliJson<SessionRow[]>(["sessions", "ls"], stateDir)).data ?? [];
          session = rows.find((row) => row.state === "active" && row.toolCount === 5);
          return session !== undefined;
        },
        { timeoutMs: 30_000, description: "an active web session with the playground's five tools" },
      );
      const alias = session!.alias;
      const callTool = (name: string, input: unknown = {}) =>
        runCliJson(["tools", "call", alias, name, "--input", JSON.stringify(input)], stateDir);

      const listed = JSON.stringify((await runCliJson(["tools", "ls", alias], stateDir)).data);
      for (const name of ["sum", "call_count", "reset_counter", "slow_task", "throwing_tool"]) {
        expect(listed).toContain(`"${name}"`);
      }

      const events = spawnCli(["events", "tail", "--json"], stateDir);
      const lines: EventLine[] = [];
      let buffered = "";
      void (async () => {
        for await (const chunk of events.stdout) {
          buffered += Buffer.from(chunk).toString("utf8");
          const parts = buffered.split("\n");
          buffered = parts.pop() ?? "";
          for (const part of parts) if (part) lines.push(JSON.parse(part) as EventLine);
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(JSON.stringify((await callTool("sum", { a: 2, b: 3 })).data)).toContain('"total":5');
      expect(JSON.stringify((await callTool("slow_task")).data)).toContain('"done":true');
      expect(JSON.stringify((await callTool("call_count")).data)).toContain('"count":2');
      expect(await page.textContent("#count")).toBe("Counted calls: 2");

      expect(JSON.stringify((await callTool("reset_counter")).data)).toContain('"count":0');
      expect(JSON.stringify((await callTool("call_count")).data)).toContain('"count":0');

      const failed = await callTool("throwing_tool");
      expect(failed.ok).toBe(false);
      expect(failed.exitCode).not.toBe(0);
      expect(JSON.stringify(failed.error)).toContain("throwing_tool always fails on purpose.");

      const declared = JSON.stringify((await runCliJson(["events", "ls"], stateDir)).data);
      expect(declared).toContain("playground_ping");

      await page.click("#ping");
      await waitUntil(async () => lines.some((line) => line.data.name === "playground_ping"), {
        timeoutMs: 10_000,
        description: "the playground_ping event on events tail",
      });
      const ping = lines.find((line) => line.data.name === "playground_ping")!;
      expect(ping.kind).toBe("app_event");
      expect(typeof ping.data.payload?.at).toBe("number");

      events.kill("SIGINT");
      expect(await waitForExit(events)).toBe(0);
    },
    120_000,
  );
});
