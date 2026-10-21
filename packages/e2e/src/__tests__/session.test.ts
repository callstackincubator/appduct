import { AppductError, type AppClient, type ListedToolDescriptor } from "appduct/client";
import { describe, expect, it } from "vitest";

import { createSession, type Clock } from "../session.js";

/** A clock whose time moves only when the code under test sleeps. */
const fakeClock = (): Clock & { elapsed(): number } => {
  let now = 0;
  return { now: () => now, sleep: async (ms) => void (now += ms), elapsed: () => now };
};

type FakeApp = {
  call?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  tools?: () => Promise<ListedToolDescriptor[]>;
};

/** An app client whose answers the test scripts, recording whether it was closed. */
const fakeClient = (app: FakeApp = {}): AppClient & { closed: boolean } => {
  const client = {
    sessionId: "s",
    closed: false,
    call: app.call ?? (async () => ({ ok: true })),
    tools: app.tools ?? (async () => [{ name: "sum" } as ListedToolDescriptor]),
    events: async () => ({ events: [], cursor: 0, dropped: 0, remaining: 0 }),
    waitForEvent: async (name: string) => ({ name }),
    close: () => void (client.closed = true),
  };
  return client as unknown as AppClient & { closed: boolean };
};

/** A pairing that hands out `clients` in order and counts how often it ran. */
const pairings = (...clients: AppClient[]) => {
  let count = 0;
  const pair = async () => {
    const client = clients[count++];
    if (!client) throw new Error("paired more often than expected");
    return client;
  };
  return { pair, count: () => count };
};

const gone = () => new AppductError("session_suspended", "The app went away.");
const missing = () => new AppductError("tool_not_found", 'Tool "sum" is not registered.');

describe("createSession", () => {
  it("does not pair until the test uses Appduct", () => {
    const { pair, count } = pairings();
    createSession(pair, fakeClock()).close();
    expect(count()).toBe(0);
  });

  it("pairs once for every call in a test", async () => {
    const { pair, count } = pairings(fakeClient({ call: async (_name, args) => args }));
    const session = createSession(pair, fakeClock());

    const results = await Promise.all([session.call("sum", { a: 1 }), session.call("sum", { a: 2 })]);
    await session.tools();

    expect(results).toEqual([{ a: 1 }, { a: 2 }]);
    expect(count()).toBe(1);
  });

  it("pairs again and repeats the call when the app's session has gone", async () => {
    const first = fakeClient({ call: () => Promise.reject(gone()) });
    const second = fakeClient({ call: async () => ({ total: 3 }) });
    const { pair, count } = pairings(first, second);
    const session = createSession(pair, fakeClock());

    expect(await session.call("sum", { a: 1, b: 2 })).toEqual({ total: 3 });
    expect(count()).toBe(2);
    expect(first.closed).toBe(true);
  });

  it("pairs again only once when the new session has gone too", async () => {
    const lost = () => fakeClient({ call: () => Promise.reject(gone()) });
    const { pair, count } = pairings(lost(), lost(), lost());
    const session = createSession(pair, fakeClock());

    await expect(session.call("sum")).rejects.toMatchObject({ type: "session_suspended" });
    expect(count()).toBe(2);
  });

  it("pairs again on the next use after a pairing fails", async () => {
    let attempts = 0;
    const session = createSession(async () => {
      attempts += 1;
      if (attempts === 1) throw new AppductError("timeout", "No claim.");
      return fakeClient();
    }, fakeClock());

    await expect(session.call("sum")).rejects.toMatchObject({ type: "timeout" });
    await expect(session.call("sum")).resolves.toEqual({ ok: true });
  });

  it("waits for a tool the app registers after the call is made", async () => {
    let calls = 0;
    const app = fakeClient({ call: async () => (++calls < 3 ? Promise.reject(missing()) : { total: 3 }) });
    const session = createSession(pairings(app).pair, fakeClock());

    expect(await session.call("sum")).toEqual({ total: 3 });
  });

  it("fails with tool_not_found when the tool is still missing after ten seconds", async () => {
    const clock = fakeClock();
    const session = createSession(pairings(fakeClient({ call: () => Promise.reject(missing()) })).pair, clock);

    await expect(session.call("sum")).rejects.toMatchObject({ type: "tool_not_found" });
    expect(clock.elapsed()).toBeGreaterThanOrEqual(10_000);
    expect(clock.elapsed()).toBeLessThan(10_100);
  });

  it("does not wait on a tool that fails", async () => {
    const clock = fakeClock();
    const failing = fakeClient({ call: () => Promise.reject(new AppductError("tool_execution_error", "Boom.")) });
    const session = createSession(pairings(failing).pair, clock);

    await expect(session.call("sum")).rejects.toMatchObject({ type: "tool_execution_error" });
    expect(clock.elapsed()).toBe(0);
  });

  it("lists tools once the app has registered its first", async () => {
    let lists = 0;
    const app = fakeClient({ tools: async () => (++lists < 3 ? [] : [{ name: "sum" } as ListedToolDescriptor]) });
    const session = createSession(pairings(app).pair, fakeClock());

    expect((await session.tools()).map((tool) => tool.name)).toEqual(["sum"]);
  });

  it("lists no tools for an app that registers none in ten seconds", async () => {
    const clock = fakeClock();
    const session = createSession(pairings(fakeClient({ tools: async () => [] })).pair, clock);

    expect(await session.tools()).toEqual([]);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(10_000);
  });

  it("closes the paired client when the test ends", async () => {
    const app = fakeClient();
    const session = createSession(pairings(app).pair, fakeClock());
    await session.call("sum");

    session.close();
    await Promise.resolve();

    expect(app.closed).toBe(true);
  });
});
