/**
 * E2E scenario: `appduct events ls` lists what a fake app declared over the wire, through a real
 * CLI subprocess.
 */

import { text } from "node:stream/consumers";

import { afterEach, describe, expect, test } from "vitest";

import { FakeAppClient } from "./app-client.js";
import {
  cleanupAfterEach,
  daemonWssPort,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  runCliJson,
  spawnCli,
  waitForExit,
  waitUntil,
} from "./harness.js";

afterEach(cleanupAfterEach);

const checkout = {
  name: "checkout_completed",
  description: "Fired once an order finishes checkout.",
  payload_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
};
const itemAdded = { name: "cart.item_added", description: "An item went into the cart." };
const itemRemoved = { name: "cart.item_removed", description: "An item left the cart." };

const runCliText = async (args: string[], stateDir: string): Promise<{ stdout: string; exitCode: number }> => {
  const proc = spawnCli(args, stateDir);
  const [stdout] = await Promise.all([text(proc.stdout), text(proc.stderr)]);
  return { stdout, exitCode: await waitForExit(proc) };
};

const connectApp = async (stateDir: string): Promise<FakeAppClient> => {
  await ensureDaemon(stateDir);
  const app = new FakeAppClient(await daemonWssPort(stateDir), await fetchPinnedKeys(stateDir));
  await app.claim(await mintLink(stateDir), { model: "Pixel 8" });
  return app;
};

/** The event frames are fire-and-forget, so poll `events ls` until the daemon has caught up. */
const waitForTotal = (stateDir: string, total: number): Promise<void> => {
  return waitUntil(async () => {
    const listed = await runCliJson<{ total: number }>(["events", "ls"], stateDir);
    return listed.data?.total === total;
  });
};

describe("e2e: events ls", () => {
  test(
    "prints one signature line per declared event, narrows with --name, and prints the schema for an exact name",
    async () => {
      const { stateDir } = await makeTempStateDir();
      const app = await connectApp(stateDir);
      app.declareEvents([checkout, itemAdded, itemRemoved]);
      await waitForTotal(stateDir, 3);

      const all = await runCliText(["events", "ls"], stateDir);
      expect(all.exitCode).toBe(0);
      expect(all.stdout).toContain("cart.item_added");
      expect(all.stdout).toContain("cart.item_removed");
      expect(all.stdout).toContain("checkout_completed { orderId: string }");
      expect(all.stdout).toContain("Fired once an order finishes checkout.");

      const narrowed = await runCliText(["events", "ls", "--name", "cart.*"], stateDir);
      expect(narrowed.stdout).toContain("cart.item_added");
      expect(narrowed.stdout).not.toContain("checkout_completed");

      const exact = await runCliText(["events", "ls", "--name", "checkout_completed"], stateDir);
      expect(exact.stdout).toContain("checkout_completed { orderId: string }");
      expect(exact.stdout).toContain('"required"');
      expect(exact.stdout).toContain("Payload schema");
    },
    30_000,
  );

  test(
    "--json carries the declared events with their full schemas and the total",
    async () => {
      const { stateDir } = await makeTempStateDir();
      const app = await connectApp(stateDir);
      app.declareEvents([checkout, itemAdded]);
      await waitForTotal(stateDir, 2);

      const listed = await runCliJson<{ events: unknown[]; total: number }>(["events", "ls"], stateDir);
      expect(listed.data).toEqual({ events: [itemAdded, checkout], total: 2 });

      const exact = await runCliJson<{ events: unknown[]; total: number }>(
        ["events", "ls", "--name", "checkout_completed"],
        stateDir,
      );
      expect(exact.data).toMatchObject({ events: [checkout], total: 1 });
    },
    30_000,
  );

  test(
    "a session that declared nothing prints an empty listing and exits 0",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await connectApp(stateDir);

      const listed = await runCliJson<{ events: unknown[]; total: number }>(["events", "ls"], stateDir);
      expect(listed).toMatchObject({ ok: true, exitCode: 0, data: { events: [], total: 0 } });

      const human = await runCliText(["events", "ls"], stateDir);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("No events declared");
    },
    30_000,
  );

  test(
    "a name with no match says so rather than printing an empty schema",
    async () => {
      const { stateDir } = await makeTempStateDir();
      const app = await connectApp(stateDir);
      app.declareEvents([checkout]);
      await waitForTotal(stateDir, 1);

      const missing = await runCliText(["events", "ls", "--name", "nope"], stateDir);
      expect(missing.exitCode).toBe(0);
      expect(missing.stdout).toContain('No events match "nope"');
    },
    30_000,
  );
});
