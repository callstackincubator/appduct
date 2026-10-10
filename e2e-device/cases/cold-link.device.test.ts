import { expect, test } from "vitest";

import { ids } from "../src/device.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("a link launches the stopped app into an active session that reports the real device", async () => {
  const app = await suite.coldLink();

  const [session] = (await suite.sessions()).filter((row) => row.sessionId === app.sessionId);
  expect(session?.state).toBe("active");
  expect(session?.device.manufacturer).toBe(suite.target.platform === "ios" ? "Apple" : "Google");
  expect(session?.device.model).toMatch(/\S/);
  expect(session?.alias).not.toMatch(/unknown/i);

  await suite.device.press(ids.tabStatus);
  await suite.device.waitForText(ids.connectionState, "active");
  await suite.device.waitForText(ids.sessionAlias, session?.alias ?? "");
});
