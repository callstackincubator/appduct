import type {
  BootstrapPayload,
  SessionId,
  StandardSchemaV1,
  StandardSchemaV1JsonSchema,
  ToolAnnotations,
} from "@appduct/shared";

/** Local app-side ceiling for a tool handler, matching the daemon's `tools.call` default (§5/§11). */
export const APPDUCT_DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/**
 * Unified client state (ARCHITECTURE.md §11), owned entirely by the native core since issue #48
 * phase 2: there is no longer a separate "raw native" state distinct from this one -- native's own
 * `getState()`/`onStateChange` already report `"reconnecting"` alongside the transport-level states.
 */
export type AppductClientState =
  "idle" | "connecting" | "active" | "reconnecting" | "closed";

/**
 * Options passed to `connect()`. Native fills `deviceManufacturer`/`deviceModel`/`deviceOs`
 * defaults when omitted; setting them here still overrides those defaults end-to-end (native reads
 * them off the decoded `AppductConnectInput` JSON).
 */
export type AppductConnectOptions = {
  ip: string;
  port: number;
  sessionId: SessionId;
  /** Base64url, 32 raw bytes. Required unless `resumeToken` is given. */
  token?: string;
  /** Base64url, 32 raw bytes. When present, native sends `session_resume` instead of `session_claim`. */
  resumeToken?: string;
  expiresAt: number;
  deviceManufacturer?: string;
  deviceModel?: string;
  deviceOs?: string;
  /**
   * The bootstrap deep link's separate `pin` query param (`bootstrap.ts`'s `extractLinkPin`),
   * distinct from and never part of the `appduct` v2 binary payload. Opt-in hardening dev-mode:
   * native trusts this for the connection alone whenever the effective trust mode is `"link"` —
   * the default in *every* build type when no build-time `cliPins` are configured, since trust
   * resolution consults no build-type signal (`docs/SECURITY.md` "Trust modes"). Embedded pins
   * always win, so a build with `cliPins` ignores this outright; a `"link"` build that carries no
   * usable `linkPin` keeps the existing hard error.
   */
  linkPin?: string;
};

/**
 * Effective trust/pin configuration this build was compiled with — read from the TurboModule's
 * `getConstants()`, which pulls from the exact same manifest/plist keys `resolveTrustedPins`
 * (`docs/tasks/05-explicit-trust-mode.md`) reads on both platforms, never a second parse. `trust`
 * is normally `"link"` or `"pin"` (the effective bucket — `"pin"` whenever embedded pins are
 * present, since they always win regardless of the raw config value); a hand-edited native config
 * with an unrecognized `trust` string surfaces that raw string here instead of being silently
 * coerced. On the `./noop` entry (no native module in this build) `trust` is the sentinel
 * `"absent"`, distinct from any real value, and `hasEmbeddedPins`/`allowPrivateLanOnly` do not
 * describe a real build — see `noop.ts`'s `getAppductBuildConfig`. Pin fingerprints themselves
 * are never exposed, only whether any are embedded.
 */
export type AppductBuildConfig = {
  trust: string;
  hasEmbeddedPins: boolean;
  allowPrivateLanOnly: boolean;
};

/** A decoded v2 bootstrap payload, plus the deep link's optional sibling `pin` param (see
 * `AppductConnectOptions.linkPin`) — `bootstrap.ts`'s `parseBootstrapUrl` produces this shape. */
export type AppductBootstrapConnectInput = BootstrapPayload & {
  linkPin?: string;
};

export type AppductConnectInput =
  AppductConnectOptions | AppductBootstrapConnectInput;

/** Per-call options for `connect()`, distinct from the payload being connected with. */
export type AppductConnectCallOptions = {
  /**
   * Replace a session that is already connecting or active instead of throwing.
   *
   * Reserved for a freshly delivered bootstrap deep link: something with local access to this
   * device just asked for *this* session, which outranks whatever is currently held (commonly a
   * lease restored after a Metro reload, possibly pointing at a daemon that no longer exists).
   * The existing connection is closed only after the new payload validates.
   */
  supersede?: boolean;
};

