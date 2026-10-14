/** The call counter the counted tools share; the page backs it with React state. */
export type PlaygroundCounter = {
  read(): number;
  bump(): void;
  reset(): void;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const number = { type: "number" } as const;

/** The tools of the playground contract (docs/internal/playground-contract.md), as registrations. */
export function playgroundTools(counter: PlaygroundCounter) {
  return {
    sum: {
      name: "sum",
      description: "Adds two numbers. Counts as a call in call_count.",
      inputSchema: { type: "object", properties: { a: number, b: number }, required: ["a", "b"] },
      outputSchema: { type: "object", properties: { total: number }, required: ["total"] },
      handler: (args: unknown) => {
        const { a, b } = args as { a: number; b: number };
        counter.bump();
        return { total: a + b };
      },
    },
    callCount: {
      name: "call_count",
      description: "Reports how many times the counted tools (sum, slow_task) have run. Read-only.",
      group: "counter",
      annotations: { readOnlyHint: true },
      outputSchema: { type: "object", properties: { count: number }, required: ["count"] },
      handler: () => ({ count: counter.read() }),
    },
    resetCounter: {
      name: "reset_counter",
      description: "Resets the call counter to zero. Destructive; a no-op when it is already zero.",
      group: "counter",
      annotations: { destructiveHint: true, idempotentHint: true },
      outputSchema: { type: "object", properties: { count: number }, required: ["count"] },
      handler: () => {
        counter.reset();
        return { count: 0 };
      },
    },
    slowTask: {
      name: "slow_task",
      description:
        "Takes about 1.5 s and reports progress along the way. Counts as a call in call_count.",
      group: "diagnostics/progress",
      outputSchema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
      timeoutMs: 5_000,
      handler: async (_args: unknown, context: { reportProgress(progress?: number, message?: string): Promise<void> }) => {
        for (const [progress, message] of [
          [0.33, "warming up"],
          [0.66, "almost there"],
          [1, "done"],
        ] as const) {
          await delay(500);
          await context.reportProgress(progress, message);
        }
        counter.bump();
        return { done: true };
      },
    },
    throwingTool: {
      name: "throwing_tool",
      description: "Always fails with tool_execution_error. Changes nothing.",
      group: "diagnostics",
      annotations: { readOnlyHint: true },
      handler: () => {
        throw new Error("throwing_tool always fails on purpose.");
      },
    },
  };
}

/** Declared at startup, so `events ls` lists it before any link. */
export const playgroundPingEvent = {
  name: "playground_ping",
  description: "The Send playground_ping button on the Status screen was pressed.",
  payloadSchema: {
    type: "object",
    properties: { at: { type: "number", description: "Press time, milliseconds since the epoch" } },
    required: ["at"],
  },
};
