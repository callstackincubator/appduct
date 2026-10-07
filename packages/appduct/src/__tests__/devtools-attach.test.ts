import { encodeBootstrap } from "@appduct/shared";
import { describe, expect, it } from "vitest";

import {
  attachBrowserTab,
  createMemoryDaemonSockets,
  createMemoryDevtoolsBrowser,
  type MemoryDaemonSockets,
  type MemoryDevtoolsBrowser,
} from "../devtools-relay/index.js";

const payload = encodeBootstrap({
  family: 4,
  address: "127.0.0.1",
  port: 49152,
  sessionId: "XzAERP54_Goh74hZ",
  token: "A".repeat(43),
  expiresAt: 2_000_000_000,
});
const mintLink = async () => ({ sessionId: "XzAERP54_Goh74hZ", url: `https://staging.example/shop#appduct=${payload}`, expiresAt: 2_000_000_000 });

const tab = (id: string, url: string) => ({ id, url, title: `Tab ${id}` });

const setup = (tabs: ReturnType<typeof tab>[]): { browser: MemoryDevtoolsBrowser; daemon: MemoryDaemonSockets } => ({
  browser: createMemoryDevtoolsBrowser(tabs),
  daemon: createMemoryDaemonSockets(),
});

const attach = (
  { browser, daemon }: ReturnType<typeof setup>,
  options: { url: string; targetId?: string; mint?: typeof mintLink },
) => attachBrowserTab({ browser, openDaemonSocket: daemon.open, mintLink: options.mint ?? mintLink, url: options.url, targetId: options.targetId });

describe("attachBrowserTab", () => {
  it("attaches the one tab whose url starts with the given url", async () => {
    const world = setup([tab("A", "https://staging.example/shop/cart"), tab("B", "https://other.example/")]);

    const result = await attach(world, { url: "https://staging.example/shop" });

    expect(result).toMatchObject({ sessionId: "XzAERP54_Goh74hZ", targetId: "A", expiresAt: 2_000_000_000 });
    expect(world.browser.attachedTargets()).toEqual(["A"]);
  });

  it("connects the page over the devtools transport with the link's payload", async () => {
    const world = setup([tab("A", "https://staging.example/shop")]);

    await attach(world, { url: "https://staging.example/shop" });

    const evaluated = world.browser.page("A").evaluated();
    expect(evaluated.at(-1)).toBe(`window.__APPDUCT__.connect(${JSON.stringify(payload)}, { transport: "devtools" })`);
  });

  it("relays the page's frames to the daemon's web listener", async () => {
    const world = setup([tab("A", "https://staging.example/shop")]);
    await attach(world, { url: "https://staging.example/shop" });

    world.browser.page("A").call({ kind: "open" });

    expect(world.daemon.sockets.map((socket) => socket.url)).toEqual(["ws://127.0.0.1:49152"]);
  });

  it("attaches the tab with the given target id even when several tabs match the url", async () => {
    const world = setup([tab("A", "https://staging.example/shop/a"), tab("B", "https://staging.example/shop/b")]);

    const result = await attach(world, { url: "https://staging.example/shop", targetId: "B" });

    expect(result.targetId).toBe("B");
    expect(world.browser.attachedTargets()).toEqual(["B"]);
  });

  it("lists the open tabs with their target ids when no tab matches the url", async () => {
    const world = setup([tab("A", "https://staging.example/a"), tab("B", "https://staging.example/b")]);

    const error = await attach(world, { url: "https://staging.example/c" }).catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no open tab/i);
    expect((error as Error).message).toContain("A  https://staging.example/a");
    expect((error as Error).message).toContain("B  https://staging.example/b");
  });

  it("lists the matching tabs with their target ids and says to pass one when several match", async () => {
    const world = setup([tab("A", "https://staging.example/shop/a"), tab("B", "https://staging.example/shop/b"), tab("C", "https://other.example/")]);

    const error = (await attach(world, { url: "https://staging.example/shop" }).catch((caught: Error) => caught)) as Error;

    expect(error.message).toContain("2 open tabs");
    expect(error.message).toContain("A  https://staging.example/shop/a");
    expect(error.message).toContain("B  https://staging.example/shop/b");
    expect(error.message).toContain("target id");
    expect(world.browser.attachedTargets()).toEqual([]);
  });

  it("rejects a target id that no open tab has, listing the open tabs", async () => {
    const world = setup([tab("A", "https://staging.example/shop")]);

    const error = (await attach(world, { url: "https://staging.example/shop", targetId: "ZZZ" }).catch((caught: Error) => caught)) as Error;

    expect(error.message).toContain("ZZZ");
    expect(error.message).toContain("A  https://staging.example/shop");
  });

  it("mints no link when the tab cannot be picked", async () => {
    const world = setup([]);
    let minted = 0;

    await attach(world, { url: "https://staging.example/shop", mint: async () => (minted += 1, mintLink()) }).catch(() => undefined);

    expect(minted).toBe(0);
  });

  it("fails when the page does not load @appduct/web", async () => {
    const world = setup([tab("A", "https://staging.example/shop")]);
    world.browser.page("A").failEvaluate(/connect === 'function'/u, new Error("timed out"));

    const error = (await attach(world, { url: "https://staging.example/shop" }).catch((caught: Error) => caught)) as Error;

    expect(error.message).toContain("@appduct/web");
  });
});
