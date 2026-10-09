import { isExpiredAt, isValidPort, type SessionAckMessage } from "@appduct/shared";
import type { AppductCore, AppductNativeEvents } from "@appduct/shared/sdk";

import { fullJitterBackoffMs } from "./backoff.js";
import { createConnection, FrameTooLargeError, type ConnectionOptions } from "./connection.js";
import { isResumeLeaseExpired, parseResumeLease } from "./lease.js";
import type { TimerHandle, TransportKind, WebCorePorts } from "./ports.js";
import { createEventRegistry, createToolRegistry } from "./registry.js";
import { createToolInvoker } from "./tool-invoker.js";

type ClientState = "idle" | "connecting" | "active" | "reconnecting" | "closed";

/** The session the core holds: the token to resume it with and the endpoint to resume against.
 * `disconnectedAtMs` is stamped the first time the socket is lost. */
type HeldSession = {
  sessionId: string;
  resumeToken: string;
  alias: string;
  graceS: number;
  disconnectedAtMs: number | null;
  ip: string;
  port: number;
  transport: TransportKind;
  acceptsEventRegistry: boolean;
};

/** A handshake the daemon rejected by closing the socket before (or instead of) an ack. */
class HandshakeClosedError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly reason: string | undefined,
  ) {
    super(message);
  }
}

/** Only 1008 is final: every rejection a resume could never talk its way out of uses it. Anything
 * else is worth retrying inside the grace window. */
const isTerminalCloseCode = (code: number | undefined): boolean => code === 1008;

