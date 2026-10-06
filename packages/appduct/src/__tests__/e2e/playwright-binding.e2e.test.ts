/**
 * E2E scenario: a Playwright test runs a web session over a binding (issue #177, slice 1 of #167).
 * A real daemon subprocess, real Chromium through Playwright, a page on an `https` origin that loads
 * the real `@appduct/web` bundle, and `appduct/client` as the caller. Nothing is faked.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { attachPage, connect, link } from "../../client/index.js";
import { cleanupAfterEach, ensureDaemon, makeTempStateDir, runCliJson, trackCleanup, waitUntil } from "./harness.js";

afterEach(cleanupAfterEach);

const WEB_ENTRY = fileURLToPath(import.meta.resolve("@appduct/web/enabled"));
const ORIGIN = "https://staging.example";

const APP_SCRIPT = `
import { registerTool, registerEvent, postEvent } from "/appduct-web.js";
registerTool({
  name: "add",
  description: "Add two numbers.",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  outputSchema: { type: "object", properties: { total: { type: "number" } } },
  handler: ({ a, b }) => ({ total: a + b }),
});
registerEvent({ name: "saved", description: "A document was saved." });
window.postSaved = (id) => postEvent("saved", { id });
`;
const pageHtml = `<!doctype html><title>Appduct binding e2e</title><script type="module">${APP_SCRIPT}</script>`;

let bundle = "";
let browser: Browser;

beforeAll(async () => {
  bundle = readFileSync(WEB_ENTRY, "utf8");
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

type SessionRow = { alias: string; sessionId: string; state: string; toolCount: number };

const sessions = async (stateDir: string): Promise<SessionRow[]> =>
  (await runCliJson<SessionRow[]>(["sessions", "ls"], stateDir)).data ?? [];

const waitForActiveSession = async (stateDir: string): Promise<SessionRow> => {
  let found: SessionRow | undefined;
  await waitUntil(
    async () => {
      found = (await sessions(stateDir)).find((row) => row.state === "active" && row.toolCount > 0);
      return found !== undefined;
    },
    { timeoutMs: 15_000, description: "an active web session with its tools synced" },
  );
  return found!;
};

/** A page on the https staging origin, served from memory by Playwright, and every page-side connection it opens. */
const startStagingPage = async (): Promise<{ page: Page; pageConnections: string[] }> => {
  const context = await browser.newContext();
  trackCleanup(() => context.close());
  await context.route(`${ORIGIN}/**`, (route) =>
    new URL(route.request().url()).pathname === "/appduct-web.js"
      ? route.fulfill({ contentType: "text/javascript", body: bundle })
      : route.fulfill({ contentType: "text/html", body: pageHtml }),
  );
  const page = await context.newPage();
  const pageConnections: string[] = [];
  page.on("websocket", (socket) => pageConnections.push(socket.url()));
  page.on("request", (request) => {
    if (/127\.0\.0\.1|localhost|\[::1\]/u.test(request.url())) pageConnections.push(request.url());
  });
  return { page, pageConnections };
};

const startDaemon = async () => {
  const { stateDir } = await makeTempStateDir({ webOrigins: [ORIGIN] });
  await ensureDaemon(stateDir);
  return stateDir;
};

describe("e2e: web session over a Playwright binding", () => {
  test(
    "a tool on an https page is called through attachPage and the page opens no network connection",
    async () => {
      const stateDir = await startDaemon();
      const { page, pageConnections } = await startStagingPage();
      await page.goto(`${ORIGIN}/`);

      await attachPage(page, { link: await link({ stateDir, target: "web", url: `${ORIGIN}/` }) });
      await waitForActiveSession(stateDir);

      const app = await connect({ stateDir });
      trackCleanup(() => app.close());
      expect(await app.call("add", { a: 2, b: 3 })).toEqual({ total: 5 });
      expect(pageConnections).toEqual([]);
    },
    60_000,
  );

  test(
    "an event posted from the page reaches waitForEvent",
    async () => {
      const stateDir = await startDaemon();
      const { page } = await startStagingPage();
      await page.goto(`${ORIGIN}/`);
      await attachPage(page, { link: await link({ stateDir, target: "web", url: `${ORIGIN}/` }) });
      await waitForActiveSession(stateDir);

      const app = await connect({ stateDir });
      trackCleanup(() => app.close());
      const waiting = app.waitForEvent("saved", { timeoutMs: 10_000 });
      await page.evaluate("window.postSaved(7)");

      expect(await waiting).toMatchObject({ name: "saved", payload: { id: 7 } });
    },
    60_000,
  );

  test(
    "reloading the page resumes the session over the binding",
    async () => {
      const stateDir = await startDaemon();
      const { page, pageConnections } = await startStagingPage();
      await page.goto(`${ORIGIN}/`);
      await attachPage(page, { link: await link({ stateDir, target: "web", url: `${ORIGIN}/` }) });
      const before = await waitForActiveSession(stateDir);

      await page.reload();
      await waitUntil(
        async () => {
          const rows = await sessions(stateDir);
          return rows.length === 1 && rows[0]!.state === "active" && rows[0]!.toolCount > 0;
        },
        { timeoutMs: 15_000, description: "the reloaded page to resume its session" },
      );

      expect((await sessions(stateDir)).map((row) => row.sessionId)).toEqual([before.sessionId]);
      const app = await connect({ stateDir });
      trackCleanup(() => app.close());
      expect(await app.call("add", { a: 1, b: 1 })).toEqual({ total: 2 });
      expect(pageConnections).toEqual([]);
    },
    60_000,
  );

  test(
    "attaching the same page twice moves the session to the new link",
    async () => {
      const stateDir = await startDaemon();
      const { page } = await startStagingPage();
      await page.goto(`${ORIGIN}/`);
      await attachPage(page, { link: await link({ stateDir, target: "web", url: `${ORIGIN}/` }) });
      await waitForActiveSession(stateDir);

      await attachPage(page, { link: await link({ stateDir, target: "web", url: `${ORIGIN}/` }) });
      await waitUntil(
        async () => (await sessions(stateDir)).some((row) => row.state === "active" && row.toolCount > 0),
        { timeoutMs: 15_000, description: "the second attach to claim a session" },
      );

      const app = await connect({ stateDir });
      trackCleanup(() => app.close());
      expect(await app.call("add", { a: 6, b: 7 })).toEqual({ total: 13 });
    },
    60_000,
  );

  test(
    "the same page with no relay attached still connects over the WebSocket transport",
    async () => {
      const stateDir = await startDaemon();
      const { page, pageConnections } = await startStagingPage();
      const { url } = await link({ stateDir, target: "web", url: `${ORIGIN}/` });
      await page.goto(url);
      await waitForActiveSession(stateDir);

      const app = await connect({ stateDir });
      trackCleanup(() => app.close());
      expect(await app.call("add", { a: 4, b: 5 })).toEqual({ total: 9 });
      expect(pageConnections).toHaveLength(1);
    },
    60_000,
  );
});
