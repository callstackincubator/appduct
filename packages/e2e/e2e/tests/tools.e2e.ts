import { expect } from "e2e";
import { test } from "./fixtures.ts";

test("calls a tool in the running app", async ({ app, appduct }) => {
  await app.open();
  const result = await appduct.call("sum", { a: 2, b: 3 });
  expect(result).toEqual({ total: 5 });
});

test("a tool call changes what the screen shows", async ({ app, appduct, screen, platform }) => {
  await app.open();
  await appduct.call("reset_counter");
  await appduct.call("sum", { a: 1, b: 1 });
  await appduct.call("sum", { a: 1, b: 1 });
  expect(await appduct.call("call_count")).toEqual({ count: 2 });
  if (platform === "web") await expect(screen.getByText("Counted calls: 2")).toBeVisible();
  else await expect(screen.getByTestId("call-count")).toHaveText("2");
});

test("lists the registered tools", async ({ app, appduct }) => {
  await app.open();
  const names = (await appduct.tools()).map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["sum", "call_count", "reset_counter"]));
});

test("the agent calls the app's tools", async ({ app, appduct, agent }) => {
  await app.open();
  await appduct.call("reset_counter");
  await agent.act("add 2 and 3 with the app's sum tool");
  expect(await appduct.call("call_count")).toEqual({ count: 1 });
});
