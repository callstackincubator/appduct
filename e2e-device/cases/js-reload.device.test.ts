import { expect, test } from "vitest";

import { ids } from "../src/device.js";
import { until } from "../src/process.js";
import { linkReloadable } from "../src/reload.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("a reload resumes the same session with fresh app state and no new link", async (context) => {
  if (!suite.target.reload) {
    return context.skip("the native playgrounds have no JS or Dart state to restart in place");
  }
  const { app, reload, stop } = await linkReloadable(suite);
  try {
    await expect(app.call("reset_counter", {})).resolves.toEqual({ count: 0 });
    await expect(app.call("sum", { a: 1, b: 2 })).resolves.toEqual({ total: 3 });
    await suite.device.waitForText(ids.callCount, "1");

    await reload();

    // Only a restarted JS or Dart runtime can read 0 here.
    await suite.device.waitForText(ids.callCount, "0");
    const answer = await until(() => app.call("call_count", {}).catch(() => undefined), "the session to answer again", 30_000);
    expect(answer).toEqual({ count: 0 });
    const active = (await suite.sessions()).filter((session) => session.state === "active");
    expect(active.map((session) => session.sessionId)).toEqual([app.sessionId]);
  } finally {
    await stop();
  }
});
