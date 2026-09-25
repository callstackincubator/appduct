/**
 * E2E scenario: the `appduct/client` programmatic API (issue #8). Drives a full session
 * lifecycle — claim, register tools, call a tool, wait for an app-pushed event, and a policy-denied
 * call — entirely through `connect()`/`AppClient`, never through a CLI subprocess, and asserts the
 * audit trail attributes these calls to `caller: "client"`.
 */
import { afterEach, describe, expect, test } from "vitest";

import { connect, AppductError } from "../../client/index.js";
import { FakeAppClient } from "./app-client.js";
import {
  cleanupAfterEach,
  daemonWssPort,
  ensureDaemon,
  fetchPinnedKeys,
  makeTempStateDir,
  mintLink,
  subscribeToEvents,
  waitForAuditRecords,
} from "./harness.js";

afterEach(cleanupAfterEach);

type AuditRecord = {
  sessionId: string;
  alias: string;
  tool: string;
  outcome: "ok" | "error" | "denied";
  caller: "cli" | "mcp" | "client";
};

/** The three calls this scenario makes, each on its own line of today's audit file. The daemon
 * runs in a separate process and answers a call before its audit line is necessarily on disk
 * (`daemon/audit.ts`'s write queue), so this waits for all three rather than reading once. */
const waitForSessionAuditRecords = async (stateDir: string, alias: string): Promise<AuditRecord[]> => {
  const forThisSession = (records: AuditRecord[]): AuditRecord[] =>
    records.filter((record) => record.alias === alias);

  return forThisSession(
    await waitForAuditRecords<AuditRecord>(
      stateDir,
      (records) => forThisSession(records).length >= 3,
      { description: `three audited calls for alias "${alias}"` },
    ),
  );
};

/** A caller-declared tool map, `interface`-style (not a `type` alias) — regression coverage for
 * `AppClient<TTools>` being unconstrained so both forms type-check (a `Record<string, ...>`-bound
 * generic would reject this: TS only infers an implicit index signature for `type` aliases, not for
 * `interface`s). */
interface Tools {
  sum: { args: { a: number; b: number }; result: { total: number } };
  deleteAll: { args: Record<string, never>; result: string };
}

