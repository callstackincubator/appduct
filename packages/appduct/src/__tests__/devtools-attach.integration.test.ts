/**
 * `appduct_connect` and `appduct sessions link` against a debugging-port browser (issue #178): a
 * real daemon with the in-memory `DevtoolsBrowser` behind it, so the daemon's RPC, link minting and
 * the CLI and MCP argument handling run for real. The real browser is covered in
 * `e2e/devtools-browser.e2e.test.ts`.
 */
import { afterEach, describe, expect, test } from "vitest";

import { createMemoryDevtoolsBrowser, type MemoryDevtoolsBrowser } from "../devtools-relay/index.js";
import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { handleConnectTool } from "../mcp/connect-tool.js";
import { callDaemon } from "../rpc/client.js";
import { makeTempStateDir, removeStateDir, runCliWithCapture } from "./fixtures.js";

const BROWSER_URL = "http://127.0.0.1:9222";
const PAGE_URL = "https://staging.example/shop";

const daemons: RunningDaemon[] = [];
const stateDirs: string[] = [];

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.shutdown();
  while (stateDirs.length > 0) await removeStateDir(stateDirs.pop()!);
});

const start = async (tabs: { id: string; url: string; title: string }[]) => {
  const stateDir = await makeTempStateDir({}, { prefix: "appduct-devtools-" });
  stateDirs.push(stateDir);
  const browser: MemoryDevtoolsBrowser = createMemoryDevtoolsBrowser(tabs);
  const browserUrls: string[] = [];
  // One browser per spelling of the endpoint, as separate connections to the same Chrome would be.
  const browsers = new Map<string, MemoryDevtoolsBrowser>([[BROWSER_URL, browser]]);
  daemons.push(
    await startDaemon({
      stateDir,
      connectDevtoolsBrowser: (browserUrl) => {
        browserUrls.push(browserUrl);
        if (!browsers.has(browserUrl)) browsers.set(browserUrl, createMemoryDevtoolsBrowser(tabs));
        return browsers.get(browserUrl)!;
      },
    }),
  );
  return { stateDir, browser, browsers, browserUrls, call: <T>(method: string, params: unknown) => callDaemon<T>(method, params, { stateDir }) };
};

const shopTab = { id: "A1", url: `${PAGE_URL}/cart`, title: "Cart" };

