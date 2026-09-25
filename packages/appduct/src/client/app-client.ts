/**
 * The typed client handle (issue #8) returned by {@link connect}/{@link waitForSession}: a thin
 * wrapper over the same `tools.list`/`tools.call`/`events.subscribe`/`events.since` RPC the CLI and
 * MCP server use (`rpc/client.ts`'s `DaemonStream`), bound to one resolved session. No new privilege
 * or transport — every call is attributed `caller: "client"` for the audit log (ARCHITECTURE.md
 * §12). {@link AppClient.waitForEvent}'s drain-then-live pattern mirrors the built-in
 * `appduct_wait_for_event` MCP tool (`mcp/events-tool.ts`) — see that module's doc comment for
 * why the notification listener has to be registered before the `events.since` drain call is sent.
 */
import {
  clampToolTimeoutMs,
  MAX_TOOL_TIMEOUT_MS,
  RPC_METHODS,
  toAppEvent,
  type AppEvent,
  type EventNotification,
  type EventsSinceResult,
  type FullAppEvent,
  type ListedToolDescriptor,
  type ToolsCallResult,
  type ToolsListResult,
} from "@appduct/shared";

import type { DaemonStream } from "../rpc/client.js";
import { AppductError, toAppductError } from "./errors.js";

/** A project's own tool map — declared once, e.g. `type Tools = { sum: { args: { a: number; b:
 * number }; result: { total: number } } }` — to get typed {@link AppClient.call} throughout a test
 * suite. Tool names and arg/result types can't be statically known here (they're registered by the
 * connected app at runtime): the default `result` is `any` so the untyped form (`connect()` with no
 * generic) still lets a caller destructure a call's result without a cast, e.g. `const { total } =
 * await app.call("sum", { a: 2, b: 3 })`. `AppClient` itself is deliberately unconstrained (no
 * `extends Record<string, ...>`) so both `type` aliases and plain `interface`s work here — TS only
 * infers an implicit index signature for the former, so a constrained generic would silently reject
 * the latter. */
export type ToolMap = Record<string, { args: Record<string, unknown>; result: any }>;

type ToolArgs<TTools, K extends keyof TTools> = TTools[K] extends { args: infer TArgs } ? TArgs : Record<string, unknown>;
type ToolResult<TTools, K extends keyof TTools> = TTools[K] extends { result: infer TResult } ? TResult : unknown;

export type CallOptions = {
  /** Forwarded to the daemon as this call's deadline, clamped server-side to [1s, 600s]. Omitted,
   * the daemon falls back to the tool's own declared `timeoutMs` (`registerTool`), and to 10s for a
   * tool that declares none. Either way this is NOT the call's transport timeout, which is derived
   * automatically so a `tool_timeout` from the daemon always arrives before this client's own
   * transport timeout would otherwise fire and misreport it as `connection_error`. */
  timeoutMs?: number;
};

export type WaitForEventOptions = {
  /** Defaults to 30s. */
  timeoutMs?: number;
  /** Extra filter over the event's payload; the event still must match `name` first. A predicate
   * that throws rejects the wait with that error rather than crashing the connection. */
  match?: (payload: unknown) => boolean;
  /**
   * Exclusive lower bound on `AppEvent.seq` (a cursor from a previous {@link AppClient.events} or
   * {@link AppClient.waitForEvent} call) — skips already-retained events at/before it instead of
   * resolving with an old match instantly. Omitted, the retained buffer is searched from its start,
   * so a matching event that already fired before this call still resolves immediately.
   */
  since?: number;
};

export type EventsOptions = {
  /** Exclusive lower bound on `AppEvent.seq`; omitted returns the whole retained buffer (oldest
   * first, subject to `limit`). */
  since?: number;
  /** Caps the number of events returned (oldest-first truncation); omitted returns everything
   * matching `since` up to the buffer's own retention limit. */
  limit?: number;
};

/** `events.since`'s `dropped`/`remaining`, shared by both of {@link AppClient.events}'s overloaded
 * results (issue #113). */
export type EventsCounts = {
  /** App events evicted from the retention buffer at or before `since` before this call could see
   * them (`0` once nothing has fallen off — including across a gap of only Appduct's own kinds,
   * which never advance `seq`). */
  dropped: number;
  /** Events still matching this query after the returned (possibly `limit`-truncated) page; `0`
   * on the last page. */
  remaining: number;
};

