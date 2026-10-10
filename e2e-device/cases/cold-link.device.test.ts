import { expect, test } from "vitest";

import { ids } from "../src/device.js";
import { run } from "../src/process.js";
import { deviceSuite } from "../src/suite.js";

const suite = deviceSuite();

test("a link launches the stopped app into an active session that reports the real device", async () => {
  const app = await suite.coldLink();

  const [session] = (await suite.sessions()).filter((row) => row.sessionId === app.sessionId);
  expect(session?.state).toBe("active");
  if (suite.target.platform === "ios") {
    expect(session?.device.manufacturer).toBe("Apple");
    expect(session?.device.model).toMatch(/\S/);
  } else {
    // What the device itself reports: an AOSP emulator image says "unknown" for its manufacturer.
    const prop = async (name: string) => (await run("adb", ["-s", suite.deviceId, "shell", "getprop", name])).trim();
    expect(session?.device.manufacturer).toBe(await prop("ro.product.manufacturer"));
    expect(session?.device.model).toBe(await prop("ro.product.model"));
  }

  await suite.device.press(ids.tabStatus);
  await suite.device.waitForText(ids.connectionState, "active");
});