describe("e2e: appduct/client", () => {
  test(
    "connect() -> tools() -> call() -> waitForEvent() round-trips against a real daemon and app, audited as caller \"client\"",
    async () => {
      const { stateDir } = await makeTempStateDir({ policy: { destructive: "deny" } });
      await ensureDaemon(stateDir);
      // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
      // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
      const port = await daemonWssPort(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const fakeApp = new FakeAppClient(port, pinnedKeys);
      const ack = await fakeApp.claim(link, { model: "Pixel 8" });

      const toolsChanged = events.waitFor("tools_changed");
      fakeApp.registerTools([
        { name: "sum" },
        { name: "deleteAll", annotations: { destructiveHint: true } },
      ]);
      await toolsChanged;
      events.close();

      fakeApp.answerCalls((call) => {
        if (call.name === "sum") {
          const { a, b } = call.args as { a: number; b: number };
          return { result: { total: a + b } };
        }

        return { result: "ok" };
      });

      const app = await connect<Tools>({ stateDir, selector: link.sessionId });
      expect(app.sessionId).toBe(link.sessionId);

      const tools = await app.tools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["deleteAll", "sum"]);

      // Typed end to end: no cast needed for `.total` (regression coverage for the default
      // `ToolMap`'s `result: any` and the interface-based `Tools` map above).
      const { total } = await app.call("sum", { a: 2, b: 3 });
      expect(total).toBe(5);

      const waitingForEvent = app.waitForEvent<{ orderId: string }>("checkout_done", { timeoutMs: 5000 });
      fakeApp.emitEvent("checkout_done", { orderId: "42" });
      const event = await waitingForEvent;
      expect(event).toMatchObject({ name: "checkout_done", payload: { orderId: "42" } });

      await expect(app.call("no_such_tool" as never, {})).rejects.toMatchObject({ type: "tool_not_found" });
      await expect(app.call("deleteAll", {})).rejects.toMatchObject({ type: "policy_denied" });

      const records = await waitForSessionAuditRecords(stateDir, ack.alias);

      expect(records).toContainEqual(
        expect.objectContaining({ tool: "sum", outcome: "ok", caller: "client" }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({ tool: "no_such_tool", outcome: "error", caller: "client" }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({ tool: "deleteAll", outcome: "denied", caller: "client" }),
      );

      app.close();
      fakeApp.close();
    },
    15_000,
  );

  test(
    "call()'s transport timeout never fires before the daemon's own tool_timeout, even for a timeoutMs above the transport default",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
      // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
      const port = await daemonWssPort(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const fakeApp = new FakeAppClient(port, pinnedKeys);
      await fakeApp.claim(link, { model: "Pixel 8" });

      const toolsChanged = events.waitFor("tools_changed");
      fakeApp.registerTools([{ name: "neverResponds" }]);
      await toolsChanged;
      events.close();
      // Deliberately never calls `answerCalls` — the daemon's own clamped tool_timeout must be
      // what ends this call, not this client's transport-level request timeout.

      const app = await connect({ stateDir, selector: link.sessionId });

      // Above the old hardcoded 10s transport default: before the fix this reliably surfaced as
      // `connection_error` ("Timed out waiting for a response to tools.call") instead of the
      // daemon's own `tool_timeout`.
      await expect(app.call("neverResponds", {}, { timeoutMs: 12_000 })).rejects.toMatchObject({
        type: "tool_timeout",
      });

      app.close();
      fakeApp.close();
    },
    20_000,
  );

  test("waitForEvent() resolves on a name glob (issue #114)", async () => {
    const { stateDir } = await makeTempStateDir();
    await ensureDaemon(stateDir);
    // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
    // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
    const port = await daemonWssPort(stateDir);
    const pinnedKeys = await fetchPinnedKeys(stateDir);

    const events = await subscribeToEvents(stateDir);
    const link = await mintLink(stateDir);
    const fakeApp = new FakeAppClient(port, pinnedKeys);
    await fakeApp.claim(link, { model: "Pixel 8" });

    const toolsChanged = events.waitFor("tools_changed");
    fakeApp.registerTools([{ name: "echo" }]);
    await toolsChanged;
    events.close();
    fakeApp.answerCalls(() => ({ result: "ok" }));

    const app = await connect({ stateDir, selector: link.sessionId });

    const waiting = app.waitForEvent<{ id: number }>("cart.*", { timeoutMs: 5000 });
    fakeApp.emitEvent("checkout_started", { ignored: true });
    fakeApp.emitEvent("cart.item_added", { id: 1 });

    const event = await waiting;
    expect(event).toMatchObject({ name: "cart.item_added", payload: { id: 1 } });

    app.close();
    fakeApp.close();
  }, 15_000);

  test("two concurrent waitForEvent() calls with different names each resolve on their own event (issue #114)", async () => {
    const { stateDir } = await makeTempStateDir();
    await ensureDaemon(stateDir);
    // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
    // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
    const port = await daemonWssPort(stateDir);
    const pinnedKeys = await fetchPinnedKeys(stateDir);

    const events = await subscribeToEvents(stateDir);
    const link = await mintLink(stateDir);
    const fakeApp = new FakeAppClient(port, pinnedKeys);
    await fakeApp.claim(link, { model: "Pixel 8" });

    const toolsChanged = events.waitFor("tools_changed");
    fakeApp.registerTools([{ name: "echo" }]);
    await toolsChanged;
    events.close();

    const app = await connect({ stateDir, selector: link.sessionId });

    // Each call opens its own daemon stream (issue #114), so their `events.subscribe` filters
    // can't clobber one another the way sharing one connection's single filter would.
    const waitingForFirst = app.waitForEvent<{ n: number }>("first", { timeoutMs: 5000 });
    const waitingForSecond = app.waitForEvent<{ n: number }>("second", { timeoutMs: 5000 });

    fakeApp.emitEvent("second", { n: 2 });
    fakeApp.emitEvent("first", { n: 1 });

    const [first, second] = await Promise.all([waitingForFirst, waitingForSecond]);
    expect(first).toMatchObject({ name: "first", payload: { n: 1 } });
    expect(second).toMatchObject({ name: "second", payload: { n: 2 } });

    app.close();
    fakeApp.close();
  }, 15_000);

  test(
    "waitForEvent() resolves from the retained buffer for an event emitted before it was called (no live-subscribe race)",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
      // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
      const port = await daemonWssPort(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const fakeApp = new FakeAppClient(port, pinnedKeys);
      await fakeApp.claim(link, { model: "Pixel 8" });

      const toolsChanged = events.waitFor("tools_changed");
      fakeApp.registerTools([{ name: "echo" }]);
      await toolsChanged;
      events.close();
      fakeApp.answerCalls(() => ({ result: "ok" }));

      const app = await connect({ stateDir, selector: link.sessionId });

      // Emitted well before `waitForEvent` is ever called — a live-only subscription would miss
      // this entirely; the daemon's retention buffer is what lets this still resolve.
      fakeApp.emitEvent("checkout_done", { orderId: "already-happened" });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const event = await app.waitForEvent<{ orderId: string }>("checkout_done", { timeoutMs: 5000 });
      expect(event).toMatchObject({ name: "checkout_done", payload: { orderId: "already-happened" } });
      expect(typeof event.seq).toBe("number");

      app.close();
      fakeApp.close();
    },
    15_000,
  );

  test(
    "events() drains the retained buffer, and waitForEvent()'s since skips events already seen",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      // The daemon binds an OS-assigned wss port (`wssPort: 0`), so the port is read back
      // from the daemon itself rather than chosen here — see harness.makeTempStateDir.
      const port = await daemonWssPort(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const fakeApp = new FakeAppClient(port, pinnedKeys);
      await fakeApp.claim(link, { model: "Pixel 8" });

      const toolsChanged = events.waitFor("tools_changed");
      fakeApp.registerTools([{ name: "echo" }]);
      await toolsChanged;
      events.close();
      fakeApp.answerCalls(() => ({ result: "ok" }));

      const app = await connect({ stateDir, selector: link.sessionId });

      fakeApp.emitEvent("checkout_done", { orderId: "first" });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const drained = await app.events();
      expect(drained.events.map((event) => event.payload)).toContainEqual({ orderId: "first" });
      expect(drained.cursor).toBeGreaterThan(0);

      // With `since` set to the cursor already drained, a second wait must not re-resolve
      // instantly against the same "first" event — only a genuinely new one.
      const waitingForNext = app.waitForEvent<{ orderId: string }>("checkout_done", {
        timeoutMs: 5000,
        since: drained.cursor,
      });
      fakeApp.emitEvent("checkout_done", { orderId: "second" });
      const next = await waitingForNext;
      expect(next).toMatchObject({ payload: { orderId: "second" } });
      expect(next.seq).toBeGreaterThan(drained.cursor);

      app.close();
      fakeApp.close();
    },
    15_000,
  );

  test(
    "events() with payloadMaxBytes truncates an oversized payload and reports dropped/remaining (issue #113)",
    async () => {
      const { stateDir } = await makeTempStateDir();
      await ensureDaemon(stateDir);
      const port = await daemonWssPort(stateDir);
      const pinnedKeys = await fetchPinnedKeys(stateDir);

      const events = await subscribeToEvents(stateDir);
      const link = await mintLink(stateDir);
      const fakeApp = new FakeAppClient(port, pinnedKeys);
      await fakeApp.claim(link, { model: "Pixel 8" });

      const toolsChanged = events.waitFor("tools_changed");
      fakeApp.registerTools([{ name: "echo" }]);
      await toolsChanged;
      events.close();

      const app = await connect({ stateDir, selector: link.sessionId });

      fakeApp.emitEvent("big", { text: "x".repeat(200) });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const drained = await app.events({ payloadMaxBytes: 10 });
      const event = drained.events.find((candidate) => candidate.name === "big")!;
      expect(event.truncated).toBe(true);
      if (event.truncated) {
        expect(event.payloadBytes).toBeGreaterThan(10);
        expect(Buffer.byteLength(event.payloadPreview, "utf8")).toBeLessThanOrEqual(10);
      }
      expect(drained.dropped).toBe(0);
      expect(drained.remaining).toBe(0);

      app.close();
      fakeApp.close();
    },
    15_000,
  );

  test("connect() rejects with a connection_error AppductError when the daemon is unreachable and auto-spawn is disabled", async () => {
    const { stateDir } = await makeTempStateDir();

    await expect(connect({ stateDir, autoSpawn: false })).rejects.toBeInstanceOf(AppductError);
    await expect(connect({ stateDir, autoSpawn: false })).rejects.toMatchObject({ type: "connection_error" });
  });
});
