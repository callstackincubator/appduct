import { describe, expect, it } from "vitest";

import { createInertAppduct } from "../inert/index.js";

const setup = () => {
  const warnings: string[] = [];
  return { appduct: createInertAppduct({ warn: (message) => warnings.push(message) }), warnings };
};

const tool = {
  name: "add",
  description: "Add two numbers.",
  handler: () => ({}),
};

describe("the inert @appduct/web entry", () => {
  it("accepts tools and events and returns a disposer that does nothing", () => {
    const { appduct } = setup();
    const toolHandle = appduct.registerTool(tool);
    const eventHandle = appduct.registerEvent({ name: "saved", description: "A document was saved." });
    expect(() => toolHandle.remove()).not.toThrow();
    expect(() => eventHandle.remove()).not.toThrow();
  });

  it("posts and disconnects without doing anything", async () => {
    const { appduct } = setup();
    await expect(appduct.postEvent("saved", { id: 1 })).resolves.toBeUndefined();
    await expect(appduct.disconnect()).resolves.toBeUndefined();
  });

  it("does not warn on registerTool, registerEvent, postEvent or disconnect", async () => {
    const { appduct, warnings } = setup();
    appduct.registerTool(tool);
    appduct.registerEvent({ name: "saved", description: "A document was saved." });
    await appduct.postEvent("saved");
    await appduct.disconnect();
    expect(warnings).toEqual([]);
  });

  it("warns on connect, naming the development condition and @appduct/web/enabled", async () => {
    const { appduct, warnings } = setup();
    await appduct.connect("any-link");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("development");
    expect(warnings[0]).toContain("@appduct/web/enabled");
  });

  it("warns only once however many times connect is called", async () => {
    const { appduct, warnings } = setup();
    await appduct.connect("a");
    await appduct.connect("b");
    expect(warnings).toHaveLength(1);
  });

  it("warns when connect is called on appductClient, which is what React Native web calls", async () => {
    const { appduct, warnings } = setup();
    await appduct.appductClient.connect("any-link");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@appduct/web/enabled");
  });

  it("warns when connect is called on appductCore", async () => {
    const { appduct, warnings } = setup();
    await appduct.appductCore.connect("any-link");
    expect(warnings).toHaveLength(1);
  });

  it("warns once in total across connect, appductClient.connect and appductCore.connect", async () => {
    const { appduct, warnings } = setup();
    await appduct.connect("a");
    await appduct.appductClient.connect("b");
    await appduct.appductCore.connect("c");
    expect(warnings).toHaveLength(1);
  });

  it("answers the read calls with nothing: no tools, an idle state, no session", () => {
    const { appduct } = setup();
    expect(appduct.getRegisteredTools()).toEqual([]);
    expect(appduct.getAppductState()).toBe("idle");
    expect(appduct.appductClient.getSessionId()).toBeNull();
    expect(() => appduct.addAppductListener("stateChange", () => {}).remove()).not.toThrow();
  });
});
