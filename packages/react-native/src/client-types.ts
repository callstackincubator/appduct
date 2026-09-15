export type EventSubscription = {
  remove(): void;
};

/** Native → JS: run the registered handler for `name` and answer with `respondToToolCall`. */
export type AppductNativeToolCallEvent = {
  id: string;
  name: string;
  /** JSON object, exactly the wire `tool_call.args`. */
  argsJson: string;
};

/** Native → JS: abort the handler's signal. Native has already answered the daemon. */
export type AppductNativeToolCancelEvent = {
  id: string;
  /** "client_cancelled" | "timeout" | "session_suspended" | the wire `tool_cancel.reason`. */
  reason: string;
};

export type AppductNativeStateChangeEvent = {
  state: string;
  reason?: string;
};

export type AppductNativeSessionChangeEvent = {
  /** "claimed" | "resumed" | "lost" */
  type: string;
  sessionId: string | null;
  alias: string | null;
  /** Set only when `type` is `"lost"`: `revoked`, `grace_expired`, `closed_by_app`, or a
   * PROTOCOL.md §7 terminal close reason. */
  reason?: string;
};

export type AppductNativeErrorEvent = {
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

export type AppductNativeEvents = {
  toolCall: (event: AppductNativeToolCallEvent) => void;
  toolCancel: (event: AppductNativeToolCancelEvent) => void;
  stateChange: (event: AppductNativeStateChangeEvent) => void;
  sessionChange: (event: AppductNativeSessionChangeEvent) => void;
  error: (event: AppductNativeErrorEvent) => void;
};

/**
 * Structural seam for the phase-2 TurboModule spec (`NativeAppduct.ts`,
 * `docs/tasks/15-native-session-logic.md`): the native core owns session lifecycle, the tool
 * registry, and per-call timeout/cancel/progress, so this is the entire JS-facing surface —
 * everything crosses as JSON strings.
 */
export type AppductNativeModuleLike = {
  registerTool(descriptorJson: string): void;
  unregisterTool(name: string): void;
  handleUrl(url: string): boolean;
  connect(inputJson: string, supersede: boolean): Promise<void>;
  restoreSession(): Promise<boolean>;
  disconnect(): Promise<void>;
  postEvent(name: string, payloadJson: string | null): Promise<void>;
  respondToToolCall(
    id: string,
    resultJson: string | null,
    errorJson: string | null,
  ): void;
  reportToolProgress(
    id: string,
    progress: number | null,
    message: string | null,
  ): void;
  getState(): string;
  getSessionId(): string | null;
  getRegisteredToolsJson(): string;
  addListener<Event extends keyof AppductNativeEvents>(
    eventName: Event,
    listener: AppductNativeEvents[Event],
  ): EventSubscription;
};

/**
 * Options for `createAppductClient`. Empty since issue #48 phase 2: `timers`/`appState`/
 * `resumeLeaseStore`/`sessionClaimDeviceFields` are gone — reconnect timing, foreground/background
 * gating, and lease recovery are entirely native-owned now, and device metadata overrides are
 * threaded straight through `connect()`'s input instead of a separate hook. `defaultToolTimeoutMs`
 * is also gone: the default per-call timeout is enforced natively
 * (`AppductClient`'s own `defaultToolTimeoutMs`, currently fixed at
 * `APPDUCT_DEFAULT_TOOL_TIMEOUT_MS`), and the frozen TurboModule spec has no channel for JS to
 * override it -- see `docs/tasks/15-native-session-logic.md`'s deviations section. Kept as an empty
 * object (not removed outright) so `createAppductClient(module, {})` call sites do not need to
 * change.
 */
export type CreateAppductClientOptions = Record<string, never>;
