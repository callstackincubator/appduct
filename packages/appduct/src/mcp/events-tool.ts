/**
 * The built-in `appduct_events` / `appduct_wait_for_event` MCP tools (issue #6): a pull
 * surface over the daemon's `app_event` plumbing (`postEvent()` on the app side, `events.since`'s
 * per-session retention buffer on the daemon side — see `daemon/event-bus.ts`). MCP is
 * request/response, so an agent otherwise has no way to observe anything the app pushes.
 *
 * `appduct_wait_for_event`'s drain-then-live wait is `events/index.ts`'s `waitForAppEvent`
 * (issue #114) — the same implementation `appduct/client`'s `AppClient.waitForEvent` uses — this
 * module only resolves the selector, applies MCP-specific defaults (`payloadMaxBytes`), and maps
 * that module's typed errors onto this tool's `tool_timeout`/`tool_execution_error`.
 */

import {
  RPC_METHODS,
  toAppEvent,
  type AppEvent,
  type EventsSinceResult,
  type SessionsDescribeResult,
} from "@appduct/shared";

import {
  waitForAppEvent,
  WaitForAppEventConnectionClosedError,
  WaitForAppEventTimeoutError,
} from "../events/index.js";
import { openDaemonStream, type SpawnFn } from "../rpc/client.js";
import type { DaemonCall } from "./daemon-tools.js";
import { McpBuiltinToolError } from "./connect-tool.js";

export const EVENTS_TOOL_NAME = "appduct_events";
export const WAIT_FOR_EVENT_TOOL_NAME = "appduct_wait_for_event";

/** `appduct_events`'s default `limit` when the caller gives none — matches `appduct_list_tools`
 * (issue #112), so an agent that never names a page size still gets a bounded one. */
const DEFAULT_EVENTS_LIMIT = 50;

/** `appduct_events`'s default `payloadMaxBytes` (issue #113) — a generous cap for a tool result an
 * agent reads directly, so one gigantic app-pushed payload can't blow out its context on its own.
 * `app.events()` (the SDK) sets no default; a script reading its own app's events already knows
 * what it expects. */
const DEFAULT_EVENTS_PAYLOAD_MAX_BYTES = 4096;

const DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS = 120_000;
/** Kept safely under the 30-minute idle window a stdio MCP server gets before Claude Code aborts a
 * tool call that has sent neither a response nor a progress notification (issue #6's "Constraint on
 * the blocking wait tool") — with margin for RPC round-trip and scheduling delay. */
const MAX_WAIT_FOR_EVENT_TIMEOUT_MS = 25 * 60 * 1000;
/** How often a progress notification is emitted during a live wait, when the caller supplied a
 * progress token — informational only (the timeout cap above is what actually keeps the call
 * within the idle window), but it gives a caller watching progress something to show. */
const WAIT_FOR_EVENT_PROGRESS_INTERVAL_MS = 60_000;

/** Server-side cap on `timeoutMs` (issue #6's "Cap timeoutMs server-side below the idle window
 * rather than trusting the caller") — a pure function so the cap's boundary behavior is
 * unit-testable without spinning up a daemon or actually waiting out either bound. */
export const clampWaitForEventTimeoutMs = (requestedMs: number | undefined): number => {
  return Math.min(requestedMs ?? DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS, MAX_WAIT_FOR_EVENT_TIMEOUT_MS);
};

export const EVENTS_TOOL_DESCRIPTOR = {
  name: EVENTS_TOOL_NAME,
  description:
    "Drain the events the app posted with postEvent(name, payload) that the daemon retained for a " +
    "session since a cursor, for checking what the app reported after calling a tool or " +
    "triggering app behavior. With no selector, targets the sole active/suspended session. " +
    "name filters to events whose name matches a whole-name, case-sensitive glob (* matches any " +
    "run of characters; a pattern without * is an exact name), e.g. \"cart.*\". Returns " +
    "{ events, cursor, dropped, remaining } with each event as { name, payload, ts, seq, " +
    "sessionId, alias } or, once a payload's JSON exceeds payloadMaxBytes (default 4096), as " +
    "{ name, payloadPreview, truncated: true, payloadBytes, ts, seq, sessionId, alias } instead — " +
    "check truncated before reading payload. pass cursor back as since on the next call to avoid " +
    "re-reading events you've already seen; dropped counts app events after since that were " +
    "evicted before this call could return them (0 once nothing has fallen off), and remaining counts events still " +
    "matching this query after the returned page (0 on the last page). limit (default 50) keeps " +
    "the OLDEST events in the window and advances cursor only past what was actually returned, so " +
    "repeated calls page forward through everything retained rather than skipping ahead.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      since: { type: "integer", minimum: 0 },
      limit: { type: "integer", exclusiveMinimum: 0 },
      name: { type: "string" },
      payloadMaxBytes: { type: "integer", exclusiveMinimum: 0 },
    },
    additionalProperties: false,
  },
} as const;

