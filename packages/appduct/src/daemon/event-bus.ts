/**
 * Typed in-process event bus (ARCHITECTURE.md §5 event kinds). The RPC layer (for
 * `events.subscribe`/`events.since`) and audit subscribe here; this module owns fan-out plus a
 * per-session retention ring buffer, and must never let a throwing subscriber take down the daemon
 * or another subscriber.
 *
 * Retention (issue #6, #98): every session-scoped event gets a monotonically increasing per-session
 * `seq`, but only `app_event` is appended to the per-session ring buffer, capped at `bufferSize`
 * entries (oldest dropped first). Appduct's own kinds (lifecycle, tool calls) are fanned out live
 * and never retained, so no number of tool calls can evict an app event. A
 * session's buffer is discarded the moment it emits a terminal event (`session_expired` /
 * `session_revoked`) — "terminal states free the alias" (sessions.ts) applies to retained events
 * too, matching "no persisted history" (ARCHITECTURE.md §3/§13) — or via an explicit `drop()` for
 * the pending-link discard paths that never reach one of those event kinds. Daemon-wide events (no
 * `sessionId`, e.g. `daemon_started`) are fanned out but never buffered.
 */

import type { EventKind, EventNotification } from "@appduct/shared";

import type { Clock } from "../cli/types.js";

export type EventBusEmitInput = Omit<EventNotification, "ts" | "seq"> & { kind: EventKind; ts?: number };

export type EventBusListener = (event: EventNotification) => void;

/** Terminal event kinds whose arrival for a session discards that session's retained buffer. */
const TERMINAL_EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["session_expired", "session_revoked"]);

export type ProjectAppEventOptions = {
  /** Whole-name, case-sensitive glob (issue #112): `*` matches any run of characters, a pattern
   * with no `*` is an exact name. */
  name?: string;
  /** Caps the payload's JSON to this many UTF-8 bytes (issue #113); see {@link truncateToUtf8Bytes}. */
  payloadMaxBytes?: number;
};

/** UTF-8 byte length of `text` — what a `payloadMaxBytes` cap counts against, not `text.length`
 * (UTF-16 code units), which undercounts anything outside the BMP or with multi-byte characters. */
const utf8ByteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * The longest prefix of `text` whose UTF-8 encoding is at most `maxBytes` bytes, never splitting a
 * multi-byte code point (issue #113). A naive byte slice (`Buffer.from(text).subarray(0,
 * maxBytes)`) can land mid-sequence; decoding that back with the lossy `Buffer#toString("utf8")`
 * would silently replace the broken tail with U+FFFD instead of dropping it, corrupting the
 * preview rather than shortening it cleanly. This decodes strictly (`TextDecoder` with `fatal:
 * true`) and backs off one byte at a time until the slice decodes clean.
 */
const truncateToUtf8Bytes = (text: string, maxBytes: number): string => {
  const encoded = Buffer.from(text, "utf8");

  if (encoded.length <= maxBytes) {
    return text;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (let end = maxBytes; end > 0; end--) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // `end` landed inside a multi-byte sequence; back off one byte and retry.
    }
  }

  return "";
};

/** Whether `name` matches the whole-name glob `pattern` (`*` matches any run of characters,
 * everything else literally), in time linear in the two strings' lengths.
 *
 * No regex and no backtracking: the daemon is single-threaded, so a match that blows up blocks
 * every session and RPC client (issue #112 review). Compiling `*` to `.*` was exponential in the
 * star count, and a two-pointer matcher that backtracks to the last `*` was still quadratic.
 * Instead the pattern is split on `*`: the first piece must be a prefix, the last a suffix, and
 * each middle piece is found in order with `indexOf`. Taking the leftmost occurrence of each
 * middle piece is always safe, because it leaves the most room for the pieces after it. */
const matchesNameGlob = (pattern: string, name: string): boolean => {
  const pieces = pattern.split("*");
  const first = pieces[0] ?? "";

  if (pieces.length === 1) {
    return name === first;
  }

  const last = pieces[pieces.length - 1] ?? "";

  if (first.length + last.length > name.length || !name.startsWith(first) || !name.endsWith(last)) {
    return false;
  }

  const end = name.length - last.length;
  let position = first.length;

  for (const piece of pieces.slice(1, -1)) {
    const found = name.indexOf(piece, position);

    if (found === -1 || found + piece.length > end) {
      return false;
    }

    position = found + piece.length;
  }

  return true;
};

