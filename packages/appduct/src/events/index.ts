/**
 * `waitForAppEvent` (issue #114): the one drain-then-live wait implementation shared by the
 * built-in `appduct_wait_for_event` MCP tool (`mcp/events-tool.ts`) and `appduct/client`'s
 * `AppClient.waitForEvent` (`client/app-client.ts`), which used to each carry their own copy.
 *
 * Filtering by `name` (a whole-name, case-sensitive glob — issue #112) and truncating a payload
 * over `payloadMaxBytes` (issue #113) both happen daemon-side, via the same `projectAppEvent`
 * (`daemon/event-bus.ts`) that `events.since`'s drain and `events.subscribe`'s live fan-out both
 * already call — this module forwards `name`/`payloadMaxBytes` to both RPCs and never re-checks
 * a name or re-truncates a payload itself.
 *
 * The drain-then-live shape exists to close the race `appduct_wait_for_session` doesn't have to
 * worry about: a session is either claimed or not, but an app event can fire between "the caller
 * decides to wait" and "the wait subscription lands". The notification listener is registered
 * *before* `events.subscribe` is even sent — not merely before it resolves — because the
 * daemon's response to that call and a `notify()` for a brand-new event can arrive in the same
 * socket chunk; `rpc/client.ts`'s `DaemonStream` fans a chunk's notification lines out to
 * whatever listeners exist at the moment it's processed, so a listener added only after `await`ing
 * that response could miss a notification line from that same chunk. Arrivals before the drain
 * has been merged into the backlog are buffered, then merged in (deduped by `seq`) before falling
 * through to the live phase.
 *
 * `stream` is the caller's: opened and closed by the caller. Every caller of this module opens
 * one stream per `waitForAppEvent` call — the MCP tool always did (`openDaemonStream` per
 * `tools/call`), and the SDK now does too, so concurrent `waitForEvent` calls with different
 * `name`s never clobber a shared connection's single `events.subscribe` filter.
 */

import {
  RPC_METHODS,
  toAppEvent,
  type AppEvent,
  type EventNotification,
  type EventsSinceResult,
} from "@appduct/shared";

import type { DaemonStream } from "../rpc/client.js";

export type WaitForAppEventOptions = {
  sessionId: string;
  /** Whole-name, case-sensitive glob (issue #112): `*` matches any run of characters, a pattern
   * with no `*` is an exact name — forwarded verbatim to `events.since`/`events.subscribe`. */
  name: string;
  /** Exclusive lower bound on `AppEvent.seq`; omitted drains the whole retained buffer. */
  since?: number;
  timeoutMs: number;
  /** Caps the resolved event's payload to this many UTF-8 bytes of its JSON, daemon-side, on
   * both the drain and the live half. Omitted, payloads are delivered whole. */
  payloadMaxBytes?: number;
};

export type WaitForAppEventResult = {
  event: AppEvent;
  /** `events.since`'s own `dropped` from the drain: app events after `since` that were evicted
   * before the drain could return them (`0` once nothing has fallen off). Reflects only the
   * drain — an event that resolves this wait live was delivered, not dropped. */
  dropped: number;
};

/** Raised when nothing matching `name` arrived within `timeoutMs`. */
export class WaitForAppEventTimeoutError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Timed out after ${timeoutMs}ms waiting for event "${eventName}".`);
    this.name = "WaitForAppEventTimeoutError";
  }
}

/** Raised when `stream` closes (daemon gone, `stop()`, etc.) while a live wait was in flight. */
export class WaitForAppEventConnectionClosedError extends Error {
  constructor(public readonly eventName: string) {
    super(`The connection to the Appduct daemon closed while waiting for event "${eventName}".`);
    this.name = "WaitForAppEventConnectionClosedError";
  }
}

export const waitForAppEvent = async (
  stream: DaemonStream,
  options: WaitForAppEventOptions,
): Promise<WaitForAppEventResult> => {
  const { sessionId, name, since, timeoutMs, payloadMaxBytes } = options;

  // Buffers into `earlyEvents` until the backlog scan below has switched this to `liveHandler` —
  // see the module doc comment for why this is registered before `events.subscribe` is even sent.
  let liveHandler: ((event: EventNotification) => void) | null = null;
  const earlyEvents: EventNotification[] = [];

  const unsubscribeNotification = stream.onNotification((payload) => {
    const event = payload as EventNotification;

    if (liveHandler) {
      liveHandler(event);
    } else {
      earlyEvents.push(event);
    }
  });

  let unsubscribeClose = (): void => {};

  try {
    await stream.call(RPC_METHODS.eventsSubscribe, {
      sessionSelector: sessionId,
      kinds: ["app_event"],
      name,
      payloadMaxBytes,
    });

    const sinceResult = await stream.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
      selector: sessionId,
      since,
      name,
      payloadMaxBytes,
    });

    // Merge the retained backlog with whatever arrived on the live channel while the two calls
    // above were in flight, deduped by `seq` (the same event can legitimately show up in both:
    // the daemon buffers before it fans out). Everything from here to `liveHandler = …` below is
    // synchronous — no `await` — so nothing can arrive on the socket and be missed in the gap.
    const seenSeqs = new Set<number>();
    const backlog: EventNotification[] = [];

    for (const event of [...sinceResult.events, ...earlyEvents]) {
      if (event.sessionId === sessionId && !seenSeqs.has(event.seq)) {
        seenSeqs.add(event.seq);
        backlog.push(event);
      }
    }

    backlog.sort((a, b) => a.seq - b.seq);

    for (const event of backlog) {
      const appEvent = toAppEvent(event, sessionId);

      if (appEvent) {
        return { event: appEvent, dropped: sinceResult.dropped };
      }
    }

    // Nothing matched yet: the cursor to resume live from is the last event actually considered
    // (the backlog scan above already covers everything `sinceResult.events` + `earlyEvents`
    // jointly saw), or — if nothing was retained/arrived at all — `events.since`'s own cursor,
    // which already reflects the session's true high-water mark even when nothing was retained.
    const highestConsideredSeq = backlog.length > 0 ? backlog[backlog.length - 1]!.seq : sinceResult.cursor;

    return await new Promise<WaitForAppEventResult>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        liveHandler = null;
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => reject(new WaitForAppEventTimeoutError(name, timeoutMs)));
      }, timeoutMs);

      unsubscribeClose = stream.onClose(() => {
        settle(() => reject(new WaitForAppEventConnectionClosedError(name)));
      });

      // From here on, every notification goes straight to this handler instead of `earlyEvents` —
      // assigned synchronously (no `await` since the backlog scan above), so nothing is missed.
      liveHandler = (event) => {
        if (settled) {
          return;
        }

        if (event.sessionId === sessionId && event.seq <= highestConsideredSeq) {
          return;
        }

        const appEvent = toAppEvent(event, sessionId);

        if (appEvent) {
          settle(() => resolve({ event: appEvent, dropped: sinceResult.dropped }));
        }
      };
    });
  } finally {
    unsubscribeNotification();
    unsubscribeClose();
  }
};
