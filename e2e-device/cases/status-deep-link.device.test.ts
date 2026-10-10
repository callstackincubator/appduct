import { expect, test } from "vitest";

import { ids } from "../src/device.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("the status deep link opens the Status screen and leaves the session active", async (context) => {
  if (!suite.target.statusDeepLink) {
    return context.skip("the Android core drops links that aren't Appduct links, so #227 exempts Android native");
  }
  const app = await suite.coldLink();
  await suite.device.waitForText(ids.callCount, "0");
  expect(await suite.device.text(ids.connectionState)).toBeUndefined();

  await suite.device.openUrl(`${suite.target.scheme}:///status`);

  await suite.device.waitForText(ids.connectionState, "active");
  const active = (await suite.sessions()).filter((session) => session.state === "active");
  expect(active.map((session) => session.sessionId)).toEqual([app.sessionId]);
  await expect(app.call("call_count", {})).resolves.toEqual({ count: 0 });
});
