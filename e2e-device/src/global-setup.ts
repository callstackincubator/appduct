import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";

import type { TestProject } from "vitest/node";

import { install } from "./device.js";
import { logFile, run, runSteps, until } from "./process.js";
import { targetNamed, type Target } from "./targets.js";

/**
 * Runs once per suite run: picks and boots the device, builds and installs the playground (skip
 * the build with APPDUCT_E2E_SKIP_BUILD=1), and starts Metro for an Expo target. The cases get
 * the target and device id through `inject`.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const target = targetNamed(process.env.APPDUCT_E2E_TARGET);
  const deviceId = target.platform === "ios" ? await bootSimulator() : await emulatorSerial();
  const artifact = path.join(target.dir, target.artifact);

  if (process.env.APPDUCT_E2E_SKIP_BUILD !== "1") {
    await runSteps(target.dir, target.build(deviceId), logFile(`build-${target.name}`));
  } else if (!existsSync(artifact)) {
    throw new Error(`APPDUCT_E2E_SKIP_BUILD is set but ${artifact} doesn't exist. Run once without it.`);
  }
  await install(target, deviceId, artifact);
  const stopMetro = target.metro ? await startMetro(target, deviceId) : undefined;

  project.provide("target", target.name);
  project.provide("deviceId", deviceId);
  return async () => {
    stopMetro?.();
  };
}

/** APPDUCT_E2E_DEVICE, or the first available iPhone on the newest iOS runtime; booted. */
const bootSimulator = async (): Promise<string> => {
  let udid = process.env.APPDUCT_E2E_DEVICE;
  if (!udid) {
    const { devices } = JSON.parse(await run("xcrun", ["simctl", "list", "devices", "available", "-j"])) as {
      devices: Record<string, Array<{ udid: string; name: string }>>;
    };
    const runtimes = Object.keys(devices)
      .filter((runtime) => runtime.includes(".iOS-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    udid = runtimes.flatMap((runtime) => devices[runtime] ?? []).find((device) => device.name.startsWith("iPhone"))?.udid;
    if (!udid) {
      throw new Error("No available iPhone simulator. Create one in Xcode or set APPDUCT_E2E_DEVICE to a udid.");
    }
  }
  await run("xcrun", ["simctl", "boot", udid]).catch(() => {
    // Already booted.
  });
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs: 180_000 });
  return udid;
};

/** APPDUCT_E2E_DEVICE, or the one running emulator. */
const emulatorSerial = async (): Promise<string> => {
  if (process.env.APPDUCT_E2E_DEVICE) {
    return process.env.APPDUCT_E2E_DEVICE;
  }
  const serials = (await run("adb", ["devices"]))
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device")
    .map(([serial]) => serial as string);
  if (serials.length !== 1) {
    throw new Error(
      `Found ${serials.length} running emulators; start exactly one (emulator -avd <name>) or set APPDUCT_E2E_DEVICE to its serial.`,
    );
  }
  return serials[0] as string;
};

/** Starts Metro on 8081 for this checkout's playground and returns how to stop it. Refuses a
 * Metro that is already running, which could be serving another checkout's JS. */
const startMetro = async (target: Target, deviceId: string): Promise<() => void> => {
  const status = () =>
    fetch("http://localhost:8081/status")
      .then((response) => response.text())
      .catch(() => undefined);
  if (await status()) {
    throw new Error("Something already listens on port 8081. Stop it: the suite starts its own Metro for this checkout.");
  }
  const log = createWriteStream(logFile(`metro-${target.name}`));
  const metro = spawn("pnpm", ["exec", "expo", "start", "--port", "8081"], {
    cwd: target.dir,
    env: { ...process.env, EXPO_NO_TELEMETRY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  metro.stdout.pipe(log);
  metro.stderr.pipe(log);
  const stop = () => {
    if (metro.pid) {
      process.kill(-metro.pid, "SIGTERM");
    }
  };
  try {
    await until(async () => ((await status())?.includes("running") ? true : undefined), "Metro to answer on port 8081", 120_000);
    if (target.platform === "android") {
      await run("adb", ["-s", deviceId, "reverse", "tcp:8081", "tcp:8081"]);
    }
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
};
