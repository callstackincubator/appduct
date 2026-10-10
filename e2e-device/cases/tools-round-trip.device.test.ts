import { expect, test } from "vitest";

import { ids } from "../src/device.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("the five tools answer as the contract says and the counter on screen follows them", async () => {
  const app = await suite.coldLink();

  const tools = await app.tools();
  expect(
    tools.map(({ name, group, annotations }) => ({ name, group, annotations: annotations ?? {} })).sort((a, b) => a.name.localeCompare(b.name)),
  ).toEqual([
    { name: "call_count", group: "counter", annotations: { readOnlyHint: true } },
    { name: "reset_counter", group: "counter", annotations: { destructiveHint: true, idempotentHint: true } },
    { name: "slow_task", group: "diagnostics/progress", annotations: {} },
    { name: "sum", group: null, annotations: {} },
    { name: "throwing_tool", group: "diagnostics", annotations: { readOnlyHint: true } },
  ]);

  await expect(app.call("reset_counter", {})).resolves.toEqual({ count: 0 });
  await expect(app.call("sum", { a: 1.5, b: 2 })).resolves.toEqual({ total: 3.5 });
  await expect(app.call("sum", { a: 1, b: 2 })).resolves.toEqual({ total: 3 });
  await expect(app.call("sum", { a: -4, b: 4 })).resolves.toEqual({ total: 0 });
  await expect(app.call("call_count", {})).resolves.toEqual({ count: 3 });
  await suite.device.waitForText(ids.callCount, "3");

  await expect(app.call("slow_task", {})).resolves.toEqual({ done: true });
  await expect(app.call("call_count", {})).resolves.toEqual({ count: 4 });
  await suite.device.waitForText(ids.callCount, "4");

  await expect(app.call("throwing_tool", {})).rejects.toMatchObject({
    type: "tool_execution_error",
    message: expect.stringContaining("throwing_tool always fails on purpose."),
  });
  await expect(app.call("call_count", {})).resolves.toEqual({ count: 4 });
  const [session] = (await suite.sessions()).filter((row) => row.sessionId === app.sessionId);
  expect(session?.state).toBe("active");
});
