import { describe, expect, test } from "vitest";

import { encodeBootstrap } from "@appduct/shared";

import { appductClient, connect, parseBootstrapPayload, restoreSession } from "../index.web";

/** Vitest runs in Node: no `window`, like a server-side render of a React Native web app. */
describe("@appduct/react-native on web without a browser", () => {
  test("restoreSession resolves false: there is no session to resume", async () => {
    await expect(restoreSession()).resolves.toBe(false);
    await expect(appductClient.restoreSession()).resolves.toBe(false);
  });

  test("connect with a decoded bootstrap payload rejects, saying a browser is needed", async () => {
    const link = encodeBootstrap({
      family: 4,
      address: "127.0.0.1",
      port: 49152,
      sessionId: "s".repeat(22),
      token: "A".repeat(43),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    await expect(connect(parseBootstrapPayload(link))).rejects.toThrow(/browser/iu);
  });
});
