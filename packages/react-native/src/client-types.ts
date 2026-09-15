export type EventSubscription = {
  remove(): void;
};

/** Native → JS: run the registered handler for `name` and answer with `respondToToolCall`. */
export type CordieriteNativeToolCallEvent = {
  id: string;
  name: string;
  /** JSON object, exactly the wire `tool_call.args`. */
  argsJson: string;
};

/** Native → JS: abort the handler's signal. Native has already answered the daemon. */
export type CordieriteNativeToolCancelEvent = {
  id: string;
  /** "client_cancelled" | "timeout" | "session_suspended" | the wire `tool_cancel.reason`. */
  reason: string;
};

export type CordieriteNativeStateChangeEvent = {
  state: string;
  reason?: string;
};

export type CordieriteNativeSessionChangeEvent = {
  /** "claimed" | "resumed" | "lost" */
  type: string;
  sessionId: string | null;
  alias: string | null;
  /** Set only when `type` is `"lost"`: `revoked`, `grace_expired`, `closed_by_app`, or a
   * PROTOCOL.md §7 terminal close reason. */
  reason?: string;
};

export type CordieriteNativeErrorEvent = {
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

export type CordieriteNativeEvents = {
  toolCall: (event: CordieriteNativeToolCallEvent) => void;
  toolCancel: (event: CordieriteNativeToolCancelEvent) => void;
  stateChange: (event: CordieriteNativeStateChangeEvent) => void;
  sessionChange: (event: CordieriteNativeSessionChangeEvent) => void;
  error: (event: CordieriteNativeErrorEvent) => void;
};

/**
 * Structural seam for the phase-2 TurboModule spec (`NativeCordierite.ts`,
 * `docs/tasks/15-native-session-logic.md`): the native core owns session lifecycle, the tool
 * registry, and per-call timeout/cancel/progress, so this is the entire JS-facing surface —
 * everything crosses as JSON strings.
 */
export type CordieriteNativeModuleLike = {
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
  addListener<Event extends keyof CordieriteNativeEvents>(
    eventName: Event,
    listener: CordieriteNativeEvents[Event],
  ): EventSubscription;
};

/**
 * Options for `createCordieriteClient`. Empty since issue #48 phase 2: `timers`/`appState`/
 * `resumeLeaseStore`/`sessionClaimDeviceFields` are gone — reconnect timing, foreground/background
 * gating, and lease recovery are entirely native-owned now, and device metadata overrides are
 * threaded straight through `connect()`'s input instead of a separate hook. `defaultToolTimeoutMs`
 * is also gone: the default per-call timeout is enforced natively
 * (`CordieriteClient`'s own `defaultToolTimeoutMs`, currently fixed at
 * `CORDIERITE_DEFAULT_TOOL_TIMEOUT_MS`), and the frozen TurboModule spec has no channel for JS to
 * override it -- see `docs/tasks/15-native-session-logic.md`'s deviations section. Kept as an empty
 * object (not removed outright) so `createCordieriteClient(module, {})` call sites do not need to
 * change.
 */
export type CreateCordieriteClientOptions = Record<string, never>;
