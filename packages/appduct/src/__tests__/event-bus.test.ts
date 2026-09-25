/**
 * Pure unit tests for `daemon/event-bus.ts`'s retention buffer (issue #6): cursor assignment,
 * `since` filtering, the ring buffer's eviction cap, and the terminal-state buffer drop. No daemon,
 * no socket, no device — `createEventBus` takes a `Clock` seam precisely so this needs none of that.
 */

import { describe, expect, test } from "vitest";

import { createEventBus, projectAppEvent } from "../daemon/event-bus.js";

const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

describe("event-bus: retention buffer", () => {
  test("assigns a monotonically increasing per-session seq, starting at 1", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "a" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "b" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "c" } });

    const { events, cursor } = bus.since("s1");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(cursor).toBe(3);
  });

  test("seq counters are independent per session", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s2", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });

    expect(bus.since("s1").cursor).toBe(2);
    expect(bus.since("s2").cursor).toBe(1);
  });

  test("daemon-wide events (no sessionId) are fanned out but never buffered", () => {
    const bus = createEventBus({ clock });
    const seen: number[] = [];
    bus.subscribe((event) => seen.push(event.seq));

    bus.emit({ kind: "daemon_started", data: {} });

    expect(seen).toEqual([0]);
    // Nothing to drain for any session id — a daemon-wide event was never anyone's to retain.
    expect(bus.since("s1")).toEqual({ events: [], cursor: 0 });
  });

  test("since excludes everything at or before the given cursor", () => {
    const bus = createEventBus({ clock });

    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { i } });
    }

    const { events } = bus.since("s1", { since: 2 });
    expect(events.map((event) => event.seq)).toEqual([3, 4, 5]);
  });

  test("retains app_event only; every other session-scoped kind is fanned out live but never retained", () => {
    const bus = createEventBus({ clock });
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.kind));

    bus.emit({ kind: "link_created", sessionId: "s1", data: {} });
    bus.emit({ kind: "session_claimed", sessionId: "s1", data: {} });
    bus.emit({ kind: "tools_changed", sessionId: "s1", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "tool_call_started", sessionId: "s1", data: {} });
    bus.emit({ kind: "tool_call_finished", sessionId: "s1", data: {} });
    bus.emit({ kind: "session_suspended", sessionId: "s1", data: {} });

    expect(seen).toEqual([
      "link_created",
      "session_claimed",
      "tools_changed",
      "app_event",
      "tool_call_started",
      "tool_call_finished",
      "session_suspended",
    ]);
    const { events, cursor } = bus.since("s1");
    expect(events.map((event) => [event.kind, event.seq])).toEqual([["app_event", 4]]);
    expect(cursor).toBe(4);
  });

  test("limit truncates to the oldest N so paging with the returned cursor never skips events", () => {
    const bus = createEventBus({ clock });

    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { i } });
    }

    const first = bus.since("s1", { limit: 2 });
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    // cursor is the last *returned* event, not the session's true high-water mark — that's what
    // makes re-calling with `since: cursor` page forward instead of returning the same window.
    expect(first.cursor).toBe(2);

    const second = bus.since("s1", { since: first.cursor, limit: 2 });
    expect(second.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(second.cursor).toBe(4);

    const third = bus.since("s1", { since: second.cursor, limit: 2 });
    expect(third.events.map((event) => event.seq)).toEqual([5]);
    // Fewer than `limit` left: cursor still tracks the last event actually returned.
    expect(third.cursor).toBe(5);
  });

  test("an empty page still advances the cursor past kinds that are never retained", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "tools_changed", sessionId: "s1", data: {} });
    bus.emit({ kind: "tools_changed", sessionId: "s1", data: {} });

    const { events, cursor } = bus.since("s1");
    expect(events).toEqual([]);
    expect(cursor).toBe(2);
  });

  test("an app_event survives bufferSize tool calls with no app events after it", () => {
    const bus = createEventBus({ clock, bufferSize: 3 });

    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "before" } });

    for (let i = 0; i < 3; i++) {
      bus.emit({ kind: "tool_call_started", sessionId: "s1", data: {} });
      bus.emit({ kind: "tool_call_finished", sessionId: "s1", data: {} });
    }

    expect(bus.since("s1").events.map((event) => event.data)).toEqual([{ name: "before" }]);
  });

  test("the ring buffer caps retention at bufferSize, dropping the oldest first", () => {
    const bus = createEventBus({ clock, bufferSize: 3 });

    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { i } });
    }

    const { events, cursor } = bus.since("s1");
    // seq 1 and 2 were evicted; the cursor still reflects the true total emitted, not just retained.
    expect(events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(cursor).toBe(5);
  });

  test("a terminal event (session_expired/session_revoked) discards the session's buffer", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "session_expired", sessionId: "s1", data: {} });

    expect(bus.since("s1")).toEqual({ events: [], cursor: 0 });
  });

  test("the terminal event itself is still delivered live even though it isn't retained", () => {
    const bus = createEventBus({ clock });
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.kind));

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "session_revoked", sessionId: "s1", data: {} });

    expect(seen).toEqual(["app_event", "session_revoked"]);
  });

  test("session_revoked also discards the buffer, matching session_expired", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "session_revoked", sessionId: "s1", data: {} });

    expect(bus.since("s1")).toEqual({ events: [], cursor: 0 });
  });

  test("since returns a snapshot, not the live buffer — a later emit doesn't mutate an already-returned result", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    const { events } = bus.since("s1");
    expect(events).toHaveLength(1);

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    // The array returned by the first `since` call must still have length 1 — it must not be the
    // same array `emit` just pushed into.
    expect(events).toHaveLength(1);
  });

  test("tool_call_progress is fanned out live but never retained, so it can't evict app_events", () => {
    const bus = createEventBus({ clock, bufferSize: 2 });
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.kind));

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });

    for (let i = 0; i < 10; i++) {
      bus.emit({ kind: "tool_call_progress", sessionId: "s1", data: { progress: i } });
    }

    expect(seen.filter((kind) => kind === "tool_call_progress")).toHaveLength(10);
    // A `bufferSize` of 2 would otherwise have evicted the app_event many times over.
    expect(bus.since("s1").events.map((event) => event.kind)).toEqual(["app_event"]);
  });

  test("drop() discards a session's buffer outright, with no event required", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    expect(bus.since("s1").events).toHaveLength(1);

    bus.drop("s1");

    expect(bus.since("s1")).toEqual({ events: [], cursor: 0 });
  });

  test("drop() on a session with nothing retained is a harmless no-op", () => {
    const bus = createEventBus({ clock });
    expect(() => bus.drop("never-emitted")).not.toThrow();
  });

  test("since with a name glob returns only events whose name matches (issue #112)", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "cart.item_added" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "checkout_completed" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "cart.item_removed" } });

    const { events } = bus.since("s1", { name: "cart.*" });
    expect(events.map((event) => (event.data as { name: string }).name)).toEqual([
      "cart.item_added",
      "cart.item_removed",
    ]);
  });

  test("a name with no * matches only that exact name, never a longer name it prefixes", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "checkout_completed" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "checkout_completed_v2" } });

    const { events } = bus.since("s1", { name: "checkout_completed" });
    expect(events.map((event) => (event.data as { name: string }).name)).toEqual(["checkout_completed"]);
  });

  test("a pathological many-star pattern against a long name completes quickly (issue #117)", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "a".repeat(40) } });

    const pattern = "*a".repeat(10) + "*b";
    const start = performance.now();
    const { events } = bus.since("s1", { name: pattern });
    const elapsed = performance.now() - start;

    expect(events).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  test("a long literal after a star against many maximum-length names completes quickly", () => {
    const bus = createEventBus({ clock, bufferSize: 256 });

    for (let index = 0; index < 256; index++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "a".repeat(4096) } });
    }

    const pattern = "*" + "a".repeat(2048) + "b";
    const start = performance.now();
    const { events } = bus.since("s1", { name: pattern });
    const elapsed = performance.now() - start;

    expect(events).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  test("a prefix and suffix around a star never overlap in the name", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "ab" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "abab" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "ab.x.cd.y.ab" } });

    const { events } = bus.since("s1", { name: "ab*ab" });
    expect(events.map((event) => (event.data as { name: string }).name)).toEqual(["abab", "ab.x.cd.y.ab"]);
    expect(bus.since("s1", { name: "ab*cd*ab" }).events.map((event) => (event.data as { name: string }).name)).toEqual([
      "ab.x.cd.y.ab",
    ]);
  });

  test("name matching is case-sensitive", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "cart.item_added" } });

    const { events } = bus.since("s1", { name: "Cart.*" });
    expect(events).toEqual([]);
  });

  test("a throwing subscriber never breaks buffering or another subscriber", () => {
    const bus = createEventBus({ clock });
    const seen: string[] = [];

    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((event) => seen.push(event.kind));

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });

    expect(seen).toEqual(["app_event"]);
    expect(bus.since("s1").events).toHaveLength(1);
  });
});

describe("projectAppEvent: the one name-glob implementation shared by since() and events.subscribe (issue #112)", () => {
  const appEvent = (name: string) =>
    ({ kind: "app_event", sessionId: "s1", ts: 0, seq: 1, data: { name } }) as const;

  test("with no name filter, passes the event through unchanged", () => {
    const event = appEvent("cart.item_added");
    expect(projectAppEvent(event)).toBe(event);
  });

  test("a non-app_event kind is never filtered by name — only an app event carries one", () => {
    const event = { kind: "tools_changed", sessionId: "s1", ts: 0, seq: 0, data: {} } as const;
    expect(projectAppEvent(event, { name: "cart.*" })).toBe(event);
  });

  test("matches a trailing glob", () => {
    expect(projectAppEvent(appEvent("cart.item_added"), { name: "cart.*" })).toBeDefined();
  });

  test("rejects a name the glob doesn't cover", () => {
    expect(projectAppEvent(appEvent("checkout_completed_v2"), { name: "checkout_completed" })).toBeUndefined();
  });
});
