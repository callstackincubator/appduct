import path from "node:path";

import { expect, test } from "vitest";

import { install } from "../src/device.js";
import { logFile, runSteps } from "../src/process.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("an opted-in release build connects and answers calls", async (context) => {
  if (process.env.APPDUCT_E2E_RELEASE !== "1") {
    return context.skip("set APPDUCT_E2E_RELEASE=1 to build and test the release variant");
  }
  const { target, deviceId } = suite;
  const release = target.release;
  if (!release) {
    return context.skip(`${target.name} has no opted-in release build`);
  }

  await runSteps(target.dir, release.build, logFile(`build-release-${target.name}`));
  await install(target, deviceId, path.join(target.dir, release.artifact));
  try {
    const app = await suite.coldLink();
    await expect(app.call("sum", { a: 1, b: 2 })).resolves.toEqual({ total: 3 });
  } finally {
    // The cases after this one expect the debug build.
    await install(target, deviceId, path.join(target.dir, target.artifact));
  }
});
