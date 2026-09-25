import type { ErrorType } from "./errors.js";
import type { AgentEndpoint } from "./transport.js";
import type { ToolDescriptor, ToolGroupSummary } from "./tool-descriptor.js";

/** Control-plane RPC method name constants (ARCHITECTURE.md §5). Types only — no transport here. */
export const RPC_METHODS = {
  daemonStatus: "daemon.status",
  daemonShutdown: "daemon.shutdown",
  linkCreate: "link.create",
  sessionsList: "sessions.list",
  sessionsDescribe: "sessions.describe",
  sessionsRevoke: "sessions.revoke",
  toolsList: "tools.list",
  toolsCall: "tools.call",
  toolsCancel: "tools.cancel",
  eventsSubscribe: "events.subscribe",
  eventsSince: "events.since",
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

/** ARCHITECTURE.md §6 session state machine. */
export type SessionState = "pending" | "active" | "suspended" | "discarded" | "expired" | "revoked";

export type SessionDeviceMetadata = {
  manufacturer?: string;
  model?: string;
  os?: string;
};

export type SessionSummary = {
  sessionId: string;
  alias: string;
  state: SessionState;
  device: SessionDeviceMetadata;
  /** ISO 8601. */
  createdAt: string;
  claimedAt?: string;
  suspendedAt?: string;
  toolCount: number;
};

/** `sessions.describe` returns full session detail; today that is the same shape as `SessionSummary`. */
export type SessionDetail = SessionSummary;

export type SessionSelectorParams = {
  /** Session id or alias; omitted selects the sole active/suspended session (or errors — §5). */
  selector?: string;
};

// --- daemon.status ---

/** Wire-safe mirror of `daemon/config.ts`'s `PolicyDecision` (ARCHITECTURE.md §12). */
export type EffectivePolicyDecision = "allow" | "deny" | "prompt";

/** Wire-safe mirror of `daemon/config.ts`'s `AppductPolicyConfig` (ARCHITECTURE.md §12):
 * `daemon.status`'s effective policy, exactly as loaded from `config.json` plus defaults. */
export type EffectivePolicyConfig = {
  default: EffectivePolicyDecision;
  destructive: EffectivePolicyDecision;
  tools?: Record<string, EffectivePolicyDecision>;
};

export type DaemonStatusResult = {
  version: string;
  pid: number;
  /** ISO 8601. */
  startedAt: string;
  wssPort: number;
  pinnedKeys: string[];
  sessions: SessionSummary[];
  /**
   * Outstanding pending links — minted by `link.create`, not yet claimed or expired. They are not
   * sessions (they never enter the session map, ARCHITECTURE.md §6) but they are live state a
   * daemon restart destroys, so a caller deciding whether restarting is safe has to see them
   * (issue #30). Absent from daemons that predate this field.
   */
  pendingLinks?: number;
  /** Effective policy configuration (ARCHITECTURE.md §12). */
  policy: EffectivePolicyConfig;
  /** Audit log surfacing (ARCHITECTURE.md §12): where records land, how many writes failed, and
   * the retention footprint (ARCHITECTURE.md §3) so an operator can see the directory growing. */
  audit: {
    path: string;
    failedWrites: number;
    /** Retention sweeps that failed to delete a day file since the daemon started. */
    failedPrunes: number;
    /** Effective `config.auditRetentionDays`. */
    retentionDays: number;
    /** `<YYYY-MM-DD>.jsonl` day files currently retained. Absent when the daemon could not read
     * the audit directory at all — distinct from `0`, which asserts it is empty. */
    files?: number;
    /** Total bytes across those files; absent under the same conditions as `files`. */
    bytes?: number;
  };
};

// --- daemon.shutdown ---

export type DaemonShutdownResult = { ok: true };

// --- link.create ---

export type LinkCreateParams = {
  ttlSeconds?: number;
  /** Forces the advertised address encoded into the bootstrap payload (ARCHITECTURE.md §8's
   * emulator/simulator fast path: `127.0.0.1`, since the wss listener already binds all
   * interfaces). Omitted for the normal LAN/QR delivery path. */
  addressOverride?: string;
};

export type LinkCreateResult = {
  sessionId: string;
  /** Base64url bootstrap blob; callers compose `<scheme>:///?appduct=<deepLinkPayload>`. */
  deepLinkPayload: string;
  endpoint: AgentEndpoint;
  /** Unix seconds. */
  expiresAt: number;
  /**
   * The daemon's SPKI pin (`sha256/<44-char-base64>`, same value as `daemon.status`'s
   * `pinnedKeys[0]` / `appduct keygen`'s output), composed by callers into the deep link's
   * separate `pin` query param, alongside the existing `appduct` bootstrap blob (see
   * ARCHITECTURE.md §8 for that blob's binary layout, unchanged here). Old apps must keep
   * ignoring this param. Native clients trust it for that link's session alone whenever their
   * effective trust mode is `"link"` — the default in every build type when no build-time
   * `cliPins` are configured; embedded pins always win.
   */
  pin: string;
};

// --- sessions.list / sessions.describe / sessions.revoke ---

export type SessionsListResult = SessionSummary[];

export type SessionsDescribeParams = SessionSelectorParams;
export type SessionsDescribeResult = SessionDetail;

export type SessionsRevokeParams = SessionSelectorParams;
export type SessionsRevokeResult = { ok: true };

// --- tools.list / tools.call ---

/** `tools.list`'s `filter` string cap (ARCHITECTURE.md §5) — generous for a name/description
 * substring search, small enough that a malicious/buggy caller can't use it to bloat a request. */
export const MAX_TOOLS_FILTER_LENGTH = 256;

export type ToolsListParams = SessionSelectorParams & {
  /** Only tools in this group (PROTOCOL.md §5 group syntax), matched by segment: `checkout`
   * includes every `checkout/*` subgroup, `checkout/payment` is exactly that subgroup, and
   * `checkout` never matches `checkoutx`. Case-sensitive. */
  group?: string;
  /** Case-insensitive substring match against name and description. */
  filter?: string;
  /** Page size; omitted means everything from `offset` on. */
  limit?: number;
  /** Zero-based start index into the sorted, filtered list. */
  offset?: number;
};

/**
 * A tool as a *listing* describes it: every `ToolDescriptor` field, but with the listing's spelling
 * of "no group". This is the type to read a `tools.list` entry with; `ToolDescriptor` is the
 * registration side, and an app that registers `group: null` is rejected.
 */
export type ListedToolDescriptor = Omit<ToolDescriptor, "group"> & {
  /**
   * Always present on a listing: the tool's group, or `null` when it has none. Apps register an
   * ungrouped tool by *omitting* `group`; the daemon normalises that to `null` here so that entries
   * and the `groups` summary speak one vocabulary (see `ToolDescriptor.group`). A daemon predating
   * tool groups omits the key entirely, which callers normalise with `entry.group ?? null`.
   */
  group: string | null;
};

/** A `tools.list` entry: the tool as the listing describes it plus the policy decision
 * (ARCHITECTURE.md §12) that would apply to it right now — resolved daemon-side (it needs
 * `session.alias` and `config.policy`) so the MCP server knows which calls need an elicitation
 * prompt without a second round trip. */
export type ToolsListEntry = ListedToolDescriptor & {
  policy: EffectivePolicyDecision;
};

/**
 * `tools.list`'s result: the registry sorted by `name` (plain code-point order, so it is
 * deterministic across locales), narrowed to `group`, `filter`ed, then paged with `limit`/`offset`
 * — `total` is the count *after* the group and filter but *before* paging, so a caller (the CLI)
 * can say how many tools were left out of the page it got back.
 */
export type ToolsListResult = {
  tools: ToolsListEntry[];
  /** Tools matching `group` and `filter`, before `limit`/`offset` were applied. */
  total: number;
  /**
   * The session's groups with tool counts, over the whole registry — never narrowed by `group`,
   * `filter`, `limit` or `offset`, so a caller can always see what there is to narrow to. One
   * entry per top-level group (its `total` includes its subgroups), one per subgroup, and a
   * `group: null` entry for ungrouped tools when there are any. Sorted by group path with a parent
   * right before its subgroups, `null` last. Empty for an empty registry.
   */
  groups: ToolGroupSummary[];
};

export type ToolsCallParams = SessionSelectorParams & {
  name: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  /** Attribution for the audit log (ARCHITECTURE.md §12): who issued this call. The MCP server
   * always sets `"mcp"`, the `appduct/client` package always sets `"client"`; omitted (the
   * CLI's case) defaults to `"cli"` at the daemon. */
  caller?: "cli" | "mcp" | "client";
  /**
   * Set by this codebase's own MCP server as evidence a `"prompt"`-policy tool's human gate was
   * satisfied (ARCHITECTURE.md §12) — the daemon trusts this param verbatim once present, and
   * everything else (CLI, an MCP client without elicitation) is denied (`policy_denied`, reason
   * `no_consent_channel`). The only value is `"elicitation"` (issue #10): the server sent an
   * `elicitation/create` request over this connection and the client's reply was
   * `action: "accept"`. It works on any client that declares the `elicitation` capability at
   * `initialize`.
   *
   * The daemon cannot itself re-verify the client-side prompt, so this is not a defense against
   * another local process (one with access to the same `daemon.sock`) sending this param directly —
   * see `docs/SECURITY.md`'s threat model, which already treats socket access as full daemon
   * control. `"prompt"` fails closed by design when the client has no elicitation support.
   */
  consent?: "elicitation";
};

export type ToolsCallResult = {
  result: unknown;
  /** The `tool_call`/`tool_call_progress`/`tool_call_finished` correlation id (ARCHITECTURE.md
   * §7's `call_…` id), exposed so a caller with several in-flight `tools.call`s (e.g. the MCP
   * server running concurrent `appduct_call_tool` requests) can match its own call to the progress events
   * it sees on `events.subscribe` without guessing from data shape. */
  callId: string;
};

// --- tools.cancel ---

export type ToolsCancelParams = SessionSelectorParams & {
  /** The `callId` returned by the `tools.call` this cancels. */
  callId: string;
  reason?: string;
};

export type ToolsCancelResult = {
  /** `false` when `callId` was unknown or already finished — a no-op, not an error. */
  cancelled: boolean;
};

// --- events.subscribe ---

/** The single source of truth for the `EventKind` union below — a `const` array (not just a type)
 * so runtime validators (the daemon's `events.subscribe`/`events.since` param parsing, the MCP
 * `appduct_events`/`appduct_wait_for_event` tool schemas) can derive their allow-list from it
 * instead of hand-maintaining a second copy that can silently drift from this type. */
export const EVENT_KINDS = [
  "daemon_started",
  "link_created",
  "link_expired",
  "session_claimed",
  "session_suspended",
  "session_resumed",
  "session_revoked",
  "session_expired",
  "tools_changed",
  "app_event",
  "tool_call_started",
  "tool_call_progress",
  "tool_call_finished",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type EventsSubscribeParams = {
  sessionSelector?: string;
  kinds?: EventKind[];
  /** Whole-name, case-sensitive glob (issue #112): `*` matches any run of characters, a pattern
   * with no `*` is an exact name. Applies only to `app_event`s pushed on this subscription — every
   * other kind is delivered unfiltered, since only an app event carries a `name`. */
  name?: string;
  /**
   * Caps an `app_event`'s payload to this many UTF-8 bytes of its JSON (issue #113), applied
   * through `projectAppEvent` (`daemon/event-bus.ts`) to every notification pushed on this
   * subscription. Omitted, payloads are delivered whole. No default here — a caller that wants a
   * cap on live events must ask for one; see `appduct_events`/`app.events()` for callers that
   * default it.
   */
  payloadMaxBytes?: number;
};

export type EventsSubscribeResult = { ok: true };

/** Server→client `event` notification payload pushed on any connection with an active subscription. */
export type EventNotification = {
  kind: EventKind;
  sessionId?: string;
  alias?: string;
  /** Unix ms. */
  ts: number;
  data: unknown;
  /**
   * Monotonically increasing per-session cursor (ARCHITECTURE.md §5), assigned by the daemon-side
   * retention buffer at emit time. Only `app_event` ever advances it (issue #113) — every other
   * kind, session-scoped or not, carries `seq: 0`, since only `app_event` is retained and `dropped`
   * (below) is worked out from its `seq` alone. Pass the highest `seq` seen back into
   * `events.since`'s `since` to resume after it.
   */
  seq: number;
};

// --- events.since ---

/** Pulls the app events (`app_event` only) retained in the daemon's per-session ring buffer
 * (ARCHITECTURE.md §5) — the request/response counterpart to `events.subscribe`'s push model, for
 * callers (MCP tools, a scripted `appduct events since`) that ask "what did the app report?"
 * after the fact instead of listening live. */
export type EventsSinceParams = {
  /** Session id or alias; omitted selects the sole active/suspended session (same default as
   * `SessionSelectorParams`). */
  selector?: string;
  /** Exclusive lower bound on `EventNotification.seq`; omitted returns the whole retained buffer
   * (oldest first, subject to `limit`). */
  since?: number;
  /** Caps the number of events returned (oldest kept); omitted returns everything after `since`
   * up to the buffer's own retention limit. */
  limit?: number;
  /** Whole-name, case-sensitive glob (issue #112): `*` matches any run of characters, a pattern
   * with no `*` is an exact name. Applies only to `app_event`s. */
  name?: string;
  /** Caps an `app_event`'s payload to this many UTF-8 bytes of its JSON (issue #113); see
   * `EventsSubscribeParams.payloadMaxBytes`. No default here either — `appduct_events`/
   * `app.events()` each choose their own. */
  payloadMaxBytes?: number;
};

export type EventsSinceResult = {
  events: EventNotification[];
  /** The highest `seq` currently retained for this session (not just among the returned events),
   * so a caller can pass it straight back into the next `since` even when `limit` truncated the
   * response or nothing new had happened. */
  cursor: number;
  /**
   * How many app events after `since` were evicted before this call could return them (issue
   * #113): `max(0, oldest.seq - since - 1)`, where `oldest` is the buffer's current oldest
   * retained entry — `0` once nothing has fallen off (including when only never-retained kinds
   * were emitted in between, since those never advance `seq`).
   */
  dropped: number;
  /** How many events still match this query (`since`, `name`) after the returned page — the
   * count `limit` cut off, not the whole buffer. `0` on the last page. */
  remaining: number;
};

/** An app-pushed event (`postEvent(name, payload)`) whose payload came back whole — narrowed from
 * the daemon's generic `EventNotification` envelope to the shape a consumer actually wants
 * (issue #112). This is what `appduct/client`'s `events()`/`waitForEvent()` and the built-in
 * `appduct_events` MCP tool return when no `payloadMaxBytes` is in play, so existing `event.payload`
 * reads keep compiling unchanged (issue #113's overload decision, #94). */
export type FullAppEvent<TPayload = unknown> = {
  name: string;
  payload: TPayload;
  /** Unix ms. */
  ts: number;
  sessionId: string;
  alias?: string;
  /** Monotonically increasing per-session cursor (ARCHITECTURE.md §5) assigned by the daemon's
   * retention buffer at emit time — pass back into `since` to resume after this event. */
  seq: number;
  truncated?: false;
};

/** The same app-pushed event, but whose payload's JSON was over a `payloadMaxBytes` cap and was
 * replaced with a preview (issue #113): `payloadBytes` is the UTF-8 byte length of the full
 * payload's JSON, and `payloadPreview` is the longest prefix of that JSON fitting in
 * `payloadMaxBytes` bytes without splitting a code point. There is no `payload` to read. */
export type TruncatedAppEvent = {
  name: string;
  payloadPreview: string;
  payloadBytes: number;
  truncated: true;
  /** Unix ms. */
  ts: number;
  sessionId: string;
  alias?: string;
  seq: number;
};

/**
 * An app-pushed event as a caller that supplied `payloadMaxBytes` sees it: either the full shape
 * (`truncated` absent/`false`, `payload` present) or the truncated one (`truncated: true`,
 * `payloadPreview`/`payloadBytes`, no `payload`). Narrow on `truncated` before reading `payload` —
 * TypeScript rejects an unnarrowed read (issue #113). A caller that never passes
 * `payloadMaxBytes` gets {@link FullAppEvent} instead and needs no narrowing at all.
 */
export type AppEvent<TPayload = unknown> = FullAppEvent<TPayload> | TruncatedAppEvent;

/** Narrows an `app_event` `EventNotification` to an {@link AppEvent}, or `undefined` when the
 * notification isn't an app event for `sessionId`, or carries no string `name`. The one
 * implementation `appduct/client` and `appduct_events` both call, so they can't disagree about
 * the flat shape. Reads whichever data shape the daemon already produced (`daemon/event-bus.ts`'s
 * `projectAppEvent` decides full vs. truncated at emit/drain time) rather than re-deciding here. */
export const toAppEvent = (event: EventNotification, sessionId: string): AppEvent | undefined => {
  if (event.kind !== "app_event" || event.sessionId !== sessionId) {
    return undefined;
  }

  const data = event.data as { name?: unknown; payload?: unknown; payloadPreview?: unknown; payloadBytes?: unknown; truncated?: unknown };

  if (typeof data.name !== "string") {
    return undefined;
  }

  if (data.truncated === true) {
    return {
      name: data.name,
      payloadPreview: typeof data.payloadPreview === "string" ? data.payloadPreview : "",
      payloadBytes: typeof data.payloadBytes === "number" ? data.payloadBytes : 0,
      truncated: true,
      ts: event.ts,
      sessionId: event.sessionId!,
      alias: event.alias,
      seq: event.seq,
    };
  }

  return {
    name: data.name,
    payload: data.payload,
    ts: event.ts,
    sessionId: event.sessionId!,
    alias: event.alias,
    seq: event.seq,
  };
};

// --- JSON-RPC 2.0 error shape ---

/** `error.data.type` preserves the wire/app error type verbatim end-to-end (never re-wrapped). */
export type RpcErrorData = {
  type: ErrorType;
  [key: string]: unknown;
};

export type RpcError = {
  code: number;
  message: string;
  data?: RpcErrorData;
};
