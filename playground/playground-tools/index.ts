import { z } from "zod";
import type { AppductToolExecutionContext } from "@appduct/react-native";

/** The call counter the counted tools share; the Tools screen backs it with React state. */
export type PlaygroundCounter = {
  read(): number;
  bump(): void;
  reset(): void;
};

/** Delays `ms` without leaking a dangling timer past the call: each tool invocation owns its own. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The tools of the playground contract (docs/internal/playground-contract.md), as registrations
 * for `useAppductTool`.
 *
 * Groups: `counter` and `diagnostics` (with a `diagnostics/progress` subgroup), plus `sum` left
 * ungrouped -- so `appduct tools ls` shows headings, `--groups` has something to list, and
 * `--group diagnostics` vs `--group diagnostics/progress` differ.
 *
 * These tools are the template an agent copies (https://callstackincubator.github.io/appduct/guides/writing-tools/#design-tools-for-the-agent-that-calls-them):
 * every tool that returns something has an object-rooted `outputSchema`, observers carry
 * `readOnlyHint`, the one that resets state carries `destructiveHint` (and `idempotentHint`, since
 * resetting twice is the same as once), and each description's first line says what the tool does,
 * then its side effects.
 */
export function playgroundTools(counter: PlaygroundCounter) {
  const sumInput = z.object({ a: z.number(), b: z.number() });
  const count = z.object({ count: z.number() });

  return {
    sum: {
      name: "sum",
      description: "Adds two numbers. Counts as a call in call_count.",
      inputSchema: sumInput,
      outputSchema: z.object({ total: z.number() }),
      handler: (args: z.infer<typeof sumInput>) => {
        counter.bump();
        return { total: args.a + args.b };
      },
    },
    callCount: {
      name: "call_count",
      description: "Reports how many times the counted tools (sum, slow_task) have run. Read-only.",
      group: "counter",
      annotations: { readOnlyHint: true },
      outputSchema: count,
      // Reads the counter on every call, so it is current however often the screen re-rendered.
      handler: () => ({ count: counter.read() }),
    },
    resetCounter: {
      name: "reset_counter",
      description: "Resets the call counter to zero. Destructive; a no-op when it is already zero.",
      group: "counter",
      annotations: { destructiveHint: true, idempotentHint: true },
      outputSchema: count,
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
      outputSchema: z.object({ done: z.boolean() }),
      timeoutMs: 5_000,
      handler: async (_args: unknown, context: AppductToolExecutionContext) => {
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
  payloadSchema: z.object({
    at: z.number().describe("Press time, milliseconds since the epoch"),
  }),
};
