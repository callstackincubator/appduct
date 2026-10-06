import { describe, expect, it } from "vitest";

/** Vitest runs in Node: no `window`, `location` or `sessionStorage`, like a server-side render. */
describe("importing @appduct/web where there is no browser", () => {
  it("does nothing: registering a tool or an event returns a disposer and does not throw", async () => {
    const web = await import("../index.js");

    const tool = web.registerTool({ name: "noop", description: "Never registered.", handler: () => ({}) });
    const event = web.registerEvent({ name: "noop_event", description: "Never declared." });

    expect(() => tool.remove()).not.toThrow();
    expect(() => event.remove()).not.toThrow();
    await expect(web.postEvent("noop_event")).resolves.toBeUndefined();
  });

  it("refuses to connect, saying a browser is needed", async () => {
    const web = await import("../index.js");
    await expect(web.connect("anything")).rejects.toThrow(/browser/iu);
  });

  it("exposes useAppductTool from @appduct/web/react without a browser", async () => {
    const react = await import("../react/index.js");
    expect(typeof react.useAppductTool).toBe("function");
  });
});
