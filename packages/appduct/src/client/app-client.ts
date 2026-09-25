/**
 * The typed client handle (issue #8) returned by {@link connect}/{@link waitForSession}: a thin
 * wrapper over the same `tools.list`/`tools.call`/`events.subscribe`/`events.since` RPC the CLI and
 * MCP server use (`rpc/client.ts`'s `DaemonStream`), bound to one resolved session. No new privilege
 * or transport — every call is attributed `caller: "client"` for the audit log (ARCHITECTURE.md
 * §12). {@link AppClient.waitForEvent} is `events/index.ts`'s `waitForAppEvent` (issue #114) — the
 * same drain-then-live implementation the built-in `appduct_wait_for_event` MCP tool
 * (`mcp/events-tool.ts`) uses — called on a fresh stream opened for that one wait, so concurrent
 * waits on the same `AppClient` never share (and can't clobber) one connection's subscription.
 */
import {
  clampToolTimeoutMs,
  MAX_TOOL_TIMEOUT_MS,
  RPC_METHODS,
  toAppEvent,
  type AppEvent,
  type EventsSinceResult,
  type FullAppEvent,
  type ListedToolDescriptor,
  type ToolsCallResult,
  type ToolsListResult,
} from "@appduct/shared";

import {
  waitForAppEvent,
  WaitForAppEventConnectionClosedError,
  WaitForAppEventTimeoutError,
} from "../events/index.js";
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
  /**
   * Exclusive lower bound on `AppEvent.seq` (a cursor from a previous {@link AppClient.events} or
   * {@link AppClient.waitForEvent} call) — skips already-retained events at/before it instead of
   * resolving with an old match instantly. Omitted, the retained buffer is searched from its start,
   * so a matching event that already fired before this call still resolves immediately.
   */
  since?: number;
  /**
   * Caps the resolved event's payload to this many UTF-8 bytes of its JSON, daemon-side (issue
   * #114, same cap {@link AppClient.events} takes). Omitted, the payload is delivered whole; passed,
   * the resolved event may come back truncated — see {@link AppClient.waitForEvent}'s overloads.
   */
  payloadMaxBytes?: number;
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
  /** App events after `since` that were evicted before this call could return them (`0` once
   * nothing has fallen off — including across a gap of only Appduct's own kinds, which never
   * advance `seq`). */
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
   * how many app events after `since` were evicted before this call could return them, and how
   * much more still matches after this page.
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
   * whose name matches `name`, a whole-name, case-sensitive glob (issue #114: `*` matches any run
   * of characters, a pattern with no `*` is an exact name — e.g. `"cart.*"`, or `"*"` for the next
   * event of any name). Checks the daemon's retained buffer for an already-arrived match first,
   * then falls back to a live wait — so an event emitted between "the caller decides to wait" and
   * "the subscription lands" is never missed; pass `since` (a cursor from a previous {@link
   * AppClient.events}/`waitForEvent` call) to skip events already handled and wait only for a new
   * one, since omitting it can return an old match instantly on every call.
   *
   * Opens its own daemon stream for this one wait (issue #114) rather than sharing this
   * `AppClient`'s connection, so concurrent `waitForEvent` calls with different `name`s each get
   * their own `events.subscribe` filter and resolve on their own event.
   *
   * Overloaded on `payloadMaxBytes` the same way {@link AppClient.events} is (issue #114): omit it
   * and the resolved event's `payload` is readable unnarrowed ({@link FullAppEvent}); pass it to
   * cap the payload's JSON to that many UTF-8 bytes daemon-side, and narrow on `truncated` before
   * reading `payload` ({@link AppEvent}) — an event whose payload was over the cap has
   * `payloadPreview`/`payloadBytes` instead. See {@link AppClient.events}'s doc comment for why the
   * uncapped overload spells its `payloadMaxBytes` as `undefined` rather than omitting the key.
   */
  waitForEvent<TPayload = unknown>(
    name: string,
    options?: WaitForEventOptions & { payloadMaxBytes?: undefined },
  ): Promise<FullAppEvent<TPayload>>;
  waitForEvent<TPayload = unknown>(
    name: string,
    options: WaitForEventOptions & { payloadMaxBytes?: number },
  ): Promise<AppEvent<TPayload>>;

  /** Closes the underlying connection, and every stream a still-pending {@link
   * AppClient.waitForEvent} call opened for itself — each such call rejects with a `"connection_error"`
   * {@link AppductError}, the same way it did before `waitForEvent` moved onto its own stream (issue
   * #114). A `waitForEvent` call made after `close()` rejects immediately with the same error and
   * never opens a stream (so it never auto-spawns a daemon). Safe to call more than once. */
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

export const makeAppClient = <TTools = ToolMap>(
  stream: DaemonStream,
  sessionId: string,
  /** Opens a fresh `DaemonStream` for one {@link AppClient.waitForEvent} call (issue #114) — every
   * other method keeps using `stream` above. */
  openStream: () => Promise<DaemonStream>,
): AppClient<TTools> => {
  // Set by `close()`; checked at the top of `waitForEvent` so a call made after `close()` rejects
  // immediately instead of opening a stream (and possibly auto-spawning a daemon) for a wait that
  // would just be torn down. `openWaitStreams` holds every stream a still-pending `waitForEvent`
  // call opened for itself, so `close()` can close them too — closing only the shared `stream`
  // stopped ending a pending wait once each wait moved onto its own connection (issue #114).
  let closed = false;
  const openWaitStreams = new Set<DaemonStream>();

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

    waitForEvent: async (name: string, options: WaitForEventOptions = {}): Promise<AppEvent> => {
      if (closed) {
        throw new AppductError(
          "connection_error",
          `Cannot wait for event "${name}": this AppClient (session "${sessionId}") is closed.`,
        );
      }

      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS;
      const waitStream = await openStream();
      openWaitStreams.add(waitStream);

      try {
        const { event } = await waitForAppEvent(waitStream, {
          sessionId,
          name,
          since: options.since,
          timeoutMs,
          payloadMaxBytes: options.payloadMaxBytes,
        });

        return event;
      } catch (error) {
        if (error instanceof WaitForAppEventTimeoutError) {
          throw new AppductError("timeout", error.message);
        }

        if (error instanceof WaitForAppEventConnectionClosedError) {
          throw new AppductError("connection_error", error.message);
        }

        throw toAppductError(error);
      } finally {
        openWaitStreams.delete(waitStream);
        waitStream.close();
      }
    },

    close: (): void => {
      closed = true;

      for (const waitStream of openWaitStreams) {
        waitStream.close();
      }

      openWaitStreams.clear();
      stream.close();
    },
  };

  return client as unknown as AppClient<TTools>;
};