export type AppductBootstrapParseErrorCode =
  "invalid_url" | "missing_payload" | "invalid_payload" | "expired_payload";

/** Unified listener kinds (ARCHITECTURE.md §11): `addAppductListener(kind, cb)`. */
export type AppductListenerKind = "stateChange" | "sessionChange" | "error";

export type AppductUnifiedStateChangeEvent = {
  state: AppductClientState;
  /** Set on transitions into `closed`/`reconnecting`: `revoked`, `grace_expired`, `closed_by_app`, `socket_error`, `connect_error`, `background`, `foreground`. */
  reason?: string;
};

/**
 * Mirrors native's `onSessionChange` exactly: `sessionId`/`alias` go `null` once the session is
 * gone. `type` distinguishes a fresh claim from a resume from a loss; `reason` is set only when
 * `type` is `"lost"` (`revoked`, `grace_expired`, `closed_by_app`, or a terminal close reason from
 * the daemon — PROTOCOL.md §7). This mirrors the accompanying `stateChange` event's `reason`,
 * which says the same thing from the state machine's perspective rather than the session's.
 */
export type AppductSessionChangeEvent = {
  type: "claimed" | "resumed" | "lost";
  sessionId: string | null;
  alias: string | null;
  reason?: string;
};

/** One error channel for bootstrap parse/connect, socket, and tool-handler failures (§11). */
export type AppductUnifiedErrorEvent = {
  phase: "bootstrap" | "connect" | "socket" | "tool";
  message: string;
  cause?: unknown;
  code?: string;
  nativeCode?: string;
  closeReason?: string;
  isRetryable?: boolean;
  hint?: string;
  toolName?: string;
  invocationId?: string;
};

export type AppductUnifiedListenerMap = {
  stateChange: (event: AppductUnifiedStateChangeEvent) => void;
  sessionChange: (event: AppductSessionChangeEvent) => void;
  error: (event: AppductUnifiedErrorEvent) => void;
};

/**
 * Reports incremental progress for the in-flight tool call (ARCHITECTURE.md §7's
 * `tool_call_progress` frame). Best-effort: failures are reported on the unified `error` channel
 * (phase `"tool"`), never thrown back into the handler. Both arguments are optional — call with
 * neither to send a bare progress ping.
 */
export type AppductReportProgress = (
  progress?: number,
  message?: string,
) => Promise<void>;

export type AppductToolExecutionContext = {
  sessionId: SessionId;
  invocationId: string;
  receivedAt: string;
  reportProgress: AppductReportProgress;
  /** Aborted when native reports `onToolCancel` for this call: an explicit `tool_cancel` frame, a
   * core-owned per-call timeout, or session suspension. Handlers may ignore it — they then run to
   * completion as before. */
  signal: AbortSignal;
};

export type AppductToolHandler<TArgs = unknown, TResult = unknown> = (
  args: TArgs,
  context: AppductToolExecutionContext,
) => TResult | Promise<TResult>;

/**
 * A raw JSON Schema object handed straight to `inputSchema`/`outputSchema` (ARCHITECTURE.md §11).
 *
 * Recognised at runtime purely by the *absence* of `~standard`, so any plain object works — there
 * is no wrapper to import. It is forwarded to the daemon verbatim and **never validated app-side**:
 * a handler with a raw input schema receives `tool_call.args` exactly as the caller sent them.
 *
 * The type parameters are phantom (never present at runtime). They are set only by the
 * `jsonSchema<T>()` helper below, which is how a raw schema still gets real handler argument/result
 * types; a bare object literal infers `Record<string, unknown>` instead. They mirror Standard
 * Schema's own two: `Input` is the pre-validation type an `outputSchema` handler may *return*,
 * `Output` the post-validation type an `inputSchema` handler *receives* — so the raw member of
 * {@link AppductRuntimeSchema} tracks both sides of an annotation instead of collapsing them.
 *
 * A JSON Schema value typed as an interface (`JSONSchema7` from `@types/json-schema`, say) is not
 * assignable to `Record<string, unknown>` — TypeScript gives implicit index signatures to type
 * aliases, not interfaces. Wrap it in `jsonSchema<T>()` or cast it.
 */
