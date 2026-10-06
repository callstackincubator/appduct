/**
 * E2E scenario: the Expo playground's web target (issue #172, criterion 2 of #164). The playground
 * is exported for web with Expo's own Metro pipeline, so `@appduct/react-native` is resolved the way
 * a React Native app's web build resolves it, then loaded in a real Chromium against a real daemon.
 * The app has no web-specific Appduct code; the same five demo tools it registers on a device must
 * be callable here. Nothing is faked.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type Browser } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { link } from "../../client/index.js";
import { cleanupAfterEach, ensureDaemon, makeTempStateDir, packageRoot, runCliJson, trackCleanup, waitUntil } from "./harness.js";

afterEach(cleanupAfterEach);

const playgroundRoot = path.resolve(packageRoot, "../../playground");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf" };

let exportDir = "";
let server: Server;
let origin = "";
let browser: Browser;

const exportPlaygroundForWeb = (outputDir: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "expo", "export", "--platform", "web", "--output-dir", outputDir], {
      cwd: playgroundRoot,
      env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`expo export failed (${code}):\n${output.slice(-4000)}`))));
  });

beforeAll(async () => {
  exportDir = mkdtempSync(path.join(tmpdir(), "appduct-playground-web-"));
  await exportPlaygroundForWeb(exportDir);

  server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const candidates = [pathname, `${pathname}.html`, path.join(pathname, "index.html")].map((name) => path.join(exportDir, name));
    const file = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    if (!file || !file.startsWith(exportDir)) {
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
}, 300_000);

afterAll(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (exportDir) rmSync(exportDir, { recursive: true, force: true });
});

type SessionRow = { alias: string; state: string; toolCount: number };

describe("e2e: playground web target through @appduct/react-native", () => {
  test(
    "the demo tools the playground registers on a device are registered and callable from its web build",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const { url } = (await link({ stateDir, target: "web", url: `${origin}/` })) as unknown as { url: string };

      const context = await browser.newContext();
      trackCleanup(() => context.close());
      const page = await context.newPage();
      await page.goto(url);

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

      const listed = JSON.stringify((await runCliJson(["tools", "ls", alias], stateDir)).data);
      for (const name of ["sum", "call_count", "reset_counter", "slow_task", "throwing_tool"]) expect(listed).toContain(`"${name}"`);

      const summed = await runCliJson(["tools", "call", alias, "sum", "--input", JSON.stringify({ a: 2, b: 3 })], stateDir);
      expect(JSON.stringify(summed.data)).toContain('"total":5');

      const counted = await runCliJson(["tools", "call", alias, "call_count", "--input", "{}"], stateDir);
      expect(JSON.stringify(counted.data)).toContain('"count":1');
    },
    120_000,
  );
});
