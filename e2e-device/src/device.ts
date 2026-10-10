import { createAgentDeviceClient } from "agent-device";

import { run, until } from "./process.js";
import type { Target } from "./targets.js";

/** The ids #227 gives every playground. Each element holds only its value. */
export const ids = {
  tabTools: "tab-tools",
  tabStatus: "tab-status",
  callCount: "call-count",
  connectionState: "connection-state",
  pingButton: "ping-button",
  lastPing: "last-ping",
} as const;

export type ElementId = (typeof ids)[keyof typeof ids];

/** Installs an app build, replacing any installed build with the same id. */
export const install = async (target: Target, deviceId: string, artifact: string): Promise<void> => {
  if (target.platform === "ios") {
    await run("xcrun", ["simctl", "install", deviceId, artifact], { timeoutMs: 180_000 });
  } else {
    await run("adb", ["-s", deviceId, "install", "-r", artifact], { timeoutMs: 180_000 });
  }
};

/** The playground's app on one simulator or emulator: lifecycle through `simctl` and `adb`, and
 * the screen through agent-device, read and pressed by the ids above. */
export type Device = ReturnType<typeof openDevice>;

export const openDevice = (target: Target, deviceId: string) => {
  const agent = createAgentDeviceClient({ session: `appduct-e2e-${target.name}-${process.pid}` });
  const where = target.platform === "ios" ? ({ platform: "ios", udid: deviceId } as const) : ({ platform: "android", serial: deviceId } as const);
  const selector = (id: ElementId) => `id="${id}"`;

  // agent-device reads and presses only inside a session it opened on the app. Opening one also
  // brings the app to the foreground, which every read and press needs anyway.
  let opened = false;
  const foreground = async (): Promise<void> => {
    await agent.apps.open({ ...where, app: target.appId });
    opened = true;
  };
  const session = async (): Promise<void> => {
    if (!opened) {
      await foreground();
    }
  };

  const text = async (id: ElementId): Promise<string | undefined> => {
    await session();
    try {
      const result = (await agent.interactions.get({ ...where, selector: selector(id), format: "text" })) as { text?: string };
      return result.text;
    } catch {
      // Not on screen (yet): the element is missing from the accessibility tree.
      return undefined;
    }
  };

  return {
    /** Ends the app's process. */
    terminate: async (): Promise<void> => {
      if (target.platform === "ios") {
        await run("xcrun", ["simctl", "terminate", deviceId, target.appId]).catch(() => {
          // simctl fails when the app isn't running, which is the state we want.
        });
      } else {
        await run("adb", ["-s", deviceId, "shell", "am", "force-stop", target.appId]);
      }
    },

    /** Brings the app to the foreground, launching it with no link when it isn't running. */
    foreground,

    /** Sends the device to its home screen; the app keeps running in the background. */
    home: async (): Promise<void> => {
      await session();
      await agent.command.home(where);
    },

    /** Opens a URL the way a tap on a link would. */
    openUrl: async (url: string): Promise<void> => {
      if (target.platform === "ios") {
        await run("xcrun", ["simctl", "openurl", deviceId, url]);
      } else {
        await run("adb", ["-s", deviceId, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url]);
      }
    },

    /** Presses the element once it is on screen, which on a fresh launch can take a while. */
    press: async (id: ElementId): Promise<void> => {
      await session();
      await agent.command.wait({ ...where, selector: selector(id), timeoutMs: 120_000 });
      await agent.interactions.press({ ...where, selector: selector(id) });
    },

    /** The element's value as accessibility reads it, or `undefined` when it isn't on screen. */
    text,

    /** Waits until the element reads `value`, and fails with the last value it read. */
    waitForText: async (id: ElementId, value: string, timeoutMs = 30_000): Promise<void> => {
      let last: string | undefined;
      await until(
        async () => {
          last = await text(id);
          return last === value ? true : undefined;
        },
        `${id} to read "${value}"`,
        timeoutMs,
      ).catch((error: Error) => {
        throw new Error(`${error.message} It last read ${last === undefined ? "nothing (not on screen)" : `"${last}"`}.`);
      });
    },

    /** Ends the agent-device session. The app keeps running. */
    close: async (): Promise<void> => {
      await agent.sessions.close().catch(() => {
        // No session was ever opened: nothing to close.
      });
    },
  };
};
