import type { TurboModule } from "react-native";
import { TurboModuleRegistry, CodegenTypes } from "react-native";

/**
 * TurboModule spec for the phase-2 native core (issue #48, docs/tasks/15-native-session-logic.md).
 *
 * Every structured value crosses the bridge as a JSON string: the native core owns the wire
 * protocol (PROTOCOL.md) and JSON is its native currency, and it sidesteps Codegen's limits on
 * nested/optional object shapes. JS validates nothing about session or transport state any more;
 * it converts schemas, runs handlers, and validates handler input/output against the registered
 * schema. Everything else — reconnect, grace, lease restore, registry snapshots/deltas, timeouts,
 * cancel, progress, the seven `tool_error` types — lives in `packages/native`.
 */

/**
 * Effective trust/pin configuration this build was compiled with, read via `getConstants()` from
 * the exact same manifest (Android)/plist (iOS) keys the core's `resolveTrustedPins` reads.
 * `trust` reports the *effective* bucket: `"pin"` whenever embedded pins are present, `"link"`
 * otherwise, or the raw unrecognized string a connect attempt would reject. Pin fingerprints are
 * never exposed; only `hasEmbeddedPins`.
 */
export type CordieriteBuildConfigNative = {
  trust: string;
  hasEmbeddedPins: boolean;
  allowPrivateLanOnly: boolean;
};

/** Mirrors `CordieriteUnifiedErrorEvent` in `Cordierite.types.ts` minus `cause` (not serializable). */
export type CordieriteErrorEventNative = {
  /** "bootstrap" | "connect" | "socket" | "tool" */
  phase: string;
  message: string;
  code?: string;
  nativeCode?: string;
  closeReason?: string;
  isRetryable?: boolean;
  hint?: string;
  toolName?: string;
  invocationId?: string;
};

/** Mirrors `CordieriteUnifiedStateChangeEvent`: `state` is a `CordieriteClientState`. */
export type CordieriteStateChangeEventNative = {
  state: string;
  reason?: string;
};

/** Mirrors `CordieriteSessionChangeEvent`. Both null once the session is gone. */
export type CordieriteSessionChangeEventNative = {
  sessionId: string | null;
  alias: string | null;
};

/** Native → JS: run the registered handler for `name` and answer with `respondToToolCall`. */
export type CordieriteToolCallEventNative = {
  id: string;
  name: string;
  /** JSON object, exactly the wire `tool_call.args`. */
  argsJson: string;
};

/** Native → JS: abort the handler's signal. Native has already answered the daemon. */
export type CordieriteToolCancelEventNative = {
  id: string;
  /** "client_cancelled" | "timeout" | "session_suspended" | the wire `tool_cancel.reason`. */
  reason: string;
};

export interface Spec extends TurboModule {
  /**
   * Registers (or replaces, by name) a tool. `descriptorJson` is a PROTOCOL.md §5
   * `ToolDescriptor` object; native validates it with the same rules the daemon applies and
   * throws on an invalid one. While a session is active, native sends `tool_registry_delta`.
   */
  registerTool(descriptorJson: string): void;
  unregisterTool(name: string): void;

  /**
   * Feeds a deep link to the core. Returns `true` iff the URL carried a `cordierite` query param
   * (whatever the parse outcome — a bad payload is reported on `onError` with phase "bootstrap"),
   * `false` for any other URL so the app can route it itself. A valid payload supersedes whatever
   * session is currently held.
   */
  handleUrl(url: string): boolean;

  /**
   * Programmatic connect. `inputJson` is a `CordieriteConnectInput` (a decoded bootstrap payload
   * plus optional `linkPin`, or explicit `{ ip, port, sessionId, token, expiresAt, linkPin? }`);
   * device metadata is filled in natively. Resolves once the session is active; rejects with the
   * same error shapes `connect()` rejects with today.
   */
  connect(inputJson: string, supersede: boolean): Promise<void>;

  /** Resume from the in-process lease. Resolves `true` iff a resume attempt was started. */
  restoreSession(): Promise<boolean>;

  /** Closes the socket, clears the lease, state → "closed". Idempotent. */
  disconnect(): Promise<void>;

  /** `payloadJson` is any JSON value or null (omitted on the wire). Rejects when no session is active. */
  postEvent(name: string, payloadJson: string | null): Promise<void>;

  /**
   * Answers an `onToolCall`. Exactly one of `resultJson` (any JSON value, "null" allowed) or
   * `errorJson` (`{ type, message, details? }` with a PROTOCOL.md §4 `tool_error.error.type`) is
   * non-null. Answering an unknown or already-finished `id` is a no-op.
   */
  respondToToolCall(id: string, resultJson: string | null, errorJson: string | null): void;
  reportToolProgress(id: string, progress: number | null, message: string | null): void;

  /** A `CordieriteClientState`: "idle" | "connecting" | "active" | "reconnecting" | "closed". */
  getState(): string;
  getSessionId(): string | null;
  /** JSON array of the registered `ToolDescriptor`s, in registration order. */
  getRegisteredToolsJson(): string;
  getConstants(): CordieriteBuildConfigNative;

  readonly onToolCall: CodegenTypes.EventEmitter<CordieriteToolCallEventNative>;
  readonly onToolCancel: CodegenTypes.EventEmitter<CordieriteToolCancelEventNative>;
  readonly onStateChange: CodegenTypes.EventEmitter<CordieriteStateChangeEventNative>;
  readonly onSessionChange: CodegenTypes.EventEmitter<CordieriteSessionChangeEventNative>;
  readonly onError: CodegenTypes.EventEmitter<CordieriteErrorEventNative>;
}

export const NativeCordierite =
  TurboModuleRegistry.getEnforcing<Spec>("Cordierite");