export type AppductJsonSchemaObject<
  Input = unknown,
  Output = Input,
> = Record<string, unknown> & {
  /** Phantom marker; `jsonSchema<T>()` only casts, it never writes this property. */
  readonly "~appductJsonSchemaTypes"?: {
    readonly input: Input;
    readonly output: Output;
  };
};

/**
 * `{ input, output }` JSON Schema exporter — the same shape Standard JSON Schema puts on
 * `~standard.jsonSchema`. Accepted as the `jsonSchema` half of a {@link AppductPairedSchema} so
 * one converter (e.g. a `zod-to-json-schema` wrapper) can serve both slots.
 */
export type AppductJsonSchemaConverter =
  StandardSchemaV1JsonSchema.Converter;

/**
 * A Standard Schema paired with the JSON Schema to publish for it — the supported form for
 * libraries that validate but cannot export JSON Schema themselves (zod 3, plain valibot, arktype
 * without an adapter).
 *
 * `schema` still drives runtime validation (`~standard.validate`), so handler argument and result
 * types are inferred exactly as they are for zod 4. `jsonSchema` is either a ready JSON Schema
 * object or an `{ input, output }` converter; only the half matching the slot this pair is used in
 * is ever called.
 */
export type AppductPairedSchema<Input = unknown, Output = Input> = {
  readonly schema: StandardSchemaV1<Input, Output>;
  readonly jsonSchema: Record<string, unknown> | AppductJsonSchemaConverter;
};

/**
 * Everything `inputSchema`/`outputSchema` accept (ARCHITECTURE.md §11): a Standard Schema (with or
 * without a `~standard.jsonSchema` exporter), a `{ schema, jsonSchema }` pair, or a raw JSON Schema
 * object.
 *
 * All three members carry *both* of the annotation's types, so an annotated
 * `AppductRuntimeSchema<In, Out>` gives a handler exactly `Out` for its arguments and exactly
 * `In` for its result. The raw member is parameterized precisely so it cannot widen either back to
 * `Record<string, unknown>`, nor collapse the two into `In | Out`.
 */
export type AppductRuntimeSchema<Input = unknown, Output = Input> =
  | StandardSchemaV1<Input, Output>
  | AppductPairedSchema<Input, Output>
  | AppductJsonSchemaObject<Input, Output>;

/**
 * Tags a raw JSON Schema object with the argument/result type its handler should see. Purely a
 * type-level cast — the object is returned unchanged, nothing is validated, and no runtime check
 * ever confirms that `T` matches the schema.
 *
 * ```ts
 * inputSchema: jsonSchema<{ city: string }>({
 *   type: "object",
 *   properties: { city: { type: "string" } },
 *   required: ["city"],
 * })
 * ```
 */
export const jsonSchema = <T = Record<string, unknown>>(
  schema: Record<string, unknown>,
): AppductJsonSchemaObject<T, T> =>
  schema as AppductJsonSchemaObject<T, T>;

/**
 * Runtime shape an `inputSchema`/`outputSchema` takes once `normalizeToolSchema` (`schema.ts`) has
 * classified it. Stored on {@link AppductRegisteredTool} so export and validation never re-sniff
 * the user's value.
 */
export type AppductNormalizedToolSchema =
  | { kind: "standard"; schema: StandardSchemaV1 }
  | {
      kind: "paired";
      schema: StandardSchemaV1;
      jsonSchema: Record<string, unknown> | AppductJsonSchemaConverter;
    }
  | { kind: "raw"; jsonSchema: Record<string, unknown> };

/**
 * Handler argument type for an `inputSchema`. Paired and plain Standard Schemas both infer the
 * schema's *output* (post-validation) type; a raw JSON Schema infers whatever `jsonSchema<T>()`
 * declared, or `Record<string, unknown>` for a bare object.
 *
 * `InferToolArgs<undefined>` is `undefined`. Note that a registration that simply *omits*
 * `inputSchema` gives its handler `unknown`, not `undefined`: with no property to infer from,
 * `registerTool`'s type parameter falls back to its constraint
 * (`AppductRuntimeSchema | undefined`), and this type distributes over that union. That has
 * always been the behaviour and is unchanged here.
 */
