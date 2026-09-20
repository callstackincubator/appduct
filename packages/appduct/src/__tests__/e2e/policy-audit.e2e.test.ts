/**
 * Policy/audit: destructive-deny + audit line assertions, driven through the real CLI subprocess
 * (a separate unit suite exercises the same policy/audit engine directly against the daemon's UDS
 * RPC; this drives the identical policy decision through `appduct invoke`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { getStateDirPaths } from "../../daemon/state-dir.js";
import { FakeAppClient } from "./app-client.js";
import {
  daemonWssPort,
  cleanupAfterEach,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  runCliJson,
  subscribeToEvents,
  waitForAuditRecords,
} from "./harness.js";

afterEach(cleanupAfterEach);

type AuditRecord = {
  ts: string;
  sessionId: string;
  alias: string;
  tool: string;
  argsSha256: string;
  outcome: "ok" | "error" | "denied";
  errorType?: string;
  durationMs: number;
  caller: "cli" | "mcp";
};

/** The two `invoke`s below (the allowed one and the denied one) each land a line in today's audit
 * file. The daemon is a separate process and answers a call before its line is necessarily on disk
 * (`daemon/audit.ts`'s write queue), so this waits for both rather than reading once. */
const waitForBothAuditRecords = async (stateDir: string): Promise<AuditRecord[]> => {
  return waitForAuditRecords<AuditRecord>(stateDir, (records) => records.length >= 2, {
    description: "the allowed and the denied invoke, both audited",
  });
};

describe("e2e: policy and audit", () => {
  test(
    "a destructive-hinted tool is denied by policy via `appduct invoke`, and every attempt is audited without raw args",
    async () => {
      const { stateDir } = await makeTempStateDir({ policy: { destructive: "deny" } });
      await ensureDaemon(stateDir);
      // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
      // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
      const port = await daemonWssPort(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const app = new FakeAppClient(port, pinnedKeys);
      const ack = await app.claim(link, { model: "Pixel 8" });
      const alias = ack.alias;

      const toolsChanged = events.waitFor("tools_changed");
      app.registerTools([
        { name: "echo" },
        { name: "deleteAll", annotations: { destructiveHint: true } },
      ]);
      await toolsChanged;
      events.close();

      app.answerCalls(() => ({ result: "ok" }));

      const sentinelSecret = "sentinel-secret-should-never-appear-in-audit-log";
      const okInvoke = await runCliJson(
        ["invoke", alias, "echo", "--input", JSON.stringify({ secret: sentinelSecret })],
        stateDir,
      );
      expect(okInvoke.ok).toBe(true);

      const deniedInvoke = await runCliJson(["invoke", alias, "deleteAll", "--input", "{}"], stateDir);
      expect(deniedInvoke.ok).toBe(false);
      expect(deniedInvoke.error?.type).toBe("policy_denied");
      // The hint names the config file the operator would edit to change this (ARCHITECTURE.md §12).
      expect(deniedInvoke.error?.details).toMatchObject({ hint: expect.stringContaining("config.json") });

      const records = await waitForBothAuditRecords(stateDir);
      expect(records.length).toBeGreaterThanOrEqual(2);

      const rawAuditContents = await readFile(
        path.join(getStateDirPaths(stateDir).auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
        "utf8",
      );
      expect(rawAuditContents).not.toContain(sentinelSecret);

      for (const record of records) {
        expect(record.sessionId).toBe(app.sessionId);
        expect(record.alias).toBe(alias);
        expect(record.caller).toBe("cli");
        expect(record.argsSha256).toMatch(/^[0-9a-f]{64}$/u);
      }

      const okRecord = records.find((record) => record.tool === "echo" && record.outcome === "ok");
      expect(okRecord).toBeDefined();

      const deniedRecord = records.find((record) => record.tool === "deleteAll" && record.outcome === "denied");
      expect(deniedRecord).toBeDefined();

      app.close();
    },
    15_000,
  );
});
