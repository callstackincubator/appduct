import { expect, test } from "vitest";

import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("going home suspends the session as backgrounded, and reopening resumes the same session", async () => {
  const app = await suite.coldLink();
  await expect(app.call("reset_counter", {})).resolves.toEqual({ count: 0 });

  await suite.device.home();
  if (suite.target.backgroundWindow) {
    // The Swift core holds the socket open for the background time iOS grants (about 30 s).
    await expect(app.call("sum", { a: 1, b: 2 })).resolves.toEqual({ total: 3 });
  }
  await suite.waitForSessionState(
    app.sessionId,
    "suspended as app_backgrounded",
    (session) => session.state === "suspended" && session.suspendReason === "app_backgrounded",
    suite.target.backgroundWindow ? 90_000 : 15_000,
  );
  await expect(app.call("call_count", {})).rejects.toMatchObject({ type: "session_suspended" });

  await suite.device.foreground();
  await suite.waitForSessionState(app.sessionId, "active again", (session) => session.state === "active");
  await expect(app.call("call_count", {})).resolves.toEqual({ count: suite.target.backgroundWindow ? 1 : 0 });
  const active = (await suite.sessions()).filter((session) => session.state === "active");
  expect(active.map((session) => session.sessionId)).toEqual([app.sessionId]);
});
