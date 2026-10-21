import { AppductError, type AppClient, type ListedToolDescriptor, type SessionState } from "appduct/client";
import { describe, expect, it } from "vitest";

import { createSessions, type Clock } from "../session.js";

/** A clock whose time moves only when the code under test sleeps. */
const fakeClock = (): Clock & { elapsed(): number } => {
  let now = 0;
  return { now: () => now, sleep: async (ms) => void (now += ms), elapsed: () => now };
};

type FakeApp = {
  call?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  tools?: () => Promise<ListedToolDescriptor[]>;
  /** What the daemon reports for the session; `undefined` means it no longer exists. */
  state?: SessionState;
};

type Fake = AppClient & { closed: boolean; revoked: boolean; app: FakeApp };

/** An app client whose answers the test scripts, recording whether it was closed or revoked. */
const fakeClient = (app: FakeApp = { state: "active" }): Fake => {
  const client = {
    sessionId: "s",
    app,
    closed: false,
    revoked: false,
    state: async () => app.state ?? Promise.reject(new AppductError("unknown_session", "No such session.")),
    revoke: async () => void (client.revoked = true),
    call: app.call ?? (async () => ({ ok: true })),
    tools: app.tools ?? (async () => [{ name: "sum" } as ListedToolDescriptor]),
    events: async () => ({ events: [], cursor: 0, dropped: 0, remaining: 0 }),
    waitForEvent: async (name: string) => ({ name }),
    close: () => void (client.closed = true),
  };
  return client as unknown as Fake;
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

describe("one test", () => {
  it("does not pair until the test uses Appduct", () => {
    const { pair, count } = pairings();
    createSessions(fakeClock()).forTest(pair);
    expect(count()).toBe(0);
  });

  it("pairs once for every call in a test", async () => {
    const { pair, count } = pairings(fakeClient({ state: "active", call: async (_name, args) => args }));
    const session = createSessions(fakeClock()).forTest(pair);

    const results = await Promise.all([session.call("sum", { a: 1 }), session.call("sum", { a: 2 })]);
    await session.tools();

    expect(results).toEqual([{ a: 1 }, { a: 2 }]);
    expect(count()).toBe(1);
  });

  it("revokes a session that has gone, pairs again and repeats the call", async () => {
    const first = fakeClient({ state: "suspended", call: () => Promise.reject(gone()) });
    const second = fakeClient({ state: "active", call: async () => ({ total: 3 }) });
    const { pair, count } = pairings(first, second);
    const session = createSessions(fakeClock()).forTest(pair);

    expect(await session.call("sum", { a: 1, b: 2 })).toEqual({ total: 3 });
    expect(count()).toBe(2);
    expect(first.revoked).toBe(true);
    expect(first.closed).toBe(true);
  });

  it("pairs again once when concurrent calls find the session gone", async () => {
    const first = fakeClient({ state: "suspended", call: () => Promise.reject(gone()) });
    const { pair, count } = pairings(first, fakeClient());
    const session = createSessions(fakeClock()).forTest(pair);

    await Promise.all([session.call("sum"), session.call("sum")]);

    expect(count()).toBe(2);
  });

  it("pairs again only once when the new session has gone too", async () => {
    const lost = () => fakeClient({ state: "suspended", call: () => Promise.reject(gone()) });
    const { pair, count } = pairings(lost(), lost(), lost());
    const session = createSessions(fakeClock()).forTest(pair);

    await expect(session.call("sum")).rejects.toMatchObject({ type: "session_suspended" });
    expect(count()).toBe(2);
  });

  it("pairs again on the next use after a pairing fails", async () => {
    let attempts = 0;
    const session = createSessions(fakeClock()).forTest(async () => {
      attempts += 1;
      if (attempts === 1) throw new AppductError("timeout", "No claim.");
      return fakeClient();
    });

    await expect(session.call("sum")).rejects.toMatchObject({ type: "timeout" });
    await expect(session.call("sum")).resolves.toEqual({ ok: true });
  });

  it("waits for a tool the app registers after the call is made", async () => {
    let calls = 0;
    const app = fakeClient({ state: "active", call: async () => (++calls < 3 ? Promise.reject(missing()) : { total: 3 }) });
    const session = createSessions(fakeClock()).forTest(pairings(app).pair);

    expect(await session.call("sum")).toEqual({ total: 3 });
  });

  it("fails with tool_not_found when the tool is still missing after ten seconds", async () => {
    const clock = fakeClock();
    const app = fakeClient({ state: "active", call: () => Promise.reject(missing()) });
    const session = createSessions(clock).forTest(pairings(app).pair);

    await expect(session.call("sum")).rejects.toMatchObject({ type: "tool_not_found" });
    expect(clock.elapsed()).toBeGreaterThanOrEqual(10_000);
    expect(clock.elapsed()).toBeLessThan(10_100);
  });

  it("does not wait on a tool that fails", async () => {
    const clock = fakeClock();
    const app = fakeClient({ state: "active", call: () => Promise.reject(new AppductError("tool_execution_error", "Boom.")) });
    const session = createSessions(clock).forTest(pairings(app).pair);

    await expect(session.call("sum")).rejects.toMatchObject({ type: "tool_execution_error" });
    expect(clock.elapsed()).toBe(0);
  });

  it("lists tools once the app has registered its first", async () => {
    let lists = 0;
    const app = fakeClient({ state: "active", tools: async () => (++lists < 3 ? [] : [{ name: "sum" } as ListedToolDescriptor]) });
    const session = createSessions(fakeClock()).forTest(pairings(app).pair);

    expect((await session.tools()).map((tool) => tool.name)).toEqual(["sum"]);
  });

  it("lists no tools for an app that registers none in ten seconds", async () => {
    const clock = fakeClock();
    const session = createSessions(clock).forTest(pairings(fakeClient({ state: "active", tools: async () => [] })).pair);

    expect(await session.tools()).toEqual([]);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(10_000);
  });
});

describe("across tests in a worker", () => {
  it("reuses the previous test's session while the app is still connected", async () => {
    const app = fakeClient({ state: "active" });
    const { pair, count } = pairings(app);
    const sessions = createSessions(fakeClock());

    await sessions.forTest(pair).call("sum");
    await sessions.forTest(pair).call("sum");

    expect(count()).toBe(1);
    expect(app.revoked).toBe(false);
    expect(app.closed).toBe(false);
  });

  it("revokes the previous test's session and pairs again once the app has gone", async () => {
    const relaunched = fakeClient({ state: "active" });
    const fresh = fakeClient({ state: "active" });
    const { pair, count } = pairings(relaunched, fresh);
    const sessions = createSessions(fakeClock());
    await sessions.forTest(pair).call("sum");

    relaunched.app.state = "suspended"; // the next test relaunched the app
    await sessions.forTest(pair).call("sum");

    expect(count()).toBe(2);
    expect(relaunched.revoked).toBe(true);
    expect(relaunched.closed).toBe(true);
  });

  it("pairs again when the previous test's session no longer exists", async () => {
    const forgotten = fakeClient({ state: "active" });
    const { pair, count } = pairings(forgotten, fakeClient());
    const sessions = createSessions(fakeClock());
    await sessions.forTest(pair).call("sum");

    forgotten.app.state = undefined; // its grace period ran out
    await sessions.forTest(pair).call("sum");

    expect(count()).toBe(2);
  });

  it("does not check or pair for a test that never uses Appduct", async () => {
    const app = fakeClient({ state: "active" });
    const { pair, count } = pairings(app);
    const sessions = createSessions(fakeClock());
    await sessions.forTest(pair).call("sum");

    app.app.state = "suspended";
    sessions.forTest(pair);

    expect(count()).toBe(1);
    expect(app.revoked).toBe(false);
  });
});
