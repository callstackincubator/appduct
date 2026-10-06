/**
 * E2E scenario: a React web app through `@appduct/web/react` (issue #172, criterion 1 of #164). A
 * real daemon subprocess, a real Chromium page running a React app bundled with esbuild against the
 * real `@appduct/web` build, and the real CLI as the caller. Nothing is faked.
 */
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { link } from "../../client/index.js";
import { cleanupAfterEach, ensureDaemon, makeTempStateDir, runCliJson, trackCleanup, waitUntil } from "./harness.js";

afterEach(cleanupAfterEach);

/** The React app as its author writes it: a tool whose handler reads component state. */
const APP_SOURCE = `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAppductTool } from "@appduct/web/react";

function App() {
  const [count, setCount] = useState(0);
  useAppductTool({
    name: "count",
    description: "Reports the button's click count.",
    outputSchema: { type: "object", properties: { count: { type: "number" } } },
    handler: () => ({ count }),
  });
  return h("button", { id: "bump", onClick: () => setCount((value) => value + 1) }, "clicks: " + count);
}

createRoot(document.getElementById("root")).render(h(App));
`;

let appBundle = "";
let server: Server;
let origin = "";
let browser: Browser;

beforeAll(async () => {
  const result = await build({
    stdin: { contents: APP_SOURCE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "tsx" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  appBundle = result.outputFiles[0]!.text;

  server = createServer((request, response) => {
    if (request.url === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end(appBundle);
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html" })
      .end('<!doctype html><title>React e2e</title><div id="root"></div><script type="module" src="/app.js"></script>');
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

type SessionRow = { alias: string; state: string; toolCount: number };

const activeSession = async (stateDir: string): Promise<SessionRow> => {
  let found: SessionRow | undefined;
  await waitUntil(
    async () => {
      const rows = (await runCliJson<SessionRow[]>(["sessions", "ls"], stateDir)).data ?? [];
      found = rows.find((row) => row.state === "active" && row.toolCount > 0);
      return found !== undefined;
    },
    { timeoutMs: 15_000, description: "an active web session with its tool synced" },
  );
  return found!;
};

describe("e2e: React web app through @appduct/web/react", () => {
  test(
    "a tool registered with useAppductTool is callable, sees the latest state, and re-rendering does not re-register it",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const { url } = (await link({ stateDir, target: "web", url: `${origin}/` })) as unknown as { url: string };

      const context = await browser.newContext();
      trackCleanup(() => context.close());
      const page = await context.newPage();
      const registryFrames: string[] = [];
      page.on("websocket", (socket) =>
        socket.on("framesent", ({ payload }) => {
          const type = (JSON.parse(String(payload)) as { type?: string }).type;
          if (type === "tool_registry_snapshot" || type === "tool_registry_delta") registryFrames.push(type);
        }),
      );

      await page.goto(url);
      const { alias } = await activeSession(stateDir);
      const call = async () =>
        JSON.stringify((await runCliJson(["tools", "call", alias, "count", "--input", "{}"], stateDir)).data);

      expect(await call()).toContain('"count":0');
      expect(registryFrames).toEqual(["tool_registry_snapshot"]);

      for (let clicks = 1; clicks <= 3; clicks += 1) await page.click("#bump");
      await page.waitForFunction(() => document.getElementById("bump")?.textContent === "clicks: 3");

      expect(await call()).toContain('"count":3');
      expect(registryFrames).toEqual(["tool_registry_snapshot"]);
    },
    60_000,
  );
});
