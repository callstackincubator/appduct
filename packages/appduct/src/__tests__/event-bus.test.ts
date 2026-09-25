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
    expect(bus.since("s1")).toEqual({ events: [], cursor: 0, dropped: 0, remaining: 0 });
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
    // Only `app_event` ever advances the per-session seq (issue #113) — it is the first emit
    // above to bump it, so it lands on 1, not the 4th-emit position it would have under the old
    // "every session event bumps seq" scheme.
    const { events, cursor } = bus.since("s1");
    expect(events.map((event) => [event.kind, event.seq])).toEqual([["app_event", 1]]);
    expect(cursor).toBe(1);
  });

  test("app_event is the only kind that advances the per-session seq; every other kind carries seq: 0 (issue #113)", () => {
    const bus = createEventBus({ clock });
    const seen: Array<[string, number]> = [];
    bus.subscribe((event) => seen.push([event.kind, event.seq]));

    bus.emit({ kind: "link_created", sessionId: "s1", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "tools_changed", sessionId: "s1", data: {} });
    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    bus.emit({ kind: "tool_call_finished", sessionId: "s1", data: {} });

    expect(seen).toEqual([
      ["link_created", 0],
      ["app_event", 1],
      ["tools_changed", 0],
      ["app_event", 2],
      ["tool_call_finished", 0],
    ]);
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

  test("a session with no app_events yet has cursor 0, even after other kinds (issue #113)", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "tools_changed", sessionId: "s1", data: {} });
    bus.emit({ kind: "tools_changed", sessionId: "s1", data: {} });

    const { events, cursor, dropped, remaining } = bus.since("s1");
    expect(events).toEqual([]);
    expect(cursor).toBe(0);
    expect(dropped).toBe(0);
    expect(remaining).toBe(0);
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

    expect(bus.since("s1")).toEqual({ events: [], cursor: 0, dropped: 0, remaining: 0 });
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

    expect(bus.since("s1")).toEqual({ events: [], cursor: 0, dropped: 0, remaining: 0 });
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

    expect(bus.since("s1")).toEqual({ events: [], cursor: 0, dropped: 0, remaining: 0 });
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

describe("event-bus: dropped and remaining (issue #113)", () => {
  test("dropped is 0 while nothing has been evicted", () => {
    const bus = createEventBus({ clock, bufferSize: 5 });

    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { i } });
    }

    expect(bus.since("s1").dropped).toBe(0);
    expect(bus.since("s1", { since: 2 }).dropped).toBe(0);
  });

  test("dropped counts app events evicted before the buffer's current oldest entry", () => {
    const bus = createEventBus({ clock, bufferSize: 3 });

    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { i } });
    }
    // seq 1 and 2 were evicted; the buffer now holds seq 3, 4, 5.

    expect(bus.since("s1").dropped).toBe(2);
    // Resuming from a still-retained cursor: nothing beyond it was evicted.
    expect(bus.since("s1", { since: 3 }).dropped).toBe(0);
    expect(bus.since("s1", { since: 4 }).dropped).toBe(0);
  });

  test("dropped is 0 across a gap of only never-retained kinds, even with a huge buffer wrap on other sessions", () => {
    const bus = createEventBus({ clock, bufferSize: 2 });

    bus.emit({ kind: "app_event", sessionId: "s1", data: {} });
    const { cursor } = bus.since("s1");

    for (let i = 0; i < 50; i++) {
      bus.emit({ kind: "tool_call_progress", sessionId: "s1", data: {} });
    }

    // Appduct's own kinds never advance seq (issue #113), so however many fired between calls,
    // nothing was evicted that the caller's cursor didn't already see.
    expect(bus.since("s1", { since: cursor }).dropped).toBe(0);
  });

  test("remaining counts matching events left after the returned page, 0 on the last page", () => {
    const bus = createEventBus({ clock });

    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "app_event", sessionId: "s1", data: { i } });
    }

    const first = bus.since("s1", { limit: 2 });
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(first.remaining).toBe(3);

    const second = bus.since("s1", { since: first.cursor, limit: 2 });
    expect(second.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(second.remaining).toBe(1);

    const third = bus.since("s1", { since: second.cursor, limit: 2 });
    expect(third.events.map((event) => event.seq)).toEqual([5]);
    expect(third.remaining).toBe(0);
  });

  test("remaining counts only events matching the name filter", () => {
    const bus = createEventBus({ clock });

    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "cart.a" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "other" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "cart.b" } });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "cart.c" } });

    const { events, remaining } = bus.since("s1", { name: "cart.*", limit: 1 });
    expect(events.map((event) => (event.data as { name: string }).name)).toEqual(["cart.a"]);
    // Two more "cart.*" events remain (cart.b, cart.c) — "other" never counted at all.
    expect(remaining).toBe(2);
  });
});

