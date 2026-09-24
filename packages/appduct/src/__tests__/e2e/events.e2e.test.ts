/**
 * E2E scenario: events. `appduct events tail --json` streams NDJSON; this drives the full session
 * lifecycle (claim, tool registration, an app event, a tool call, a second app event) through a real
 * CLI subprocess and fake app client and asserts the subscriber prints the app's own events only.
 */

import { afterEach, describe, expect, test } from "vitest";

import { FakeAppClient } from "./app-client.js";
import {
  daemonWssPort,
  cleanupAfterEach,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  runCliJson,
  spawnCli,
  waitForExit,
} from "./harness.js";

afterEach(cleanupAfterEach);

type CapturedLine = { kind: string; sessionId?: string; alias?: string; ts: string; data: unknown };

/** Reads NDJSON lines from a spawned `events tail --json` subprocess's stdout as they arrive. */
const collectLines = (proc: ReturnType<typeof spawnCli>): { lines: CapturedLine[]; stop: () => void } => {
  const lines: CapturedLine[] = [];
  let buffered = "";
  let stopped = false;

  (async () => {
    for await (const chunk of proc.stdout) {
      if (stopped) {
        return;
      }

      buffered += Buffer.from(chunk).toString("utf8");
      let newlineIndex = buffered.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");

        if (line.length > 0) {
          const parsed = JSON.parse(line) as CapturedLine;
          expect(parsed).toHaveProperty("kind");
          expect(parsed).toHaveProperty("ts");
          lines.push(parsed);
        }
      }
    }
  })();

  return { lines, stop: () => (stopped = true) };
};

/** Polls `lines` until `count` of them are `app_event`, or throws after `timeoutMs`. */
const waitForAppEventLines = async (lines: CapturedLine[], count: number, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (lines.filter((line) => line.kind === "app_event").length < count) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} app_event lines. Seen: ${JSON.stringify(lines.map((l) => l.kind))}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("e2e: events tail --json", () => {
  test(
    "prints only the app's own events across claim, tool registration and a tool call",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
      // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
      const port = await daemonWssPort(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const eventsProcess = spawnCli(["events", "tail", "--json"], stateDir);
      const { lines, stop } = collectLines(eventsProcess);

      // The subscriber must be attached before the claim fires, or the lifecycle events this test
      // proves are hidden would never have been sent to it; there is no stdout signal for
      // "subscribed", so a short settle window is unavoidable here — matching the accepted
      // precedent in events.integration.test.ts.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8" });
      const alias = ack.alias;

      app.registerTools([{ name: "echo" }]);
      app.emitEvent("first", { n: 1 });
      await waitForAppEventLines(lines, 1);

      app.answerCalls(() => ({ result: "ok" }));
      const invokeResult = await runCliJson(["tools", "call", alias, "echo", "--input", "{}"], stateDir);
      expect(invokeResult.ok).toBe(true);

      app.emitEvent("second", { n: 2 });
      await waitForAppEventLines(lines, 2);

      expect(lines.map((line) => line.kind)).toEqual(["app_event", "app_event"]);
      expect(lines.map((line) => (line.data as { name: string }).name)).toEqual(["first", "second"]);

      stop();
      eventsProcess.kill("SIGINT");
      const exitCode = await waitForExit(eventsProcess);
      expect(exitCode).toBe(0);
    },
    20_000,
  );
});
