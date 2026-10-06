import { describe, expect, test } from "vitest";

import { createAppduct, type AppductCore } from "../index.js";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

const createRecordingCore = () => {
  const registered: string[] = [];
  const core = {
    registerTool: (descriptorJson: string) => {
      registered.push(descriptorJson);
    },
    unregisterTool: () => {},
    registerEvent: () => {},
    unregisterEvent: () => {},
    handleUrl: () => false,
    connect: async () => {},
    restoreSession: async () => false,
    disconnect: async () => {},
    postEvent: async () => {},
    respondToToolCall: () => {},
    reportToolProgress: () => {},
    getState: () => "idle",
    getSessionId: () => null,
    getRegisteredToolsJson: () => "[]",
    addListener: () => ({ remove() {} }),
  } satisfies AppductCore;
  return { core, registered };
};

describe("createAppduct", () => {
  test("returns a client that registers tools on the given core", () => {
    const { core, registered } = createRecordingCore();
    const { client } = createAppduct(core);

    client.registerTool({
      name: "ping",
      description: "Ping.",
      handler: () => "pong",
    });

    expect(registered.map((json) => JSON.parse(json).name)).toEqual(["ping"]);
  });
});
