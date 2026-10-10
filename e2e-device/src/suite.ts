import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { link as mintLink, waitForSession, type AppClient } from "appduct/client";
import { afterAll, afterEach, beforeAll, inject } from "vitest";

import { appduct, sessions, type Session } from "./cli.js";
import { openDevice } from "./device.js";
import { until } from "./process.js";
import { targetNamed } from "./targets.js";

declare module "vitest" {
  export interface ProvidedContext {
    target: string;
    deviceId: string;
  }
}

/** The five tools #227 gives every playground, typed for `app.call`. */
export type PlaygroundTools = {
  sum: { args: { a: number; b: number }; result: { total: number } };
  call_count: { args: Record<string, never>; result: { count: number } };
  reset_counter: { args: Record<string, never>; result: { count: number } };
  slow_task: { args: Record<string, never>; result: { done: boolean } };
  throwing_tool: { args: Record<string, never>; result: unknown };
};

export type Playground = AppClient<PlaygroundTools>;

const PLAYGROUND_TOOLS: Array<keyof PlaygroundTools> = ["sum", "call_count", "reset_counter", "slow_task", "throwing_tool"];

/**
 * Sets up one case file: the target and device global setup chose, a daemon of its own in a
 * fresh state dir (stopped after the file), and the agent-device session. Call it once at the
 * top of the file.
 */
export const deviceSuite = () => {
  const target = targetNamed(inject("target"));
  const deviceId = inject("deviceId");
  const device = openDevice(target, deviceId);
  const clients: Playground[] = [];
  let stateDir = "";

  beforeAll(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), `appduct-e2e-${target.name}-`));
    writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ wssPort: 0 }));
  });
  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });
  afterAll(async () => {
    await device.close();
    await appduct(stateDir, ["daemon", "stop"]);
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** Mints a link, delivers it to the app (launching the app when it isn't running) and waits
   * for the session the app claims. */
  const link = async (): Promise<Playground> => {
    const { sessionId } = await mintLink({
      stateDir,
      target: target.platform === "ios" ? "ios-sim" : "android",
      device: deviceId,
      cwd: target.dir,
    });
    // Metro bundles the JS on an Expo app's first launch, which takes the longest.
    const client = await waitForSession<PlaygroundTools>(sessionId, { stateDir, timeoutMs: 120_000 });
    clients.push(client);
    // The app claims the session first and registers its tools after (React Native registers them
    // in effects), so a call made the moment the session is claimed can find no tool.
    await until(
      async () => {
        const names = new Set((await client.tools()).map((tool) => tool.name));
        return PLAYGROUND_TOOLS.every((name) => names.has(name)) ? true : undefined;
      },
      `session ${sessionId} to register the five playground tools`,
    );
    return client;
  };

  /** Waits until `sessions ls` shows the session in the state `matches` describes. */
  const waitForSessionState = (sessionId: string, description: string, matches: (session: Session) => boolean, timeoutMs = 30_000) =>
    until(
      async () => (await sessions(stateDir)).find((session) => session.sessionId === sessionId && matches(session)),
      `session ${sessionId} to be ${description}`,
      timeoutMs,
    );

  return {
    target,
    deviceId,
    device,
    get stateDir() {
      return stateDir;
    },
    link,
    /** Kills the app, then links it, so the case starts from a fresh process. */
    coldLink: async (): Promise<Playground> => {
      await device.terminate();
      return link();
    },
    sessions: () => sessions(stateDir),
    waitForSessionState,
    cli: <T>(args: string[]) => appduct<T>(stateDir, args),
  };
};

export type DeviceSuite = ReturnType<typeof deviceSuite>;
