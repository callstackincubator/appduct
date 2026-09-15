import { describe, expect, vi, test } from "vitest";
import { z } from "zod";

import type { AppductRegisteredTool } from "../Appduct.types";
import { createToolMessageHandler } from "../client/tool-invocation";
import { normalizeToolSchema } from "../schema";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/**
 * Ports the still-JS-owned half of the old `tool-invocation.test.ts` (issue #48 phase 2): schema
 * validation, running the handler, and answering through `respondToToolCall`/`reportToolProgress`.
 * Timeout, unknown-tool `tool_not_found`, and the `tool_cancel` wire frame itself are now the
 * native core's job (see `AppductCoreTests/AppductClientTests.swift`) -- this file only
 * covers what still runs in JS, driven directly by the native → JS events this bridge answers.
 */

type RespondCall = {
  id: string;
  resultJson: string | null;
  errorJson: string | null;
};

const makeHandler = (
  tools: Map<string, AppductRegisteredTool>,
  sessionId = "session-1",
) => {
  const responds: RespondCall[] = [];
  const progress: {
    id: string;
    progress: number | null;
    message: string | null;
  }[] = [];
  const handler = createToolMessageHandler({
    getRegistry: () => tools,
    getSessionId: () => sessionId,
    respondToToolCall: (id, resultJson, errorJson) =>
      responds.push({ id, resultJson, errorJson }),
    reportToolProgress: (id, p, message) =>
      progress.push({ id, progress: p, message }),
  });
  return { ...handler, responds, progress };
};

const registeredTool = (
  overrides: Partial<AppductRegisteredTool> &
    Pick<AppductRegisteredTool, "name" | "handler">,
): AppductRegisteredTool => ({
  id: Symbol(overrides.name),
  inputSchema: undefined,
  outputSchema: undefined,
  ...overrides,
});

