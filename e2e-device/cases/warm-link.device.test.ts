import { expect, test } from "vitest";

import { ids } from "../src/device.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("a second link into the running app replaces its session and suspends the first", async () => {
  const first = await suite.coldLink();
  const second = await suite.link();

  expect(second.sessionId).not.toBe(first.sessionId);
  await suite.waitForSessionState(first.sessionId, "suspended", (session) => session.state === "suspended");
  const active = (await suite.sessions()).filter((session) => session.state === "active");
  expect(active.map((session) => session.sessionId)).toEqual([second.sessionId]);
  await expect(second.call("call_count", {})).resolves.toEqual({ count: expect.any(Number) });
});

test("a second link leaves the app on the screen it was showing", async (context) => {
  if (suite.target.name.startsWith("expo")) {
    return context.skip("#235: an Appduct link sends an Expo Router app to its root route");
  }
  await suite.coldLink();
  await suite.device.press(ids.tabStatus);
  await suite.device.waitForText(ids.connectionState, "active");

  await suite.link();

  // A router acts on the URL after the session is claimed, so wait for it before reading.
  await suite.device.waitForStable();
  expect(await suite.device.text(ids.connectionState)).toBe("active");
  expect(await suite.device.text(ids.callCount)).toBeUndefined();
});
