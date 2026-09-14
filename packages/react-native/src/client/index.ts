import type { ToolDescriptor } from "@cordierite/shared";

import type {
  CordieriteClientState,
  CordieriteConnectCallOptions,
  CordieriteConnectInput,
  CordieriteListenerKind,
  CordieriteRegisteredTool,
  CordieriteRuntimeSchema,
  CordieriteToolHandler,
  CordieriteToolRegistration,
  CordieriteUnifiedListenerMap,
} from "../Cordierite.types";
import type {
  CordieriteNativeModuleLike,
  CreateCordieriteClientOptions,
} from "../client-types";
import { logger } from "../logger";
import { normalizeOptionalToolSchema, toToolDescriptor } from "../schema";
import { createUnifiedListenerBus } from "./listeners";
import { createToolMessageHandler } from "./tool-invocation";

export type {
  CordieriteNativeModuleLike,
  CreateCordieriteClientOptions,
} from "../client-types";

/**
 * Both native bridges reject `postEvent` with this code when no session is active (iOS:
 * `CordieriteClient.CordieriteNotActiveError` via `CordieriteTurboBridge.swift`; Android: the
 * `NativeCordieriteModule.postEvent` state guard, since the Kotlin core's own `postEvent` is
 * itself a best-effort no-op for a plain-app caller) -- see `postEvent` below, which downgrades
 * exactly this rejection to a dev-only warning instead of the generic `error` listener event every
 * other `postEvent` failure gets.
 */
export const CORDIERITE_NOT_ACTIVE_ERROR_CODE = "E_CORDIERITE_NOT_ACTIVE";

/** Whether `error` is a native `postEvent` rejection specifically for "no session is active",
 * identified by `code` the way a rejected TurboModule/bridge promise surfaces it to JS. */
export const isCordieriteNotActiveError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === CORDIERITE_NOT_ACTIVE_ERROR_CODE;

/**
 * The thin client left after issue #48 phase 2 (`docs/tasks/15-native-session-logic.md`): the
 * native core owns session lifecycle (claim/resume, reconnect, grace), the tool registry and its
 * wire deltas, and per-call timeout/cancel/progress. This layer keeps only what is inherently JS —
 * a handler map, Standard Schema → JSON Schema conversion, input/output validation, and mapping
 * native's JSON-string events onto the public listener/handler surface.
 */