describe("createToolMessageHandler", () => {
  test("unregistered tool responds tool_not_found (defensive -- native normally filters this)", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    const { handleToolCall, responds } = makeHandler(tools);

    await handleToolCall({ id: "call-1", name: "missing", argsJson: "{}" });

    expect(responds).toHaveLength(1);
    expect(responds[0]?.resultJson).toBeNull();
    expect(JSON.parse(responds[0]!.errorJson!).type).toBe("tool_not_found");
  });

  test("no inputSchema + empty args calls the handler with undefined", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    const handlerFn = vi.fn().mockResolvedValue(undefined);
    tools.set("noop", registeredTool({ name: "noop", handler: handlerFn }));
    const { handleToolCall, responds } = makeHandler(tools);

    await handleToolCall({ id: "call-1", name: "noop", argsJson: "{}" });

    expect(handlerFn).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ invocationId: "call-1" }),
    );
    expect(responds[0]?.resultJson).toBe("null");
    expect(responds[0]?.errorJson).toBeNull();
  });

  test("no inputSchema + non-empty args responds tool_input_validation_error", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    const handlerFn = vi.fn();
    tools.set("noop", registeredTool({ name: "noop", handler: handlerFn }));
    const { handleToolCall, responds } = makeHandler(tools);

    await handleToolCall({
      id: "call-1",
      name: "noop",
      argsJson: JSON.stringify({ extra: 1 }),
    });

    expect(handlerFn).not.toHaveBeenCalled();
    expect(JSON.parse(responds[0]!.errorJson!).type).toBe(
      "tool_input_validation_error",
    );
  });

  test("inputSchema validates args and passes the parsed value to the handler", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    const handlerFn = vi.fn().mockResolvedValue({ ok: true });
    const schema = normalizeToolSchema(
      z.object({ city: z.string() }),
      "test inputSchema",
    );
    tools.set(
      "geocode",
      registeredTool({
        name: "geocode",
        handler: handlerFn,
        inputSchema: schema,
        outputSchema: normalizeToolSchema(z.object({ ok: z.boolean() }), "x"),
      }),
    );
    const { handleToolCall, responds } = makeHandler(tools);

    await handleToolCall({
      id: "call-1",
      name: "geocode",
      argsJson: JSON.stringify({ city: "NYC" }),
    });

    expect(handlerFn).toHaveBeenCalledWith({ city: "NYC" }, expect.anything());
    expect(JSON.parse(responds[0]!.resultJson!)).toEqual({ ok: true });
  });

  test("invalid args against inputSchema respond tool_input_validation_error without calling the handler", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    const handlerFn = vi.fn();
    const schema = normalizeToolSchema(
      z.object({ city: z.string() }),
      "test inputSchema",
    );
    tools.set(
      "geocode",
      registeredTool({
        name: "geocode",
        handler: handlerFn,
        inputSchema: schema,
      }),
    );
    const { handleToolCall, responds } = makeHandler(tools);

    await handleToolCall({
      id: "call-1",
      name: "geocode",
      argsJson: JSON.stringify({ city: 5 }),
    });

    expect(handlerFn).not.toHaveBeenCalled();
    expect(JSON.parse(responds[0]!.errorJson!).type).toBe(
      "tool_input_validation_error",
    );
  });

  test("a handler that throws responds tool_execution_error with the error's message", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    tools.set(
      "boom",
      registeredTool({
        name: "boom",
        handler: () => {
          throw new Error("kaboom");
        },
      }),
    );
    const { handleToolCall, responds } = makeHandler(tools);

    await handleToolCall({ id: "call-1", name: "boom", argsJson: "{}" });

    const error = JSON.parse(responds[0]!.errorJson!);
    expect(error.type).toBe("tool_execution_error");
    expect(error.message).toBe("kaboom");
  });

  test("outputSchema omitted + handler returns a value responds tool_output_validation_error", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    tools.set(
      "noop",
      registeredTool({ name: "noop", handler: () => "unexpected" }),
    );
    const { handleToolCall, responds } = makeHandler(tools);

    await handleToolCall({ id: "call-1", name: "noop", argsJson: "{}" });

    expect(JSON.parse(responds[0]!.errorJson!).type).toBe(
      "tool_output_validation_error",
    );
  });

  test("a result failing outputSchema responds tool_output_validation_error", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    const schema = normalizeToolSchema(
      z.object({ ok: z.boolean() }),
      "test outputSchema",
    );
    tools.set(
      "tool",
      registeredTool({
        name: "tool",
        handler: () => ({ ok: "not-a-bool" }),
        outputSchema: schema,
      }),
    );
    const { handleToolCall, responds } = makeHandler(tools);

    await handleToolCall({ id: "call-1", name: "tool", argsJson: "{}" });

    expect(JSON.parse(responds[0]!.errorJson!).type).toBe(
      "tool_output_validation_error",
    );
  });

  test("reportProgress calls reportToolProgress with the call id", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    tools.set(
      "progressive",
      registeredTool({
        name: "progressive",
        handler: async (_args, context) => {
          await context.reportProgress(0.5, "halfway");
          return undefined;
        },
      }),
    );
    const { handleToolCall, progress } = makeHandler(tools);

    await handleToolCall({ id: "call-1", name: "progressive", argsJson: "{}" });

    expect(progress).toEqual([
      { id: "call-1", progress: 0.5, message: "halfway" },
    ]);
  });

  test("handleToolCancel aborts the matching in-flight signal", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    let observedAborted = false;
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    tools.set(
      "cancellable",
      registeredTool({
        name: "cancellable",
        handler: async (_args, context) => {
          handlerStarted();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => {
              observedAborted = true;
              resolve();
            });
          });
          return undefined;
        },
      }),
    );
    const { handleToolCall, handleToolCancel } = makeHandler(tools);

    const callPromise = handleToolCall({
      id: "call-1",
      name: "cancellable",
      argsJson: "{}",
    });
    await started;
    handleToolCancel({ id: "call-1", reason: "client_cancelled" });
    await callPromise;

    expect(observedAborted).toBe(true);
  });

  test("malformed argsJson falls back to an empty object instead of throwing", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    const handlerFn = vi.fn().mockResolvedValue(undefined);
    tools.set("noop", registeredTool({ name: "noop", handler: handlerFn }));
    const { handleToolCall, responds } = makeHandler(tools);

    await handleToolCall({ id: "call-1", name: "noop", argsJson: "not json" });

    expect(handlerFn).toHaveBeenCalledWith(undefined, expect.anything());
    expect(responds[0]?.errorJson).toBeNull();
  });

  test("abortAllInFlight aborts every pending signal", async () => {
    const tools = new Map<string, AppductRegisteredTool>();
    const abortedIds: string[] = [];
    let started = 0;
    const bothStarted = () => started === 2;
    tools.set(
      "slow",
      registeredTool({
        name: "slow",
        handler: async (_args, context) => {
          started += 1;
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => {
              abortedIds.push(context.invocationId);
              resolve();
            });
          });
        },
      }),
    );
    const { handleToolCall, abortAllInFlight } = makeHandler(tools);

    const call1 = handleToolCall({
      id: "call-1",
      name: "slow",
      argsJson: "{}",
    });
    const call2 = handleToolCall({
      id: "call-2",
      name: "slow",
      argsJson: "{}",
    });
    await vi.waitFor(() => expect(bothStarted()).toBe(true));

    abortAllInFlight();
    await Promise.all([call1, call2]);

    expect(abortedIds.sort()).toEqual(["call-1", "call-2"]);
  });
});
