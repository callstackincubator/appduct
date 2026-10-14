import { expect, test } from "vitest";

import { ids } from "../src/device.js";
import { until } from "../src/process.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("a press on the ping button reaches the test as a playground_ping event", async () => {
  const app = await suite.coldLink();

  // The app declares its event after it claims the session, like its tools.
  const declared = await until(async () => {
    const listed = await suite.cli<{ total: number; events: unknown[] }>(["events", "ls", app.sessionId]);
    return listed.ok && listed.data.total > 0 ? listed.data.events : undefined;
  }, "the app to declare playground_ping");
  expect(declared).toMatchObject([
    {
      name: "playground_ping",
      description: "The Send playground_ping button on the Status screen was pressed.",
      payload_schema: { type: "object", properties: { at: { type: "number" } }, required: ["at"] },
    },
  ]);

  const { cursor } = await app.events();
  await suite.device.press(ids.tabStatus);
  await suite.device.waitForText(ids.lastPing, "none");
  await suite.device.press(ids.pingButton);

  const event = await app.waitForEvent("playground_ping", { since: cursor, timeoutMs: 15_000 });
  const { at } = event.payload as { at: number };
  expect(at).toBeGreaterThan(Date.now() - 60_000);
  await suite.device.waitForText(ids.lastPing, String(at));
});
