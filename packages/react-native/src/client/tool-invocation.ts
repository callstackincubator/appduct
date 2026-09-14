import type {
  CordieriteRegisteredTool,
  CordieriteToolExecutionContext,
} from "../Cordierite.types";
import type {
  CordieriteNativeToolCallEvent,
  CordieriteNativeToolCancelEvent,
} from "../client-types";
import { logger } from "../logger";
import { validateToolSchema } from "../schema";

/**
 * The thin half of what `client/tool-invocation.ts` used to own (issue #48 phase 2,
 * `docs/tasks/15-native-session-logic.md`): the native core now owns per-call timeout, cancellation
 * delivery, and the wire `tool_call`/`tool_cancel`/`tool_result`/`tool_error`/`tool_call_progress`
 * frames themselves. This module's only remaining job is inherently JS: run the registered handler,
 * validate its input/output against the registered schema, and answer through
 * `respondToToolCall` — everything else (timeouts, unknown-tool `tool_not_found`, wire sends) is
 * handled by native before/after this code ever runs.
 */

export const normalizeThrownError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      type: "tool_execution_error" as const,
      message: error.message,
      details: {
        name: error.name,
      },
    };
  }

  return {
    type: "tool_execution_error" as const,
    message: "Cordierite tool execution failed.",
    details: error,
  };
};

export type ToolInvocationDeps = {
  getRegistry: () => Map<string, CordieriteRegisteredTool>;
  /** Native's own `getSessionId()` snapshot -- the wire `tool_call` frame's `session_id` is not
   * itself forwarded on the native → JS event, since it is always the currently active session. */
  getSessionId: () => string | null;
  respondToToolCall: (
    id: string,
    resultJson: string | null,
    errorJson: string | null,
  ) => void;
  reportToolProgress: (
    id: string,
    progress: number | null,
    message: string | null,
  ) => void;
};

export type ToolMessageHandler = {
  handleToolCall: (event: CordieriteNativeToolCallEvent) => Promise<void>;
  handleToolCancel: (event: CordieriteNativeToolCancelEvent) => void;
  /** Aborts every in-flight handler's signal -- used when the client is destroyed, so a handler
   * whose native call has vanished does not keep running against a dead client forever. */
  abortAllInFlight: () => void;
};

const respondError = (
  respondToToolCall: ToolInvocationDeps["respondToToolCall"],
  id: string,
  type: string,
  message: string,
  details?: unknown,
): void => {
  respondToToolCall(
    id,
    null,
    JSON.stringify({
      type,
      message,
      ...(details !== undefined ? { details } : {}),
    }),
  );
};

export const createToolMessageHandler = (
  deps: ToolInvocationDeps,
): ToolMessageHandler => {
  const { getRegistry, getSessionId, respondToToolCall, reportToolProgress } =
    deps;
  const inFlight = new Map<string, AbortController>();

  const handleToolCall = async (
    event: CordieriteNativeToolCallEvent,
  ): Promise<void> => {
    const { id, name } = event;

    // Native has already resolved `name` against its own registry before ever emitting this event
    // (an unknown name gets `tool_not_found` from native directly), so a miss here would mean the
    // JS-side bookkeeping fell out of sync with a successful `registerTool` call -- defensive, not
    // expected.
    const tool = getRegistry().get(name);
    if (!tool) {
      logger.warn(`onToolCall for unregistered tool "${name}" (id ${id})`);
      respondError(
        respondToToolCall,
        id,
        "tool_not_found",
        `Tool "${name}" is not registered in the app.`,
      );
      return;
    }

    let args: unknown;
    try {
      args = JSON.parse(event.argsJson) as unknown;
    } catch (error) {
      logger.warn(`onToolCall argsJson is not valid JSON (id ${id})`, error);
      args = {};
    }

    const controller = new AbortController();
    inFlight.set(id, controller);

    const context: CordieriteToolExecutionContext = {
      sessionId: getSessionId() ?? "",
      invocationId: id,
      receivedAt: new Date().toISOString(),
      reportProgress: (progress, message) => {
        reportToolProgress(id, progress ?? null, message ?? null);
        return Promise.resolve();
      },
      signal: controller.signal,
    };

    logger.debug("tool call", name, "id", id);

    try {
      const parsedArgs = tool.inputSchema
        ? await validateToolSchema(tool.inputSchema, args)
        : typeof args === "object" &&
            args !== null &&
            !Array.isArray(args) &&
            Object.keys(args).length === 0
          ? { ok: true as const, value: undefined }
          : {
              ok: false as const,
              issues: [
                { message: `Tool "${name}" does not accept input arguments.` },
              ],
            };

      if (!parsedArgs.ok) {
        respondError(
          respondToToolCall,
          id,
          "tool_input_validation_error",
          `Tool "${name}" rejected the provided input.`,
          { issues: parsedArgs.issues },
        );
        return;
      }

      let result: unknown;
      try {
        result = await tool.handler(parsedArgs.value, context);
      } catch (error) {
        logger.warn(`tool "${name}" handler threw (id ${id})`, error);
        const normalized = normalizeThrownError(error);
        respondError(
          respondToToolCall,
          id,
          normalized.type,
          normalized.message,
          normalized.details,
        );
        return;
      }

      const parsedResult = tool.outputSchema
        ? await validateToolSchema(tool.outputSchema, result)
        : result === undefined
          ? { ok: true as const, value: null }
          : {
              ok: false as const,
              issues: [
                {
                  message: `Tool "${name}" must not return a result when outputSchema is omitted.`,
                },
              ],
            };

      if (!parsedResult.ok) {
        respondError(
          respondToToolCall,
          id,
          "tool_output_validation_error",
          `Tool "${name}" returned a result that does not match outputSchema.`,
          { issues: parsedResult.issues },
        );
        return;
      }

      let resultJson: string;
      try {
        resultJson = JSON.stringify(
          parsedResult.value === undefined ? null : parsedResult.value,
        );
      } catch (error) {
        logger.warn(
          `tool "${name}" result not JSON-serializable (id ${id})`,
          error,
        );
        const normalized = normalizeThrownError(error);
        respondError(
          respondToToolCall,
          id,
          "tool_serialization_error",
          "Cordierite tool result is not JSON-serializable.",
          normalized,
        );
        return;
      }

      respondToToolCall(id, resultJson, null);
    } finally {
      inFlight.delete(id);
    }
  };

  const handleToolCancel = (event: CordieriteNativeToolCancelEvent): void => {
    inFlight.get(event.id)?.abort();
  };

  const abortAllInFlight = (): void => {
    for (const controller of inFlight.values()) {
      controller.abort();
    }
    inFlight.clear();
  };

  return { handleToolCall, handleToolCancel, abortAllInFlight };
};