/**
 * Whether `event` survives `options.name`'s glob, and truncates its payload to `options
 * .payloadMaxBytes` when given — the one implementation `since()`'s drain and `daemon.ts`'s
 * `events.subscribe` fan-out both call, so the two can't drift apart (issue #112, #113). Returns
 * `event` (unchanged, or with its payload replaced by a preview) when it should be kept,
 * `undefined` when it should be dropped.
 *
 * Only an `app_event` carries a `name`/`payload` to filter or truncate, so every other kind passes
 * through unfiltered and untouched regardless of either option — the `kinds` filter
 * (`events.subscribe`) is what narrows those.
 */
export const projectAppEvent = (
  event: EventNotification,
  options: ProjectAppEventOptions = {},
): EventNotification | undefined => {
  if (event.kind !== "app_event") {
    return event;
  }

  const data = event.data as { name?: unknown; payload?: unknown };

  if (options.name !== undefined && !(typeof data.name === "string" && matchesNameGlob(options.name, data.name))) {
    return undefined;
  }

  if (options.payloadMaxBytes === undefined || !("payload" in data)) {
    return event;
  }

  const payloadJson = JSON.stringify(data.payload);

  // `JSON.stringify` returns `undefined` (the value, not a string) only for a payload that has no
  // JSON representation at all (`undefined` itself) — nothing to measure or preview, so it passes
  // through exactly like an event with no `payload` key at all.
  if (payloadJson === undefined) {
    return event;
  }

  const payloadBytes = utf8ByteLength(payloadJson);

  if (payloadBytes <= options.payloadMaxBytes) {
    return event;
  }

  return {
    ...event,
    data: {
      name: data.name,
      payloadPreview: truncateToUtf8Bytes(payloadJson, options.payloadMaxBytes),
      truncated: true,
      payloadBytes,
    },
  };
};

export type EventsSinceQuery = {
  since?: number;
  limit?: number;
  /** Whole-name, case-sensitive glob (issue #112): `*` matches any run of characters, a pattern
   * with no `*` is an exact name. See {@link projectAppEvent}. */
  name?: string;
  /** Caps a returned `app_event`'s payload to this many UTF-8 bytes of its JSON (issue #113);
   * applied to the page actually returned, after `name`/`limit`, via {@link projectAppEvent}. */
  payloadMaxBytes?: number;
};

export type EventsSinceQueryResult = {
  events: EventNotification[];
  cursor: number;
  /** How many app events at or before `since` were evicted before this call could see them
   * (issue #113): `max(0, oldest.seq - since - 1)`, `oldest` being the buffer's current oldest
   * retained entry. `0` once nothing has fallen off, and `since` defaults to `0` when omitted. */
  dropped: number;
  /** How many events still match `since`/`name` after the returned (possibly `limit`-truncated)
   * page. `0` on the last page. */
  remaining: number;
};

export type EventBus = {
  emit: (event: EventBusEmitInput) => void;
  subscribe: (listener: EventBusListener) => () => void;
  /** Drains the retained buffer for `sessionId`. Returns an empty result (`cursor: 0`) for a
   * session with no retained events (nothing emitted yet, or its buffer already discarded). */
  since: (sessionId: string, query?: EventsSinceQuery) => EventsSinceQueryResult;
  /** Discards `sessionId`'s retained buffer outright, with no event required. Covers the pending-
   * link discard paths that never reach a terminal event kind (attempt-limit exceeded, the TTL
   * free-timer) — `TERMINAL_EVENT_KINDS` only catches the ones that *do* emit one. Idempotent. */
  drop: (sessionId: string) => void;
};

export type CreateEventBusOptions = {
  clock?: Clock;
  /** Max retained events per session (ARCHITECTURE.md §5's `eventBufferSize`); default 256. */
  bufferSize?: number;
};

