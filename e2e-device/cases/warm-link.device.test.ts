import { expect, test } from "vitest";

import { ids } from "../src/device.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("a second link into the running app replaces its session, suspends the first and keeps the screen", async () => {
  const first = await suite.coldLink();
  await suite.device.press(ids.tabStatus);
  await suite.device.waitForText(ids.connectionState, "active");

  const second = await suite.link();

  expect(second.sessionId).not.toBe(first.sessionId);
  await suite.waitForSessionState(first.sessionId, "suspended", (session) => session.state === "suspended");
  const active = (await suite.sessions()).filter((session) => session.state === "active");
  expect(active.map((session) => session.sessionId)).toEqual([second.sessionId]);

  await expect(second.call("call_count", {})).resolves.toEqual({ count: expect.any(Number) });
  // The state shows only on the Status screen, so reading it also proves the link left the app
  // where it was.
  await suite.device.waitForText(ids.connectionState, "active");
});
