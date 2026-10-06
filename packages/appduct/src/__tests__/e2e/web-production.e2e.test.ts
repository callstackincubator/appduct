/**
 * E2E scenario: keeping `@appduct/web` out of production bundles (issue #173, slice 6 of #164).
 * Real Vite and webpack builds of a small app, run in a real Chromium page against a real daemon.
 * Nothing is faked and no bundler is mocked.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";
import { build as viteBuild } from "vite";
import webpack from "webpack";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { link } from "../../client/index.js";
import { cleanupAfterEach, ensureDaemon, makeTempStateDir, runCliJson, trackCleanup, waitUntil } from "./harness.js";

afterEach(cleanupAfterEach);

const appDir = fileURLToPath(new URL("./fixtures/web-app/", import.meta.url));

type Mode = "production" | "development";
type Bundler = (entry: string, outDir: string, mode: Mode) => Promise<string>;

/** Builds `entry` and returns the bundle's source. Vite derives its conditions from `NODE_ENV`. */
const vite: Bundler = async (entry, outDir, mode) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  try {
    await viteBuild({
      root: appDir,
      configFile: false,
      logLevel: "silent",
      mode,
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        lib: { entry: path.join(appDir, entry), formats: ["iife"], name: "app", fileName: () => "bundle.js" },
      },
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  return readFile(path.join(outDir, "bundle.js"), "utf8");
};

const webpackBuild: Bundler = async (entry, outDir, mode) => {
  const stats = await new Promise<webpack.Stats>((resolve, reject) => {
    webpack(
      {
        mode,
        context: appDir,
        entry: path.join(appDir, entry),
        target: "web",
        devtool: false,
        output: { path: outDir, filename: "bundle.js" },
      },
      (error, result) => (error || !result ? reject(error ?? new Error("no stats")) : resolve(result)),
    );
  });
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
  return readFile(path.join(outDir, "bundle.js"), "utf8");
};

const bundlers: [string, Bundler][] = [
  ["Vite", vite],
  ["webpack", webpackBuild],
];

/** Strings only the session client and the web core contain. */
const SESSION_CLIENT_MARKERS = ["tool_registry_snapshot", "WebSocket", "sessionStorage", "__APPDUCT__"];

let tempDir = "";
let server: Server;
let origin = "";
let served = "";
let browser: Browser;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "appduct-web-prod-"));
  server = createServer((request, response) => {
    if (request.url === "/bundle.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end(served);
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html" })
      .end('<!doctype html><title>Appduct web production</title><script src="/bundle.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
});

const openPage = async (url: string): Promise<{ page: Page; sockets: () => Promise<number> }> => {
  const context = await browser.newContext();
  trackCleanup(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(`
    window.__sockets = 0;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        window.__sockets += 1;
        super(...args);
      }
    };
  `);
  await page.goto(url);
  return { page, sockets: () => page.evaluate<number>("window.__sockets") };
};

describe.each(bundlers)("%s", (_name, bundle) => {
  test("a production build of the app contains no session client", async () => {
    const source = await bundle("app.js", path.join(tempDir, `${_name}-prod`), "production");
    for (const marker of SESSION_CLIENT_MARKERS) expect(source).not.toContain(marker);
  }, 60_000);

  test("a development build of the app contains the session client", async () => {
    const source = await bundle("app.js", path.join(tempDir, `${_name}-dev`), "development");
    for (const marker of SESSION_CLIENT_MARKERS) expect(source).toContain(marker);
  }, 60_000);

  test("a production page opens no connection and leaves window.__APPDUCT__ undefined, even given a link", async () => {
    served = await bundle("app.js", path.join(tempDir, `${_name}-prod-page`), "production");
    const { stateDir } = await makeTempStateDir();
    await ensureDaemon(stateDir);
    const { url } = (await link({ stateDir, target: "web", url: `${origin}/` })) as unknown as { url: string };

    const { page, sockets } = await openPage(url);
    await page.waitForTimeout(1000);

    expect(await sockets()).toBe(0);
    expect(await page.evaluate("typeof window.__APPDUCT__")).toBe("undefined");
    const rows = await runCliJson<unknown[]>(["sessions", "ls"], stateDir);
    expect(rows.data ?? []).toEqual([]);
  }, 60_000);

  test("a production bundle importing @appduct/web/enabled connects", async () => {
    served = await bundle("app-enabled.js", path.join(tempDir, `${_name}-enabled`), "production");
    const { stateDir } = await makeTempStateDir();
    await ensureDaemon(stateDir);
    const { url } = (await link({ stateDir, target: "web", url: `${origin}/` })) as unknown as { url: string };

    await openPage(url);

    await waitUntil(
      async () => {
        const rows = await runCliJson<{ state: string; toolCount: number }[]>(["sessions", "ls"], stateDir);
        return (rows.data ?? []).some((row) => row.state === "active" && row.toolCount === 1);
      },
      { timeoutMs: 15_000, description: "the opted-in production page to claim a session and sync its tool" },
    );
  }, 60_000);
});
