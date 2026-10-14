import { expect, test } from "vitest";

import { ids } from "../src/device.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("a killed app relaunched without a link stays idle, and a new link connects it", async () => {
  const first = await suite.coldLink();

  await suite.device.terminate();
  await suite.waitForSessionState(first.sessionId, "suspended", (session) => session.state === "suspended");

  // Resume credentials live only in process memory, so the relaunched app has nothing to resume.
  await suite.device.foreground();
  await suite.device.press(ids.tabStatus);
  await suite.device.waitForText(ids.connectionState, "idle", 120_000);
  expect((await suite.sessions()).filter((session) => session.state === "active")).toEqual([]);

  const second = await suite.link();
  // warm-link checks that a link keeps the screen; here only the state matters.
  await suite.device.press(ids.tabStatus);
  await suite.device.waitForText(ids.connectionState, "active");
  const rows = await suite.sessions();
  expect(rows.filter((session) => session.state === "active").map((session) => session.sessionId)).toEqual([second.sessionId]);
  expect(rows.find((session) => session.sessionId === first.sessionId)?.state).toBe("suspended");
});