export const WAIT_FOR_EVENT_TOOL_DESCRIPTOR = {
  name: WAIT_FOR_EVENT_TOOL_NAME,
  description:
    "Wait for the connected app to push an event via postEvent(name, payload) whose name matches " +
    "name, a whole-name, case-sensitive glob (* matches any run of characters; a pattern without " +
    "* is an exact name, e.g. \"cart.*\", or \"*\" for the next event of any name). Checks " +
    "already-retained events first, so an event that already fired before this call still " +
    "resolves immediately; pass since (a cursor from a previous appduct_events/" +
    "appduct_wait_for_event call) to skip events you've already handled and wait only for a new " +
    "one — omitting it can return an old match instantly on every call. Requires a claimed " +
    "session to already exist (use appduct_wait_for_session first if not). Resolves with " +
    "{ sessionId, alias, name, payload, ts, seq, dropped } or, once a payload's JSON exceeds " +
    "payloadMaxBytes (default 4096), with { payloadPreview, truncated: true, payloadBytes } in " +
    "place of payload — check truncated before reading payload; dropped counts app events after " +
    "since that were evicted before this call could return them (0 once nothing has fallen off). " +
    "Rejects with tool_timeout after timeoutMs (default 120000ms, capped server-side at " +
    "1500000ms). A call still running after about two minutes moves to a Claude Code background " +
    "task, so the result may arrive well after this call returns.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      name: { type: "string" },
      since: { type: "integer", minimum: 0 },
      timeoutMs: { type: "number", exclusiveMinimum: 0 },
      payloadMaxBytes: { type: "integer", exclusiveMinimum: 0 },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

export type EventsToolDeps = {
  call: DaemonCall;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

const asOptionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a non-empty string.`);
  }

  return value;
};

/** `since`/`limit` mirror the daemon's own `asEventsSinceParams` (`daemon/daemon.ts`), which
 * requires integers — accepting e.g. `1.5` here would just round-trip to a `DaemonRpcError`
 * instead of this tool's own clearer `invalid_request`. */
const asOptionalNonNegativeInteger = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a non-negative integer.`);
  }

  return value;
};

const asOptionalPositiveInteger = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a positive integer.`);
  }

  return value;
};

/** `timeoutMs` is not required to be an integer (unlike the daemon's `since`/`limit`) — it's never
 * forwarded to the daemon verbatim, only used as this process's own `setTimeout` duration. */
const asOptionalPositiveNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a positive number.`);
  }

  return value;
};

/** `kinds` was removed when these tools started returning app events only (issue #98). The
 * handlers otherwise ignore unknown keys, so a caller still passing it is told rather than left
 * wondering why its filter did nothing. */
const rejectKinds = (args: Record<string, unknown>): void => {
  if (args.kinds !== undefined) {
    throw new McpBuiltinToolError(
      "invalid_request",
      '"kinds" is not supported: these tools return only the events the app posted with postEvent.',
    );
  }
};

/** `match` was removed (issue #114): `name` is now a glob on both `appduct_events` and
 * `appduct_wait_for_event`, so a payload predicate is no longer the only way to narrow beyond an
 * exact name. A caller that needs one loops on `appduct_wait_for_event` with `since`. The handlers
 * otherwise ignore unknown keys, so a caller still passing it is told rather than left wondering
 * why its filter did nothing. */
const rejectMatch = (args: Record<string, unknown>): void => {
  if (args.match !== undefined) {
    throw new McpBuiltinToolError(
      "invalid_request",
      '"match" is not supported: "name" is a glob, and a payload predicate is not offered on any surface — loop on appduct_wait_for_event with "since" instead.',
    );
  }
};

export type EventsToolResult = {
  events: AppEvent[];
  cursor: number;
  dropped: number;
  remaining: number;
};

