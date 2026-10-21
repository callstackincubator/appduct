// A stand-in model that plays a fixed script of tool calls, so the agent-tool path runs without a
// model provider. It lists the app's tools, calls `sum`, then concludes the step.
import { MockLanguageModelV4 } from "ai/test";

const SCRIPT = [
  { toolName: "appduct_tools", input: {} },
  { toolName: "appduct_call", input: { name: "sum", args: { a: 2, b: 3 } } },
  { toolName: "complete_step", input: { status: "passed", summary: "Called sum through Appduct." } },
];

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const nextCall = (prompt: { role: string }[]) => {
  const step = SCRIPT[Math.min(prompt.filter((m) => m.role === "tool").length, SCRIPT.length - 1)]!;
  return { type: "tool-call" as const, toolCallId: `call-${Math.random()}`, toolName: step.toolName, input: JSON.stringify(step.input) };
};

export const scriptedModel = () =>
  new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => ({
      content: [nextCall(prompt)],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
      warnings: [],
    }),
    doStream: async ({ prompt }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue(nextCall(prompt));
          controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage });
          controller.close();
        },
      }),
    }),
  });
