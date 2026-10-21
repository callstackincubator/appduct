import { describe, expect } from "e2e";

import { test } from "./fixtures.ts";

describe("a serial group", { serial: true }, () => {
  test("counts a call", async ({ app, appduct }) => {
    await app.open();
    await appduct.call("reset_counter");
    await appduct.call("sum", { a: 1, b: 1 });
  });

  test("still sees the count in the same app", async ({ appduct }) => {
    expect(await appduct.call("call_count")).toEqual({ count: 1 });
  });
});