describe("appduct_connect with browserUrl", () => {
  test("attaches the matching tab of the browser at browserUrl and returns the session", async () => {
    const { browser, browserUrls, call } = await start([shopTab]);

    const result = await handleConnectTool({ target: "web", url: PAGE_URL, browserUrl: BROWSER_URL }, { call });

    expect(result).toMatchObject({ attached: true, targetId: "A1", sessionId: expect.any(String) });
    expect(browserUrls).toEqual([BROWSER_URL]);
    expect(browser.attachedTargets()).toEqual(["A1"]);
  });

  test("attaches the tab with the given targetId when several tabs match url", async () => {
    const { browser, call } = await start([shopTab, { id: "B2", url: `${PAGE_URL}/orders`, title: "Orders" }]);

    const result = await handleConnectTool({ target: "web", url: PAGE_URL, browserUrl: BROWSER_URL, targetId: "B2" }, { call });

    expect(result).toMatchObject({ attached: true, targetId: "B2" });
    expect(browser.attachedTargets()).toEqual(["B2"]);
  });

  test("fails with the open tabs and their target ids when several tabs match url", async () => {
    const { call } = await start([shopTab, { id: "B2", url: `${PAGE_URL}/orders`, title: "Orders" }]);

    const failure = handleConnectTool({ target: "web", url: PAGE_URL, browserUrl: BROWSER_URL }, { call });

    await expect(failure).rejects.toThrow(/A1 {2}https:\/\/staging\.example\/shop\/cart/u);
    await expect(failure).rejects.toThrow(/B2 {2}https:\/\/staging\.example\/shop\/orders/u);
  });

  test("fails when no tab matches url", async () => {
    const { call } = await start([{ id: "Z9", url: "https://other.example/", title: "Other" }]);

    await expect(handleConnectTool({ target: "web", url: PAGE_URL, browserUrl: BROWSER_URL }, { call })).rejects.toThrow(/Z9 {2}https:\/\/other\.example\//u);
  });

  test("rejects browserUrl without target web", async () => {
    const { call } = await start([]);

    await expect(handleConnectTool({ target: "none", browserUrl: BROWSER_URL }, { call })).rejects.toThrow(/browserUrl/u);
  });

  test("rejects targetId without browserUrl", async () => {
    const { call } = await start([]);

    await expect(handleConnectTool({ target: "web", url: PAGE_URL, targetId: "A1" }, { call })).rejects.toThrow(/targetId/u);
  });

  test("returns the tab's own address, with no link payload", async () => {
    const { call } = await start([shopTab]);

    const result = await handleConnectTool({ target: "web", url: PAGE_URL, browserUrl: BROWSER_URL }, { call });

    expect(result).toMatchObject({ url: `${PAGE_URL}/cart` });
    expect(JSON.stringify(result)).not.toContain("appduct=");
  });

  test.each(["http://127.0.0.1:9222", "http://localhost:9222", "http://[::1]:9222", "http://localhost:9222/"])(
    "accepts the loopback browserUrl %s",
    async (browserUrl) => {
      const { call } = await start([shopTab]);

      await expect(handleConnectTool({ target: "web", url: PAGE_URL, browserUrl }, { call })).resolves.toMatchObject({ attached: true });
    },
  );

  test.each(["http://192.168.1.5:9222", "https://evil.example:9222", "http://127.0.0.1.evil.example:9222", "http://127.0.0.1@evil.example:9222"])(
    "rejects the non-loopback browserUrl %s without contacting it",
    async (browserUrl) => {
      const { call, browserUrls } = await start([shopTab]);

      await expect(handleConnectTool({ target: "web", url: PAGE_URL, browserUrl }, { call })).rejects.toThrow(/loopback/u);
      expect(browserUrls).toEqual([]);
    },
  );

  test("relays a tab once when it is attached under two spellings of the browserUrl", async () => {
    const { browsers, call } = await start([shopTab]);

    await handleConnectTool({ target: "web", url: PAGE_URL, browserUrl: "http://127.0.0.1:9222" }, { call });
    await handleConnectTool({ target: "web", url: PAGE_URL, browserUrl: "http://localhost:9222/" }, { call });

    expect(browsers.get("http://127.0.0.1:9222")!.attachedTargets()).toEqual([]);
    expect(browsers.get("http://localhost:9222/")!.attachedTargets()).toEqual(["A1"]);
  });

  test("rejects a browserUrl that is not http(s)", async () => {
    const { call } = await start([]);

    await expect(handleConnectTool({ target: "web", url: PAGE_URL, browserUrl: "chrome://inspect" }, { call })).rejects.toThrow(/browserUrl/u);
  });
});

describe("appduct sessions link --open web --browser-url", () => {
  const link = (stateDir: string, ...extra: string[]) =>
    runCliWithCapture(["sessions", "link", "--open", "web", PAGE_URL, ...extra, "--json", "--state-dir", stateDir]);

  test("attaches the matching tab and prints the session", async () => {
    const { stateDir, browser } = await start([shopTab]);

    const result = await link(stateDir, "--browser-url", BROWSER_URL);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ attached: true, targetId: "A1" });
    expect(browser.attachedTargets()).toEqual(["A1"]);
  });

  test("attaches the tab named by --target-id", async () => {
    const { stateDir, browser } = await start([shopTab, { id: "B2", url: `${PAGE_URL}/orders`, title: "Orders" }]);

    const result = await link(stateDir, "--browser-url", BROWSER_URL, "--target-id", "B2");

    expect(result.exitCode).toBe(0);
    expect(browser.attachedTargets()).toEqual(["B2"]);
  });

  test("lists the tabs when several match", async () => {
    const { stateDir } = await start([shopTab, { id: "B2", url: `${PAGE_URL}/orders`, title: "Orders" }]);

    const result = await link(stateDir, "--browser-url", BROWSER_URL);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/A1 {2}https:\/\/staging\.example\/shop\/cart[\s\S]*B2 {2}/u);
  });

  test("rejects --target-id without --browser-url", async () => {
    const { stateDir } = await start([shopTab]);

    const result = await link(stateDir, "--target-id", "A1");

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/--browser-url/u);
  });

  test("rejects --browser-url without --open web", async () => {
    const { stateDir } = await start([shopTab]);

    const result = await runCliWithCapture(["sessions", "link", "--browser-url", BROWSER_URL, "--json", "--state-dir", stateDir]);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/--open web/u);
  });
});