export const createCordieriteClient = (
  module: CordieriteNativeModuleLike,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for call-site compatibility; see CreateCordieriteClientOptions's doc comment.
  clientOptions: CreateCordieriteClientOptions = {},
) => {
  const listenerBus = createUnifiedListenerBus();
  const tools = new Map<string, CordieriteRegisteredTool>();
  let destroyed = false;

  const { handleToolCall, handleToolCancel, abortAllInFlight } =
    createToolMessageHandler({
      getRegistry: () => tools,
      getSessionId: () => module.getSessionId(),
      respondToToolCall: (id, resultJson, errorJson) =>
        module.respondToToolCall(id, resultJson, errorJson),
      reportToolProgress: (id, progress, message) =>
        module.reportToolProgress(id, progress, message),
    });

  const toolCallSubscription = module.addListener("toolCall", (event) => {
    handleToolCall(event).catch((error: unknown) => {
      logger.warn(
        `onToolCall handling failed for "${event.name}" (id ${event.id})`,
        error,
      );
    });
  });
  const toolCancelSubscription = module.addListener("toolCancel", (event) => {
    handleToolCancel(event);
  });
  const stateChangeSubscription = module.addListener("stateChange", (event) => {
    listenerBus.emit("stateChange", {
      state: event.state as CordieriteClientState,
      reason: event.reason,
    });
  });
  const sessionChangeSubscription = module.addListener(
    "sessionChange",
    (event) => {
      listenerBus.emit("sessionChange", {
        sessionId: event.sessionId,
        alias: event.alias,
      });
    },
  );
  const errorSubscription = module.addListener("error", (event) => {
    listenerBus.emit("error", {
      phase: event.phase as "bootstrap" | "connect" | "socket" | "tool",
      message: event.message,
      code: event.code,
      nativeCode: event.nativeCode,
      closeReason: event.closeReason,
      isRetryable: event.isRetryable,
      hint: event.hint,
      toolName: event.toolName,
      invocationId: event.invocationId,
    });
  });

  return {
    /**
     * Registers (or replaces, by name) a tool: validates and converts the schema, upserts the
     * local handler entry, then hands the wire descriptor to native (which validates it again per
     * PROTOCOL.md §5 and throws synchronously on an invalid one, and sends `tool_registry_delta`
     * while a session is active).
     */
    registerTool<
      TInputSchema extends CordieriteRuntimeSchema | undefined,
      TOutputSchema extends CordieriteRuntimeSchema | undefined,
    >(registration: CordieriteToolRegistration<TInputSchema, TOutputSchema>) {
      const inputSchema = normalizeOptionalToolSchema(
        registration.inputSchema,
        `Tool "${registration.name}" inputSchema`,
      );
      const outputSchema = normalizeOptionalToolSchema(
        registration.outputSchema,
        `Tool "${registration.name}" outputSchema`,
      );

      const descriptor = toToolDescriptor({
        name: registration.name,
        description: registration.description,
        inputSchema,
        outputSchema,
        annotations: registration.annotations,
        timeoutMs: registration.timeoutMs,
      });

      if (tools.has(registration.name)) {
        logger.devWarn(
          `registerTool: "${registration.name}" is already registered; overwriting the previous registration.`,
        );
      }

      const id = Symbol(`cordierite-tool:${registration.name}`);

      logger.debug("registerTool", registration.name);
      // Native validates and throws synchronously on an invalid descriptor -- surfaced to the
      // caller before the local entry is committed, so a rejected registration never shadows a
      // previous one under the same name.
      module.registerTool(JSON.stringify(descriptor));

      tools.set(registration.name, {
        id,
        name: registration.name,
        inputSchema,
        outputSchema,
        handler: registration.handler as CordieriteToolHandler,
      });

      return {
        remove: () => {
          const current = tools.get(registration.name);

          // Stale disposer: a newer registration under the same name has replaced this one.
          if (!current || current.id !== id) {
            return;
          }

          logger.debug(
            "unregisterTool (from registerTool disposer)",
            registration.name,
          );
          tools.delete(registration.name);
          module.unregisterTool(registration.name);
        },
      };
    },

    unregisterTool(name: string): void {
      if (!tools.has(name)) {
        return;
      }
      logger.debug("unregisterTool", name);
      tools.delete(name);
      module.unregisterTool(name);
    },

    /** Reads straight from native (the source of truth for the registry, including its delta
     * history) rather than reconstructing from local handler bookkeeping. */
    getRegisteredTools(): ToolDescriptor[] {
      try {
        return JSON.parse(module.getRegisteredToolsJson()) as ToolDescriptor[];
      } catch (error) {
        logger.warn("getRegisteredToolsJson() returned invalid JSON", error);
        return [];
      }
    },

    /**
     * Starts recovery from a native-owned process-memory lease when this client is idle. Resolves
     * `true` once the resume attempt has been accepted and started; it does not wait for the
     * daemon's `session_ack`. Resolves `false` when no valid, unexpired lease can be restored.
     */
    async restoreSession(): Promise<boolean> {
      return module.restoreSession();
    },

    /**
     * Runs the v2 claim handshake: hands the connect input to native as JSON and resolves once
     * `session_ack` is received (not merely once native has accepted the socket).
     */
    async connect(
      input: CordieriteConnectInput,
      connectOptions?: CordieriteConnectCallOptions,
    ): Promise<void> {
      logger.debug("connect", {
        session: (input as { sessionId?: string }).sessionId,
      });
      await module.connect(
        JSON.stringify(input),
        connectOptions?.supersede ?? false,
      );
    },

    /** Emits an `event` frame while active; drops (with a dev warning) when no session is active;
     * otherwise reports the failure on the `error` listener (phase `"socket"`). Never throws. */
    async postEvent(name: string, payload?: unknown): Promise<void> {
      try {
        await module.postEvent(
          name,
          payload === undefined ? null : JSON.stringify(payload),
        );
      } catch (error) {
        if (isCordieriteNotActiveError(error)) {
          logger.devWarn(
            `postEvent("${name}") dropped: no active Cordierite session.`,
          );
          return;
        }

        logger.warn(`postEvent("${name}") failed to send`, error);
        listenerBus.emit("error", {
          phase: "socket",
          message: `Failed to send event "${name}".`,
          cause: error,
        });
      }
    },

    /** Closes the socket, clears the lease, state → `"closed"`. Idempotent. Alias: `disconnect()`. */
    async close(): Promise<void> {
      logger.debug("close");
      await module.disconnect();
    },

    async disconnect(): Promise<void> {
      await module.disconnect();
    },

    /** Raw native connection state -- now identical to `getClientState()`; both are native's own
     * unified state (issue #48 phase 2 removed the separate "raw" tier). */
    getState(): CordieriteClientState {
      return module.getState() as CordieriteClientState;
    },

    /** Unified client state: `idle | connecting | active | reconnecting | closed`. */
    getClientState(): CordieriteClientState {
      return module.getState() as CordieriteClientState;
    },

    getSessionId(): string | null {
      return module.getSessionId();
    },

    /** Feeds a deep link to native. Returns `true` iff the URL carried a `cordierite` query param;
     * the actual parse/connect/supersede decision happens natively and asynchronously. */
    handleUrl(url: string): boolean {
      return module.handleUrl(url);
    },

    /** Unified listener API (ARCHITECTURE.md §11): `stateChange`, `sessionChange`, `error`. */
    addCordieriteListener<Kind extends CordieriteListenerKind>(
      kind: Kind,
      callback: CordieriteUnifiedListenerMap[Kind],
    ) {
      return listenerBus.addListener(kind, callback);
    },

    /** Removes every listener this client attached to `module` and aborts any in-flight handler.
     * Call when discarding a client instance. */
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      abortAllInFlight();
      toolCallSubscription.remove();
      toolCancelSubscription.remove();
      stateChangeSubscription.remove();
      sessionChangeSubscription.remove();
      errorSubscription.remove();
    },
  };
};

export type CordieriteClient = ReturnType<typeof createCordieriteClient>;