const NOT_ACTIVE_CODE = "E_APPDUCT_NOT_ACTIVE";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown, key: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Appduct connect input "${key}" must be a string.`);
  return value;
};

/** `connect`'s input: a decoded bootstrap payload (`family` and `address`) or explicit options
 * (`ip`), as the native cores take it. `linkPin` is ignored: there is no TLS pin on the web. */
const parseConnectInput = (json: string): { options: ConnectionOptions; expiresAt: number } => {
  const input: unknown = JSON.parse(json);
  if (!isRecord(input)) throw new Error("Appduct connect input must be a JSON object.");
  const bootstrap = "family" in input && "address" in input;
  const ip = bootstrap ? input.address : input.ip;
  if (typeof ip !== "string" || typeof input.sessionId !== "string" || !isValidPort(input.port)) {
    throw new Error("Invalid or expired Appduct bootstrap payload.");
  }
  if (typeof input.expiresAt !== "number") throw new Error("Appduct connect input needs a numeric expiresAt.");

  return {
    expiresAt: input.expiresAt,
    options: {
      ip,
      port: input.port,
      sessionId: input.sessionId,
      transport: input.transport === "devtools" ? "devtools" : "websocket",
      token: optionalString(input.token, "token"),
      resumeToken: optionalString(input.resumeToken, "resumeToken"),
      deviceManufacturer: optionalString(input.deviceManufacturer, "deviceManufacturer"),
      deviceModel: optionalString(input.deviceModel, "deviceModel"),
      deviceOs: optionalString(input.deviceOs, "deviceOs"),
    },
  };
};

/**
 * The session core for web: a TypeScript port of the Swift and Kotlin cores
 * (`AppductClient`, `AppductConnectionManager`, `AppductToolInvoker`). It owns the claim and resume
 * handshake, reconnect with full jitter, the grace timer, the tool and event registries and their
 * frames, and per-call deadline and cancel, and exposes them as the `AppductCore` the SDK layer
 * (`createAppduct`) is built on.
 *
 * Everything runs on one thread, and a transport callback runs to completion before the next
 * starts, so there is no locking and no per-task dispatcher. Where the Kotlin client sequences work
 * with a dispatcher, this one does it by running the step inline.
 */
export const createWebCore = (ports: WebCorePorts): AppductCore => {
  const { clock, sessionStore } = ports;

  const listeners: { [Event in keyof AppductNativeEvents]: Set<AppductNativeEvents[Event]> } = {
    toolCall: new Set(),
    toolCancel: new Set(),
    stateChange: new Set(),
    sessionChange: new Set(),
    error: new Set(),
  };
  const emit = <Event extends keyof AppductNativeEvents>(
    name: Event,
    event: Parameters<AppductNativeEvents[Event]>[0],
  ) => {
    for (const listener of [...listeners[name]] as ((event: Parameters<AppductNativeEvents[Event]>[0]) => void)[]) {
      listener(event);
    }
  };
  const emitError = (phase: string, message: string, closeReason?: string) =>
    emit("error", { phase, message, ...(closeReason !== undefined ? { closeReason } : {}) });

  const tools = createToolRegistry();
  const events = createEventRegistry();

  let clientState: ClientState = "idle";
  let held: HeldSession | undefined;
  /** The session an in-flight `connect()` is claiming, before an ack sets `held`. */
  let connectingSessionId: string | null = null;
  let epoch = 0;
  let pending: { onAck: (ack: SessionAckMessage) => void; resolve: () => void; reject: (error: Error) => void } | undefined;
  let reconnectAttempt = 0;
  let reconnectTimer: TimerHandle | undefined;
  let graceTimer: TimerHandle | undefined;
  let resumeInFlight = false;
  /** True while an ack is being announced: what is registered then goes out in the snapshot that
   * follows, so it sends no delta of its own. */
  let snapshotPending = false;

  const setState = (next: ClientState, reason?: string) => {
    if (clientState === next && reason === undefined) return;
    clientState = next;
    emit("stateChange", { state: next, ...(reason !== undefined ? { reason } : {}) });
  };

  const emitSessionChange = (type: string, sessionId: string | null, alias: string | null, reason?: string) =>
    emit("sessionChange", { type, sessionId, alias, ...(reason !== undefined ? { reason } : {}) });

  const clearReconnectTimer = () => {
    if (reconnectTimer !== undefined) clock.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };
  const clearGraceTimer = () => {
    if (graceTimer !== undefined) clock.clearTimeout(graceTimer);
    graceTimer = undefined;
  };

  const invoker = createToolInvoker({
    clock,
    registry: tools,
    getSessionId: () => held?.sessionId ?? null,
    send: (frame) => connection.send(frame),
    emitToolCall: (event) => emit("toolCall", event),
    emitToolCancel: (event) => emit("toolCancel", event),
    onSendError: (message) => emitError("tool", message),
  });

  /** Settles the handshake in flight, if any. Returns whether there was one. */
  const settlePending = (error: Error): boolean => {
    const attempt = pending;
    if (!attempt) return false;
    pending = undefined;
    attempt.reject(error);
    return true;
  };

  const connection = createConnection(ports, {
    onAck(ack) {
      const attempt = pending;
      pending = undefined;
      attempt?.onAck(ack);
      attempt?.resolve();
    },

    onMessage(message) {
      if (message.type === "tool_call") {
        const { id, name, args } = message;
        if (typeof id === "string" && id !== "" && typeof name === "string" && name !== "") {
          invoker.handleToolCall(id, name, isRecord(args) ? args : {});
        }
      } else if (message.type === "tool_cancel") {
        if (typeof message.id === "string" && message.id !== "") invoker.handleToolCancel(message.id);
      }
    },

    onClose({ code, reason, error }) {
      const settled = settlePending(new HandshakeClosedError(reason ?? error ?? "Appduct connection closed.", code, reason));
      if (settled) return;
      onSocketLost(code, reason, error);
    },
  });

  /** Opens a socket and resolves once `onAck` has run for the ack, or rejects if the handshake fails. */
  const handshake = (options: ConnectionOptions, onAck: (ack: SessionAckMessage) => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      pending = { onAck, resolve, reject };
      try {
        connection.open(options);
      } catch (error) {
        settlePending(error instanceof Error ? error : new Error(String(error)));
      }
    });

  const sendFrame = (frame: { session_id: string } & Record<string, unknown>, phase: string, failure: string) => {
    try {
      connection.send(frame);
    } catch (error) {
      emitError(phase, error instanceof FrameTooLargeError ? error.message : failure);
    }
  };

  const sendSnapshots = (acceptsEvents: boolean) => {
    const session = held;
    if (clientState !== "active" || !session) return;
    sendFrame(
      { type: "tool_registry_snapshot", session_id: session.sessionId, tools: tools.list() },
      "tool",
      "Failed to send the tool registry snapshot.",
    );
    if (!acceptsEvents) return;
    sendFrame(
      { type: "event_registry_snapshot", session_id: session.sessionId, events: events.list() },
      "tool",
      "Failed to sync the event registry.",
    );
  };

  const onAckReceived = (
    ack: SessionAckMessage,
    kind: "claimed" | "resumed",
    { ip, port, transport }: { ip: string; port: number; transport: TransportKind },
  ) => {
    clearReconnectTimer();
    clearGraceTimer();
    reconnectAttempt = 0;
    resumeInFlight = false;

    held = {
      sessionId: ack.session_id,
      resumeToken: ack.resume_token,
      alias: ack.alias,
      graceS: ack.grace_s,
      disconnectedAtMs: null,
      ip,
      port,
      transport,
      acceptsEventRegistry: ack.event_registry === true,
    };
    connectingSessionId = null;

    snapshotPending = true;
    try {
      setState("active");
      emitSessionChange(kind, ack.session_id, ack.alias);
    } finally {
      snapshotPending = false;
    }
    sendSnapshots(ack.event_registry === true);
  };

  // --- reconnect, grace, loss ---

  const finalizeSessionLost = (reason: string) => {
    const sessionId = held?.sessionId;

    epoch += 1;
    clearReconnectTimer();
    clearGraceTimer();
    held = undefined;
    resumeInFlight = false;
    connection.close();
    settlePending(new Error(`Appduct session was lost: ${reason}.`));

    setState("closed", reason);
    if (sessionId !== undefined) emitSessionChange("lost", null, null, reason);
  };

  const graceElapsed = (session: HeldSession): boolean => {
    const nowMs = clock.now();
    session.disconnectedAtMs ??= nowMs;
    return nowMs - session.disconnectedAtMs >= Math.trunc(session.graceS * 1000);
  };

  const attemptResume = async (myEpoch: number): Promise<void> => {
    const session = held;
    if (resumeInFlight || myEpoch !== epoch || !session) return;
    if (graceElapsed(session)) {
      finalizeSessionLost("grace_expired");
      return;
    }

    resumeInFlight = true;
    try {
      await handshake(
        {
          ip: session.ip,
          port: session.port,
          transport: session.transport,
          sessionId: session.sessionId,
          resumeToken: session.resumeToken,
        },
        (ack) => onAckReceived(ack, "resumed", session),
      );
    } catch (error) {
      resumeInFlight = false;
      if (myEpoch !== epoch) return;

      const cause = error instanceof Error ? error.message : String(error);
      emitError("socket", `Appduct resume attempt failed: ${cause.replace(/\.+$/, "")}.`);

      if (error instanceof HandshakeClosedError && isTerminalCloseCode(error.code)) {
        // The daemon rejected the resume itself. Retrying the same frame until the grace window
        // ends would leave the app "reconnecting" for minutes before it reports the loss.
        finalizeSessionLost(error.reason ?? "rejected_by_daemon");
        return;
      }
      scheduleReconnect(myEpoch);
    }
  };

  const scheduleReconnect = (myEpoch: number) => {
    if (myEpoch !== epoch || !held) return;
    setState("reconnecting");
    const delayMs = fullJitterBackoffMs(reconnectAttempt, ports.random);
    reconnectAttempt += 1;
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = undefined;
      void attemptResume(myEpoch);
    }, delayMs);
  };

  const scheduleGraceExpiry = (myEpoch: number) => {
    const session = held;
    if (graceTimer !== undefined || !session) return;
    const nowMs = clock.now();
    session.disconnectedAtMs ??= nowMs;
    const remainingMs = Math.trunc(session.graceS * 1000) - (nowMs - session.disconnectedAtMs);
    graceTimer = clock.setTimeout(() => {
      graceTimer = undefined;
      if (myEpoch === epoch && held) finalizeSessionLost("grace_expired");
    }, Math.max(remainingMs, 0));
  };

  const onSocketLost = (code: number | undefined, reason: string | undefined, lastError: string | undefined) => {
    handleSocketLost(code, reason, lastError);
    // The socket is gone, so no `tool_cancel` could arrive for what is in flight: abort it here,
    // after the state change, which is the order the Swift and Kotlin cores report them in.
    invoker.abortAll();
  };

  const handleSocketLost = (code: number | undefined, reason: string | undefined, lastError: string | undefined) => {
    const session = held;
    if (!session) {
      setState("closed", "socket_closed");
      return;
    }
    if (code === 1000) {
      finalizeSessionLost("revoked");
      return;
    }

    emitError("socket", reason ?? lastError ?? "Appduct connection lost.", reason);

    if (isTerminalCloseCode(code)) {
      finalizeSessionLost(reason ?? "rejected_by_daemon");
      return;
    }
    if (graceElapsed(session)) {
      finalizeSessionLost("grace_expired");
      return;
    }
    scheduleGraceExpiry(epoch);
    scheduleReconnect(epoch);
  };

  // --- registries ---

  const sendToolDelta = (frame: Record<string, unknown>) => {
    const session = held;
    if (clientState !== "active" || !session || snapshotPending) return;
    sendFrame({ ...frame, session_id: session.sessionId }, "tool", "Failed to sync the tool registry.");
  };

  const sendEventDelta = (frame: Record<string, unknown>) => {
    const session = held;
    if (clientState !== "active" || !session || snapshotPending || !session.acceptsEventRegistry) return;
    sendFrame({ ...frame, session_id: session.sessionId }, "tool", "Failed to sync the event registry.");
  };

  // --- connect and restore ---

  const connectInternal = async (inputJson: string, supersede: boolean): Promise<void> => {
    const { options, expiresAt } = parseConnectInput(inputJson);
    const hasCredential = !!options.token || !!options.resumeToken;
    if (options.ip === "" || options.sessionId === "" || !hasCredential || isExpiredAt(expiresAt, Math.floor(clock.now() / 1000))) {
      throw new Error("Invalid or expired Appduct bootstrap payload.");
    }

    const supersedingReconnect = clientState === "reconnecting" || supersede;
    if (connection.isBusy() && !supersedingReconnect) {
      throw new Error("An Appduct session is already connecting or active.");
    }

    epoch += 1;
    const myEpoch = epoch;
    clearReconnectTimer();
    clearGraceTimer();
    reconnectAttempt = 0;
    held = undefined;
    connectingSessionId = options.sessionId;
    resumeInFlight = false;
    sessionStore.clear();

    if (supersedingReconnect) {
      invoker.abortAll();
      settlePending(new Error("Appduct recovery was superseded by a fresh connection."));
      connection.close();
    }

    try {
      setState("connecting");
      await handshake(options, (ack) => onAckReceived(ack, "claimed", options));
    } catch (error) {
      if (myEpoch === epoch) {
        connectingSessionId = null;
        setState("closed", "connect_error");
        emitError("connect", error instanceof Error ? error.message : "Appduct connect failed.");
      }
      throw error;
    }
  };

  const core: AppductCore = {
    registerTool(descriptorJson) {
      const descriptor = tools.upsert(descriptorJson);
      sendToolDelta({ type: "tool_registry_delta", operation: "upsert", tool: descriptor });
    },

    unregisterTool(name) {
      if (!tools.remove(name)) return;
      sendToolDelta({ type: "tool_registry_delta", operation: "remove", name });
    },

    registerEvent(descriptorJson) {
      const descriptor = events.upsert(descriptorJson);
      sendEventDelta({ type: "event_registry_delta", operation: "upsert", event: descriptor });
    },

    unregisterEvent(name) {
      if (!events.remove(name)) return;
      sendEventDelta({ type: "event_registry_delta", operation: "remove", name });
    },

    // The browser entry owns `#appduct=` (slice 4), so there is never a url for the core to take.
    handleUrl: () => false,

    connect: (inputJson, supersede) => connectInternal(inputJson, supersede),

    async restoreSession() {
      if (held || (clientState !== "idle" && clientState !== "closed")) return false;

      const lease = parseResumeLease(sessionStore.read());
      if (!lease) {
        sessionStore.clear();
        return false;
      }
      const nowMs = clock.now();
      if (isResumeLeaseExpired(lease, nowMs)) {
        sessionStore.clear();
        return false;
      }
      if (connection.isBusy()) return false;

      epoch += 1;
      const myEpoch = epoch;
      clearReconnectTimer();
      clearGraceTimer();
      reconnectAttempt = 0;
      held = {
        sessionId: lease.sessionId,
        resumeToken: lease.resumeToken,
        alias: lease.alias,
        graceS: lease.graceS,
        disconnectedAtMs: lease.disconnectedAtMs ?? nowMs,
        ip: lease.endpoint.ip,
        port: lease.endpoint.port,
        transport: lease.transport,
        // Not acked yet; the ack that resumes the session says.
        acceptsEventRegistry: false,
      };
      setState("reconnecting");
      scheduleGraceExpiry(myEpoch);
      void attemptResume(myEpoch);
      return true;
    },

    async disconnect() {
      epoch += 1;
      clearReconnectTimer();
      clearGraceTimer();

      const hadSession = held !== undefined;
      held = undefined;
      connectingSessionId = null;
      resumeInFlight = false;
      settlePending(new Error("Appduct client was closed."));
      invoker.abortAll();
      connection.close();

      setState("closed", "closed_by_app");
      if (hadSession) emitSessionChange("lost", null, null, "closed_by_app");
    },

    async postEvent(name, payloadJson) {
      const session = held;
      if (clientState !== "active" || !session) {
        throw Object.assign(new Error(`Appduct postEvent("${name}") dropped: no active Appduct session.`), {
          code: NOT_ACTIVE_CODE,
        });
      }
      const payload = payloadJson === null ? undefined : (JSON.parse(payloadJson) as unknown);
      sendFrame(
        {
          type: "event",
          session_id: session.sessionId,
          name,
          ...(payload !== undefined ? { payload } : {}),
          ts: clock.now(),
        },
        "socket",
        `Failed to send event "${name}".`,
      );
    },

    respondToToolCall: (id, resultJson, errorJson) => invoker.respond(id, resultJson, errorJson),
    reportToolProgress: (id, progress, message) => invoker.progress(id, progress, message),

    getState: () => clientState,
    getSessionId: () => held?.sessionId ?? connectingSessionId,
    getRegisteredToolsJson: () => JSON.stringify(tools.list()),

    addListener<Event extends keyof AppductNativeEvents>(
      eventName: Event,
      listener: AppductNativeEvents[Event],
    ): ReturnType<AppductCore["addListener"]> {
      listeners[eventName].add(listener);
      return { remove: () => void listeners[eventName].delete(listener) };
    },
  };

  return core;
};