export const handleEventsTool = async (rawArgs: unknown, deps: EventsToolDeps): Promise<EventsToolResult> => {
  const args = asRecord(rawArgs);
  rejectKinds(args);

  const result = await deps.call<EventsSinceResult>(RPC_METHODS.eventsSince, {
    selector: asOptionalString(args.selector, "selector"),
    since: asOptionalNonNegativeInteger(args.since, "since"),
    limit: asOptionalPositiveInteger(args.limit, "limit") ?? DEFAULT_EVENTS_LIMIT,
    name: asOptionalString(args.name, "name"),
    // Issue #113: this tool always caps a payload, so a caller reading the result straight into
    // its context can't be blown out by one gigantic app-pushed payload; `payloadMaxBytes` lets a
    // caller raise or lower that default.
    payloadMaxBytes: asOptionalPositiveInteger(args.payloadMaxBytes, "payloadMaxBytes") ?? DEFAULT_EVENTS_PAYLOAD_MAX_BYTES,
  });

  // `events.since` only ever retains `app_event`s, each carrying a `sessionId` — flattened here
  // (issue #112) so a caller gets `{ name, payload, ts, seq, sessionId, alias }` (or, once
  // truncated, `{ name, payloadPreview, truncated: true, payloadBytes, ts, seq, sessionId, alias }`,
  // issue #113) instead of the daemon's generic `kind`/`data` envelope.
  return {
    events: result.events
      .map((event) => (event.sessionId === undefined ? undefined : toAppEvent(event, event.sessionId)))
      .filter((event): event is AppEvent => event !== undefined),
    cursor: result.cursor,
    dropped: result.dropped,
    remaining: result.remaining,
  };
};

export type WaitForEventToolDeps = {
  stateDir: string;
  spawn?: SpawnFn;
  /** Present only when the incoming `tools/call` carried a progress token; used to emit periodic
   * "still waiting" progress notifications during a live wait. */
  progress?: {
    token: string | number;
    sendNotification: (notification: unknown) => Promise<void>;
  };
};

/** An `AppEvent` (full or truncated — issue #113) plus `dropped` from the drain (issue #114). */
export type WaitForEventToolResult = AppEvent & {
  /** App events after `since` that were evicted before this call could return them (`0` once
   * nothing has fallen off). */
  dropped: number;
};

export const handleWaitForEventTool = async (
  rawArgs: unknown,
  deps: WaitForEventToolDeps,
): Promise<WaitForEventToolResult> => {
  const args = asRecord(rawArgs);
  rejectKinds(args);
  rejectMatch(args);

  const selector = asOptionalString(args.selector, "selector");
  const name = asOptionalString(args.name, "name");

  if (!name) {
    throw new McpBuiltinToolError("invalid_request", '"name" must be a non-empty string.');
  }

  const since = asOptionalNonNegativeInteger(args.since, "since");
  const timeoutMs = clampWaitForEventTimeoutMs(asOptionalPositiveNumber(args.timeoutMs, "timeoutMs"));
  // Issue #114: same default as `appduct_events` (issue #113) — a caller reading this result
  // straight into its context can't be blown out by one gigantic app-pushed payload.
  const payloadMaxBytes =
    asOptionalPositiveInteger(args.payloadMaxBytes, "payloadMaxBytes") ?? DEFAULT_EVENTS_PAYLOAD_MAX_BYTES;

  const stream = await openDaemonStream({ stateDir: deps.stateDir, spawn: deps.spawn });

  try {
    // Resolve the selector to one concrete session up front (same shape as
    // `handleWaitForSessionTool`) so the buffer drain and the live subscription
    // (`waitForAppEvent`) target the exact same session — `events.subscribe`'s own
    // `sessionSelector` has no "sole session" default, so leaving it unresolved here would
    // silently widen the live half of the wait to every session. A `DaemonRpcError`
    // (no_session/ambiguous_session/unknown_session) propagates unchanged — `toolErrorContentFromError`
    // (mcp/server.ts) already maps it to its precise `data.type`.
    const described = await stream.call<SessionsDescribeResult>(RPC_METHODS.sessionsDescribe, { selector });

    const startedAt = Date.now();
    const progressTimer = deps.progress
      ? setInterval(() => {
          deps.progress!
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: deps.progress!.token,
                progress: Date.now() - startedAt,
                total: timeoutMs,
                message: `Still waiting for event "${name}"...`,
              },
            })
            .catch(() => {
              // A failed progress notification must never abort the wait itself.
            });
        }, WAIT_FOR_EVENT_PROGRESS_INTERVAL_MS)
      : undefined;

    try {
      const { event, dropped } = await waitForAppEvent(stream, {
        sessionId: described.sessionId,
        name,
        since,
        timeoutMs,
        payloadMaxBytes,
      });

      return { ...event, dropped };
    } catch (error) {
      if (error instanceof WaitForAppEventTimeoutError) {
        throw new McpBuiltinToolError("tool_timeout", error.message);
      }

      if (error instanceof WaitForAppEventConnectionClosedError) {
        throw new McpBuiltinToolError("tool_execution_error", error.message);
      }

      throw error;
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
      }
    }
  } finally {
    stream.close();
  }
};