export type InferToolArgs<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : TSchema extends { readonly schema: infer S extends StandardSchemaV1 }
    ? StandardSchemaV1.InferOutput<S>
    : TSchema extends AppductJsonSchemaObject<unknown, infer Output>
      ? unknown extends Output
        ? Record<string, unknown>
        : Output
      : undefined;

/**
 * Handler result type for an `outputSchema` — the mirror of {@link InferToolArgs}, using the
 * schema's *input* (pre-validation) type so a handler may return whatever the schema accepts.
 */
export type InferToolResult<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<TSchema>
  : TSchema extends { readonly schema: infer S extends StandardSchemaV1 }
    ? StandardSchemaV1.InferInput<S>
    : TSchema extends AppductJsonSchemaObject<infer Input, unknown>
      ? unknown extends Input
        ? Record<string, unknown>
        : Input
      : void;

export type AppductToolDefinition<
  TInputSchema extends AppductRuntimeSchema | undefined = undefined,
  TOutputSchema extends AppductRuntimeSchema | undefined = undefined,
> = {
  name: string;
  description: string;
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  annotations?: ToolAnnotations;
  /**
   * Overrides the default 10 s app-side handler timeout (ARCHITECTURE.md §11), enforced entirely
   * by the native core. On timeout native replies `tool_timeout` and emits `onToolCancel(id,
   * "timeout")`; a later result from the same invocation is ignored.
   *
   * Declared here it also travels on the tool descriptor and becomes the daemon's default deadline
   * for this tool, so a caller that passes no timeout of its own (an MCP agent, `appduct invoke`
   * with no `--timeout`) gets the same budget instead of the daemon's 10 s. Must be a positive
   * integer to make that trip — anything else stays app-side only, with a dev warning. The
   * client-wide `defaultToolTimeoutMs` is deliberately never sent.
   */
  timeoutMs?: number;
  /**
   * The group this tool belongs to: a top-level group (`"checkout"`) or a subgroup
   * (`"checkout/payment"`) — one or two `/`-separated segments, each `[a-zA-Z0-9_-]{1,64}`.
   * Agents list a large app's tools one group at a time (`appduct tools --groups`, then
   * `--group checkout`, which includes `checkout/*`). Optional; an ungrouped tool is listed under
   * `(ungrouped)`. A malformed group makes registration throw, like a malformed `name`.
   * `createToolGroup("checkout")` binds it for a whole feature module.
   */
  group?: string;
};

export type AppductToolRegistration<
  TInputSchema extends AppductRuntimeSchema | undefined = undefined,
  TOutputSchema extends AppductRuntimeSchema | undefined = undefined,
> = AppductToolDefinition<TInputSchema, TOutputSchema> & {
  handler: AppductToolHandler<
    InferToolArgs<TInputSchema>,
    InferToolResult<TOutputSchema>
  >;
};

export type AppductRegisteredTool = {
  /** Registration identity: `remove()` disposers compare this, not the tool name (stale-disposer fix). */
  id: symbol;
  name: string;
  /** Normalized at registration time (`schema.ts`'s `normalizeToolSchema`), never the raw user value. */
  inputSchema?: AppductNormalizedToolSchema;
  outputSchema?: AppductNormalizedToolSchema;
  handler: AppductToolHandler;
};

export class AppductBootstrapParseError extends Error {
  code: AppductBootstrapParseErrorCode;

  constructor(code: AppductBootstrapParseErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AppductBootstrapParseError";
  }
}

/** `connect()` rejects with this on the `./noop` entry (ARCHITECTURE.md §11: compile-out builds). */
export class AppductDisabledError extends Error {
  code = "appduct_disabled" as const;

  constructor() {
    super("Appduct is disabled in this build (the ./noop entry is in use).");
    this.name = "AppductDisabledError";
  }
}