export const createEventBus = (options: CreateEventBusOptions = {}): EventBus => {
  const clock = options.clock ?? { now: () => new Date() };
  const bufferSize = options.bufferSize ?? 256;

  const listeners = new Set<EventBusListener>();
  const buffers = new Map<string, EventNotification[]>();
  const cursors = new Map<string, number>();

  const appendToBuffer = (sessionId: string, notification: EventNotification): void => {
    const buffer = buffers.get(sessionId) ?? [];
    buffer.push(notification);

    if (buffer.length > bufferSize) {
      buffer.splice(0, buffer.length - bufferSize);
    }

    buffers.set(sessionId, buffer);
  };

  return {
    emit: (event) => {
      const sessionId = event.sessionId;
      // `seq` counts `app_event`s only (issue #113): every other kind — session-scoped or not —
      // carries `seq: 0`, since only `app_event` is retained and `dropped` is worked out from its
      // `seq` alone (`since()` below). Nothing else reads `seq`.
      let seq = 0;

      if (sessionId !== undefined && event.kind === "app_event") {
        seq = (cursors.get(sessionId) ?? 0) + 1;
        cursors.set(sessionId, seq);
      }

      const notification: EventNotification = {
        ...event,
        ts: event.ts ?? clock.now().getTime(),
        seq,
      };

      if (sessionId !== undefined) {
        if (TERMINAL_EVENT_KINDS.has(notification.kind)) {
          // The terminal event itself is still delivered live (fan-out below) and reported through
          // `since`'s `cursor`, but is not retained — nothing can legitimately ask for it again once
          // the session is gone.
          buffers.delete(sessionId);
          cursors.delete(sessionId);
        } else if (notification.kind === "app_event") {
          appendToBuffer(sessionId, notification);
        }
      }

      for (const listener of listeners) {
        try {
          listener(notification);
        } catch {
          // A misbehaving subscriber must never crash the daemon or block other subscribers.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    since: (sessionId, query = {}) => {
      const buffer = buffers.get(sessionId) ?? [];
      const sessionCursor = cursors.get(sessionId) ?? 0;

      // How many app events fell off the front of the ring buffer before this call could see them
      // (issue #113): the buffer's own oldest retained entry is the earliest still-visible `seq`,
      // so anything between the caller's cursor and just before it is gone. `since` defaults to 0
      // (the same "from the start" a caller gets by omitting it), and only ever grows past what's
      // still retained, never past what's been filtered by `name` — a name filter narrows what's
      // returned, not what history exists.
      const sinceValue = query.since ?? 0;
      const oldestRetainedSeq = buffer.length > 0 ? buffer[0]!.seq : undefined;
      const dropped = oldestRetainedSeq !== undefined ? Math.max(0, oldestRetainedSeq - sinceValue - 1) : 0;

      // Never hand back the live buffer array itself — `emit()` keeps pushing into it after this
      // call returns, and a caller that gets `events` by reference would see it mutate underneath
      // it.
      let matching = buffer.slice();

      if (query.since !== undefined) {
        matching = matching.filter((event) => event.seq > query.since!);
      }

      if (query.name !== undefined) {
        matching = matching.filter((event) => projectAppEvent(event, { name: query.name }) !== undefined);
      }

      let events = matching;

      if (query.limit !== undefined && events.length > query.limit) {
        // Keep the OLDEST N, not the newest: `limit` exists to bound one response, not to skip
        // ahead — a caller pages forward by re-calling with `since` set to the response's own
        // `cursor`. Keeping the newest N instead would make that same re-call return the same
        // window forever, silently and unrecoverably losing whatever `limit` cut off.
        events = events.slice(0, query.limit);
      }

      // What `limit` (if any) cut off: matching events strictly after the ones actually returned.
      // `matching` is oldest-first and `events` is its own prefix, so the difference in lengths is
      // exactly that count (issue #113).
      const remaining = matching.length - events.length;

      // The cursor a caller should resume from: the last event actually returned, so paging
      // through a `limit`-truncated response with `since: cursor` always advances. Only when
      // nothing was returned (empty buffer, or every retained event was filtered out) does it fall
      // back to the session's true high-water mark, so an empty page still lets a caller skip past
      // the unretained kinds' seqs rather than re-fetching from an older cursor forever.
      const cursor = events.length > 0 ? events[events.length - 1]!.seq : sessionCursor;

      if (query.payloadMaxBytes !== undefined) {
        // Truncation never removes an event (only `name` does, already applied above), so this
        // always returns a defined result for each one.
        events = events.map((event) => projectAppEvent(event, { payloadMaxBytes: query.payloadMaxBytes })!);
      }

      return { events, cursor, dropped, remaining };
    },
    drop: (sessionId) => {
      buffers.delete(sessionId);
      cursors.delete(sessionId);
    },
  };
};