/** {@link AppClient.events}'s result with no `payloadMaxBytes` — every event's `payload` is
 * readable unnarrowed. */
export type FullEventsResult = EventsCounts & {
  events: FullAppEvent[];
  /** The highest `seq` currently retained for this session (not just among the returned events) —
   * pass it back as `since` on the next {@link AppClient.events}/{@link AppClient.waitForEvent}
   * call to resume after it. */
  cursor: number;
};

/** {@link AppClient.events}'s result once a `payloadMaxBytes` cap is given — narrow each event on
 * `truncated` before reading `payload`. */
export type EventsResult = EventsCounts & {
  events: AppEvent[];
  cursor: number;
};

/** Re-exported from `@appduct/shared` (issue #112) so `appduct/client` keeps its own public
 * `AppEvent` name and doc comment for a `waitForEvent`/`events` caller. */
export type { AppEvent, FullAppEvent } from "@appduct/shared";

export type AppClient<TTools = ToolMap> = {
  readonly sessionId: string;

  /** `tools.list` for this session. An entry spells an ungrouped tool's `group` as `null`,
   * where a registration omits it. */
  tools(): Promise<ListedToolDescriptor[]>;

  /** `tools.call`; rejects with a {@link AppductError} whose `type` preserves the wire error
   * type verbatim (e.g. `"tool_timeout"`, `"policy_denied"`, `"session_suspended"`). */
  call<K extends keyof TTools & string>(
    name: K,
    args: ToolArgs<TTools, K>,
    options?: CallOptions,
  ): Promise<ToolResult<TTools, K>>;

  /**
   * Drains `app_event`s retained in the daemon's per-session ring buffer since a cursor — the pull
   * counterpart to {@link AppClient.waitForEvent}, for checking what already happened instead of
   * waiting for the next one. Pass `cursor` from the result back as `since` on the next call to
   * avoid re-reading events already seen. `dropped`/`remaining` (issue #113) report, respectively,
   * how much history at/before `since` is already gone and how much more still matches after this
   * page.
   *
   * Overloaded on `payloadMaxBytes` (issue #113): omit it and every event's `payload` is readable
   * unnarrowed ({@link FullEventsResult}); pass it to cap each payload's JSON to that many UTF-8
   * bytes, and narrow each event on `truncated` before reading `payload` ({@link EventsResult}) —
   * an event whose payload was over the cap has `payloadPreview`/`payloadBytes` instead.
   *
   * The uncapped overload is listed first, but excludes `payloadMaxBytes` from its type
   * (`payloadMaxBytes?: undefined`) rather than simply omitting the key from `EventsOptions`:
   * TypeScript's excess-property check only rejects an extra `payloadMaxBytes` on an object
   * *literal* passed directly as the argument, so an options bag held in a variable would
   * otherwise still structurally match plain `EventsOptions` and resolve to `FullEventsResult`
   * — letting `event.payload` compile unnarrowed even though the daemon truncated it (issue
   * #113's review). Requiring the key to be `undefined` when present means a variable whose
   * `payloadMaxBytes` is typed `number` (required or optional) fails to match this overload —
   * by excess-property check for a literal, by property-type mismatch for a variable — and
   * falls through to the capped overload below, which accepts any `payloadMaxBytes` (including
   * `number | undefined`) and returns the narrowed `EventsResult` whenever the type cannot
   * prove the payload is uncapped.
   */
  events(options?: EventsOptions & { payloadMaxBytes?: undefined }): Promise<FullEventsResult>;
  events(options: EventsOptions & { payloadMaxBytes?: number }): Promise<EventsResult>;

  /**
   * Waits for the next `app_event` (as pushed by the connected app's `postEvent(name, payload)`)
   * matching `name`. Checks the daemon's retained buffer for an already-arrived match first, then
   * falls back to a live wait — so an event emitted between "the caller decides to wait" and "the
   * subscription lands" is never missed; pass `since` (a cursor from a previous {@link
   * AppClient.events}/`waitForEvent` call) to skip events already handled and wait only for a new
   * one, since omitting it can return an old match instantly on every call.
   *
   * This shares the connection's single `events.subscribe` filter (the daemon keeps one per
   * connection, replaced — not merged — on each call); concurrent `waitForEvent` calls on the same
   * `AppClient` all see every `app_event`, so this is safe today, but it means the connection stays
   * subscribed to `app_event` for its lifetime once any `waitForEvent` has run.
   *
   * No `payloadMaxBytes` here yet (issue #113 scopes the overload to {@link AppClient.events});
   * this always resolves with the full, untruncated payload.
   */
  waitForEvent<TPayload = unknown>(name: string, options?: WaitForEventOptions): Promise<FullAppEvent<TPayload>>;

  /** Closes the underlying connection. Safe to call more than once. */
  close(): void;
};

const DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS = 30_000;

/** Extra headroom so the daemon's own `tool_timeout` always wins the race against this client's
 * transport timeout, even accounting for RPC round-trip and event-loop scheduling delay. Kept
 * local because it is a property of this transport, not of the protocol; the *bounds* it is added
 * to come from `@appduct/shared`, so this client and the daemon cannot disagree about the
 * deadline itself. */
const CALL_TRANSPORT_TIMEOUT_SLACK_MS = 5_000;

/**
 * Transport timeout for one `tools.call`. With an explicit `timeoutMs` the daemon-side deadline is
 * known exactly, so this is that clamped value plus slack.
 *
 * Without one the daemon defaults to the *tool's own* declared `timeoutMs` (issue #25), which this
 * client does not know at call time and would need an extra `tools.list` round trip (racy against
 * re-registration) to learn — so it falls back to the largest deadline the daemon could possibly
 * enforce. That is deliberately generous: this watchdog only exists for a daemon that accepts the
 * request and then never answers, since a daemon that dies or drops the socket already rejects
 * every pending call immediately (`rpc/client.ts`'s `close` handler). Sizing it off the 10 s
 * default instead would make this client the thing that fails a long tool call, reporting a
 * generic transport error in place of the daemon's real one.
 */
export const transportTimeoutForToolCall = (timeoutMs: number | undefined): number => {
  const clamped =
    timeoutMs === undefined || !Number.isFinite(timeoutMs)
      ? MAX_TOOL_TIMEOUT_MS
      : clampToolTimeoutMs(timeoutMs);

  return clamped + CALL_TRANSPORT_TIMEOUT_SLACK_MS;
};

