import { DEFAULT_TOOL_TIMEOUT_MS } from "@appduct/shared";

import { FrameTooLargeError } from "./connection.js";
import type { Clock, TimerHandle } from "./ports.js";
import type { ToolRegistry } from "./registry.js";

type InFlight = { name: string; timer: TimerHandle };

export type ToolInvokerDeps = {
  clock: Clock;
  registry: ToolRegistry;
  getSessionId: () => string | null;
  /** Sends a frame for the held session; may throw. */
  send: (frame: { session_id: string } & Record<string, unknown>) => void;
  /** Tells the SDK layer to run the handler. */
  emitToolCall: (event: { id: string; name: string; argsJson: string }) => void;
  /** Tells the SDK layer to abort the handler: "client_cancelled", "timeout" or "session_suspended". */
  emitToolCancel: (event: { id: string; reason: string }) => void;
  onSendError: (message: string) => void;
};

export type ToolInvoker = {
  handleToolCall(id: string, name: string, args: Record<string, unknown>): void;
  /** A `tool_cancel` frame. An unknown or finished id is a no-op. */
  handleToolCancel(id: string): void;
  /** The SDK layer's answer. An unknown or finished id is a no-op. */
  respond(id: string, resultJson: string | null, errorJson: string | null): void;
  progress(id: string, progress: number | null, message: string | null): void;
  /** Drops every call in flight without sending anything: no socket is left to send on. */
  abortAll(): void;
};

const parseObject = (json: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Per-call deadline, cancel and reply frames (PROTOCOL.md section 4). The SDK layer runs the
 * handler; this answers the daemon, so a handler that never answers still gets a `tool_timeout`.
 * Port of `AppductToolInvoker` and the bridge around it.
 */
export const createToolInvoker = (deps: ToolInvokerDeps): ToolInvoker => {
  const { clock, registry } = deps;
  const inFlight = new Map<string, InFlight>();

  const send = (frame: { session_id: string } & Record<string, unknown>) => {
    try {
      deps.send(frame);
    } catch (error) {
      deps.onSendError(error instanceof FrameTooLargeError ? error.message : "Failed to send a tool response frame.");
    }
  };

  /** Sends the call's answer; one over the frame limit becomes a `tool_serialization_error` naming its size. */
  const reply = (sessionId: string, id: string, frame: { type: string } & Record<string, unknown>) => {
    try {
      deps.send({ ...frame, session_id: sessionId, id });
    } catch (error) {
      if (error instanceof FrameTooLargeError) {
        send({ type: "tool_error", session_id: sessionId, id, error: { type: "tool_serialization_error", message: error.message } });
      } else {
        deps.onSendError("Failed to send a tool response frame.");
      }
    }
  };

  const sendError = (sessionId: string, id: string, error: Record<string, unknown>) =>
    reply(sessionId, id, { type: "tool_error", error });

  /** Takes `id` out of flight, or returns undefined when it is not (or no longer) in flight. */
  const finish = (id: string): InFlight | undefined => {
    const entry = inFlight.get(id);
    if (!entry) return undefined;
    inFlight.delete(id);
    clock.clearTimeout(entry.timer);
    return entry;
  };

  return {
    handleToolCall(id, name, args) {
      const sessionId = deps.getSessionId();
      if (sessionId === null) return;
      const tool = registry.get(name);
      if (!tool) {
        sendError(sessionId, id, { type: "tool_not_found", message: `Tool "${name}" is not registered in the app.` });
        return;
      }

      const timeoutMs = tool.timeout_ms ?? DEFAULT_TOOL_TIMEOUT_MS;
      const timer = clock.setTimeout(() => {
        if (!finish(id)) return;
        sendError(sessionId, id, { type: "tool_timeout", message: `Tool "${name}" did not respond within ${timeoutMs}ms.` });
        deps.emitToolCancel({ id, reason: "timeout" });
      }, timeoutMs);
      inFlight.set(id, { name, timer });
      deps.emitToolCall({ id, name, argsJson: JSON.stringify(args) });
    },

    handleToolCancel(id) {
      const entry = finish(id);
      const sessionId = deps.getSessionId();
      if (!entry || sessionId === null) return;
      sendError(sessionId, id, { type: "tool_cancelled", message: `Tool "${entry.name}" was cancelled.` });
      deps.emitToolCancel({ id, reason: "client_cancelled" });
    },

    respond(id, resultJson, errorJson) {
      const sessionId = deps.getSessionId();
      if (!finish(id) || sessionId === null) return;

      if (errorJson !== null) {
        const error = parseObject(errorJson);
        sendError(sessionId, id, {
          type: typeof error?.type === "string" ? error.type : "tool_execution_error",
          message: typeof error?.message === "string" ? error.message : "Appduct tool execution failed.",
          ...(error && "details" in error ? { details: error.details } : {}),
        });
        return;
      }

      let result: unknown = null;
      try {
        if (resultJson !== null) result = JSON.parse(resultJson);
      } catch {
        sendError(sessionId, id, {
          type: "tool_serialization_error",
          message: "Appduct tool result is not JSON-serializable.",
        });
        return;
      }
      reply(sessionId, id, { type: "tool_result", result });
    },

    progress(id, progress, message) {
      const sessionId = deps.getSessionId();
      if (!inFlight.has(id) || sessionId === null) return;
      send({
        type: "tool_call_progress",
        session_id: sessionId,
        id,
        ...(progress !== null ? { progress } : {}),
        ...(message !== null ? { message } : {}),
      });
    },

    abortAll() {
      for (const id of [...inFlight.keys()]) {
        finish(id);
        deps.emitToolCancel({ id, reason: "session_suspended" });
      }
    },
  };
};
