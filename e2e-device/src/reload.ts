import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

import { logFile, until } from "./process.js";
import type { DeviceSuite, Playground } from "./suite.js";

export type Reloadable = {
  app: Playground;
  /** Restarts the app's JS or Dart state in place, keeping its native process. Resolves once
   * the restart is under way: once Metro has the request, or once `flutter run` reports it. */
  reload: () => Promise<void>;
  stop: () => Promise<void>;
};

/** Launches the app so it can restart in place, and links it. Expo reloads through Metro, which
 * already serves it. Flutter hot-restarts only under `flutter run`, so this starts one. Both
 * restart within milliseconds of `reload()`, so a case can land the restart mid-call. */
export const linkReloadable = async (suite: DeviceSuite): Promise<Reloadable> => {
  if (suite.target.reload === "metro") {
    const app = await suite.coldLink();
    // Metro broadcasts a reload sent on its message socket to the app. The socket is opened up
    // front: connecting on demand can take over a second, longer than slow_task runs.
    const socket = new WebSocket("ws://localhost:8081/message");
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Couldn't open Metro's message socket on port 8081.")), { once: true });
    });
    return {
      app,
      reload: async () => socket.send(JSON.stringify({ version: 2, method: "reload" })),
      stop: async () => socket.close(),
    };
  }
  if (suite.target.reload !== "flutter") {
    throw new Error(`${suite.target.name} can't restart in place.`);
  }

  await suite.device.terminate();
  let output = "";
  const log = createWriteStream(logFile(`flutter-run-${suite.target.name}`));
  // stdin stays an open pipe: `flutter run` quits when its stdin closes.
  const flutter = spawn("flutter", ["run", "-d", suite.deviceId, "--debug"], {
    cwd: suite.target.dir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer) => {
    output += chunk;
    log.write(chunk);
  };
  flutter.stdout.on("data", collect);
  flutter.stderr.on("data", collect);
  const exited = new Promise<void>((resolve) => flutter.on("exit", () => resolve()));
  const count = (line: string) => output.split(line).length - 1;
  const stop = async () => {
    flutter.stdin.write("q");
    flutter.kill("SIGTERM");
    await exited;
  };

  try {
    await until(async () => (output.includes("Flutter run key commands") ? true : undefined), "flutter run to start the app", 600_000);
    const app = await suite.link();
    const reload = async () => {
      const restarts = count("Restarted application");
      flutter.stdin.write("R");
      await until(async () => (count("Restarted application") > restarts ? true : undefined), "the hot restart to finish", 60_000);
    };
    return { app, reload, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};
