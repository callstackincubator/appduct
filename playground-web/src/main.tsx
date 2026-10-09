import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { postEvent, registerEvent } from "@appduct/web";
import { useAppductTool } from "@appduct/web/react";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const number = { type: "number" } as const;

function App() {
  const [callCount, setCallCount] = useState(0);
  const [lastPingAt, setLastPingAt] = useState<number | null>(null);
  const bump = () => setCallCount((count) => count + 1);

  useEffect(() => {
    const declaration = registerEvent({
      name: "playground_ping",
      description: "The Send playground_ping button was pressed.",
      payloadSchema: {
        type: "object",
        properties: { at: { type: "number", description: "Press time, milliseconds since the epoch" } },
        required: ["at"],
      },
    });
    return () => declaration.remove();
  }, []);

  useAppductTool({
    name: "sum",
    description: "Adds two numbers. Counts as a call in call_count.",
    inputSchema: { type: "object", properties: { a: number, b: number }, required: ["a", "b"] },
    outputSchema: { type: "object", properties: { total: number }, required: ["total"] },
    handler: (args) => {
      const { a, b } = args as { a: number; b: number };
      bump();
      return { total: a + b };
    },
  });

  useAppductTool({
    name: "call_count",
    description: "Reports how many times the counted tools (sum, slow_task) have run. Read-only.",
    group: "counter",
    annotations: { readOnlyHint: true },
    outputSchema: { type: "object", properties: { count: number }, required: ["count"] },
    handler: () => ({ count: callCount }),
  });

  useAppductTool({
    name: "reset_counter",
    description: "Resets the call counter to zero. Destructive; a no-op when it is already zero.",
    group: "counter",
    annotations: { destructiveHint: true, idempotentHint: true },
    outputSchema: { type: "object", properties: { count: number }, required: ["count"] },
    handler: () => {
      setCallCount(0);
      return { count: 0 };
    },
  });

  useAppductTool({
    name: "slow_task",
    description: "Takes about 1.5 s and reports progress along the way. Counts as a call in call_count.",
    group: "diagnostics/progress",
    outputSchema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
    timeoutMs: 5_000,
    handler: async (_args, context) => {
      for (const [progress, message] of [
        [0.33, "warming up"],
        [0.66, "almost there"],
        [1, "done"],
      ] as const) {
        await delay(500);
        await context.reportProgress(progress, message);
      }
      bump();
      return { done: true };
    },
  });

  useAppductTool({
    name: "throwing_tool",
    description: "Always fails with tool_execution_error. Changes nothing.",
    group: "diagnostics",
    annotations: { readOnlyHint: true },
    handler: () => {
      throw new Error("throwing_tool always fails on purpose.");
    },
  });

  const ping = async () => {
    const at = Date.now();
    await postEvent("playground_ping", { at });
    setLastPingAt(at);
  };

  return (
    <main>
      <h1>Appduct web playground</h1>
      <p id="count">Counted calls: {callCount}</p>
      <button id="ping" onClick={ping}>
        Send playground_ping
      </button>
      <p id="last-ping">{lastPingAt === null ? "No ping sent yet." : `Last ping at ${lastPingAt}`}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