describe("event-bus: payloadMaxBytes truncation via since() (issue #113)", () => {
  test("a payload under the cap is returned unchanged, with no truncated/preview fields", () => {
    const bus = createEventBus({ clock });
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "small", payload: { a: 1 } } });

    const { events } = bus.since("s1", { payloadMaxBytes: 4096 });
    expect(events[0]!.data).toEqual({ name: "small", payload: { a: 1 } });
  });

  test("a payload over the cap comes back as { name, payloadPreview, truncated: true, payloadBytes }", () => {
    const bus = createEventBus({ clock });
    const payload = { text: "x".repeat(100) };
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "big", payload } });

    const { events } = bus.since("s1", { payloadMaxBytes: 10 });
    const data = events[0]!.data as { name: string; payload?: unknown; payloadPreview: string; truncated: true; payloadBytes: number };

    expect(data.name).toBe("big");
    expect(data.truncated).toBe(true);
    expect(data.payload).toBeUndefined();
    expect(data.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
    expect(Buffer.byteLength(data.payloadPreview, "utf8")).toBeLessThanOrEqual(10);
    expect(JSON.stringify(payload).startsWith(data.payloadPreview)).toBe(true);
  });

  test("the preview never splits a multi-byte UTF-8 code point", () => {
    const bus = createEventBus({ clock });
    // Each "💥" is a 4-byte UTF-8 sequence once JSON-quoted; a byte-oblivious slice at an odd
    // offset would land mid-character and corrupt it.
    const payload = { text: "💥".repeat(20) };
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "emoji", payload } });

    for (const cap of [1, 2, 3, 4, 5, 6, 7, 15, 20]) {
      const { events } = bus.since("s1", { payloadMaxBytes: cap });
      const data = events[0]!.data as { payloadPreview: string; payloadBytes: number };

      expect(Buffer.byteLength(data.payloadPreview, "utf8")).toBeLessThanOrEqual(cap);
      // A valid, non-truncated-mid-codepoint string re-encodes to exactly the bytes it consumed —
      // never fewer, which is what a split surrogate/continuation byte would silently produce via
      // the replacement character.
      expect(new TextEncoder().encode(data.payloadPreview).length).toBe(Buffer.byteLength(data.payloadPreview, "utf8"));
      expect(JSON.stringify(payload).startsWith(data.payloadPreview)).toBe(true);
    }
  });

  test("without payloadMaxBytes, payloads are never truncated regardless of size", () => {
    const bus = createEventBus({ clock });
    const payload = { text: "x".repeat(10_000) };
    bus.emit({ kind: "app_event", sessionId: "s1", data: { name: "huge", payload } });

    const { events } = bus.since("s1");
    expect(events[0]!.data).toEqual({ name: "huge", payload });
  });
});

describe("projectAppEvent: payloadMaxBytes truncation (issue #113)", () => {
  test("passes a payload at exactly the cap through unchanged (cap is inclusive)", () => {
    const payload = "abcd"; // JSON: "abcd" -> 6 bytes with quotes
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const event = { kind: "app_event" as const, sessionId: "s1", ts: 0, seq: 1, data: { name: "n", payload } };

    const projected = projectAppEvent(event, { payloadMaxBytes: bytes });
    expect(projected!.data).toEqual({ name: "n", payload });
  });

  test("truncates a payload one byte over the cap", () => {
    const payload = "abcde";
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const event = { kind: "app_event" as const, sessionId: "s1", ts: 0, seq: 1, data: { name: "n", payload } };

    const projected = projectAppEvent(event, { payloadMaxBytes: bytes - 1 });
    const data = projected!.data as { truncated: true; payloadBytes: number };
    expect(data.truncated).toBe(true);
    expect(data.payloadBytes).toBe(bytes);
  });

  test("combines a name filter with truncation: filtered out entirely wins over truncation", () => {
    const event = { kind: "app_event" as const, sessionId: "s1", ts: 0, seq: 1, data: { name: "no-match", payload: "x".repeat(100) } };
    expect(projectAppEvent(event, { name: "cart.*", payloadMaxBytes: 1 })).toBeUndefined();
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