export const makeAppClient = <TTools = ToolMap>(stream: DaemonStream, sessionId: string): AppClient<TTools> => {
  const client = {
    sessionId,

    tools: async (): Promise<ListedToolDescriptor[]> => {
      try {
        // No `filter`/`limit`/`offset`: this client's public `tools()` contract is "every tool on
        // this session", unchanged by `tools.list`'s daemon-side paging (added for the CLI).
        const result = await stream.call<ToolsListResult | ToolsListResult["tools"]>(RPC_METHODS.toolsList, {
          selector: sessionId,
        });
        // Unlike the CLI, this client runs no daemon version check, so it can meet a daemon from
        // before `tools.list` returned `{ tools, total }` — one that still answers a bare array.
        const entries = Array.isArray(result) ? result : result.tools;
        // That daemon predates tool groups as well and sends no `group` key, so normalise it the
        // way the daemon itself would. Callers are told every entry carries one.
        return entries.map((entry) => ({ ...entry, group: entry.group ?? null }));
      } catch (error) {
        throw toAppductError(error);
      }
    },

    call: async (name: string, args: Record<string, unknown>, options?: CallOptions): Promise<unknown> => {
      try {
        const result = await stream.call<ToolsCallResult>(
          RPC_METHODS.toolsCall,
          {
            selector: sessionId,
            name,
            args,
            timeoutMs: options?.timeoutMs,
            caller: "client",
          },
          transportTimeoutForToolCall(options?.timeoutMs),
        );

        return result.result;
      } catch (error) {
        throw toAppductError(error);
      }
    },

    // A single implementation backs both of the public type's overloaded signatures — `makeAppClient`
    // returns `client as unknown as AppClient<TTools>` below, so nothing here has to structurally
    // satisfy either signature on its own; the overloads are strictly a compile-time view for callers.
    events: async (options: EventsOptions & { payloadMaxBytes?: number } = {}): Promise<EventsResult> => {
      try {
        const result = await stream.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
          selector: sessionId,
          since: options.since,
          limit: options.limit,
          payloadMaxBytes: options.payloadMaxBytes,
        });

        return {
          events: result.events
            .map((event) => toAppEvent(event, sessionId))
            .filter((event): event is AppEvent => event !== undefined),
          cursor: result.cursor,
          dropped: result.dropped,
          remaining: result.remaining,
        };
      } catch (error) {
        throw toAppductError(error);
      }
    },

    waitForEvent: (name: string, options: WaitForEventOptions = {}): Promise<FullAppEvent> => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS;

      // `waitForEvent` never asks for `payloadMaxBytes` (issue #113 scopes the overload to
      // `events()`), so every `app_event` it can possibly see comes back from `toAppEvent` as a
      // `FullAppEvent` — `truncated` is only ever `true` when a `payloadMaxBytes` cap on this
      // connection's subscription did the truncating, and this connection's subscribe call below
      // never sets one.
      const toMatch = (event: EventNotification): FullAppEvent | undefined => {
        const appEvent = toAppEvent(event, sessionId);

        if (!appEvent || appEvent.truncated || appEvent.name !== name) {
          return undefined;
        }

        if (options.match && !options.match(appEvent.payload)) {
          return undefined;
        }

        return appEvent;
      };

      return new Promise<FullAppEvent>((resolve, reject) => {
        let settled = false;

        const settle = (fn: () => void): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          unsubscribeClose();
          liveHandler = null;
          fn();
        };

        const timer = setTimeout(() => {
          settle(() =>
            reject(new AppductError("timeout", `Timed out after ${timeoutMs}ms waiting for event "${name}".`)),
          );
        }, timeoutMs);

        // Registered before `events.since` is even sent (not merely before it resolves): the
        // daemon's response to that call and a `notify()` for a brand-new event can arrive in the
        // same socket chunk, and a listener added only after awaiting that response could miss a
        // notification from that same chunk. Buffers into `earlyEvents` until the drain below has
        // merged its own backlog and switched this to `liveHandler`.
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

        const fail = (error: unknown): void => {
          settle(() => reject(toAppductError(error)));
          unsubscribeNotification();
        };

        (async () => {
          await stream.call(RPC_METHODS.eventsSubscribe, { sessionSelector: sessionId, kinds: ["app_event"] });

          const sinceResult = await stream.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
            selector: sessionId,
            since: options.since,
          });

          // Merge the retained backlog with whatever arrived on the live channel while the two
          // calls above were in flight, deduped by `seq` — the same event can legitimately show up
          // in both (the daemon buffers before it fans out). Everything from here to `liveHandler =
          // …` below is synchronous — no `await` — so nothing can arrive on the socket and be missed
          // in the gap.
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
            try {
              const matched = toMatch(event);

              if (matched) {
                settle(() => resolve(matched));
                unsubscribeNotification();
                return;
              }
            } catch (error) {
              fail(error);
              return;
            }
          }

          // Nothing matched yet: resume live from the last event actually considered, or — if
          // nothing was retained/arrived at all — `events.since`'s own cursor, which already
          // reflects the session's true high-water mark even when nothing was retained.
          const highestConsideredSeq = backlog.length > 0 ? backlog[backlog.length - 1]!.seq : sinceResult.cursor;

          unsubscribeClose = stream.onClose(() => {
            settle(() =>
              reject(
                new AppductError(
                  "connection_error",
                  `The connection to the Appduct daemon closed while waiting for event "${name}".`,
                ),
              ),
            );
            unsubscribeNotification();
          });

          // From here on, every notification goes straight to this handler instead of
          // `earlyEvents` — assigned synchronously (no `await` since the backlog scan above), so
          // nothing is missed.
          liveHandler = (event) => {
            if (settled) {
              return;
            }

            if (event.sessionId === sessionId && event.seq <= highestConsideredSeq) {
              return;
            }

            try {
              const matched = toMatch(event);

              if (matched) {
                settle(() => resolve(matched));
                unsubscribeNotification();
              }
            } catch (error) {
              fail(error);
            }
          };
        })().catch((error) => {
          fail(error);
        });
      });
    },

    close: (): void => {
      stream.close();
    },
  };

  return client as unknown as AppClient<TTools>;
};
