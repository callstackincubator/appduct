import type { PageChannel } from "./ports.js";

const RECEIVE_PREFIX = "window.__APPDUCT__.receive(";

export type MemoryPageChannel = PageChannel & {
  /** The page calls its binding with an object, sent as JSON. */
  call(message: Record<string, unknown>): void;
  /** The document is destroyed. */
  resetContext(): void;
  /** What the relay delivered to `__APPDUCT__.receive`, parsed. */
  received(): Record<string, unknown>[];
};

export const createMemoryPageChannel = (): MemoryPageChannel => {
  const bindingHandlers: ((json: string) => void)[] = [];
  const resetHandlers: (() => void)[] = [];
  const expressions: string[] = [];

  return {
    onBindingCall: (handler) => void bindingHandlers.push(handler),
    onContextReset: (handler) => void resetHandlers.push(handler),
    evaluate: async (expression) => void expressions.push(expression),
    call: (message) => bindingHandlers.forEach((handler) => handler(JSON.stringify(message))),
    resetContext: () => resetHandlers.forEach((handler) => handler()),
    received: () =>
      expressions.map((expression) => {
        if (!expression.startsWith(RECEIVE_PREFIX) || !expression.endsWith(")")) {
          throw new Error(`the relay evaluated something other than receive(): ${expression}`);
        }
        const json = JSON.parse(expression.slice(RECEIVE_PREFIX.length, -1)) as string;
        return JSON.parse(json) as Record<string, unknown>;
      }),
  };
};
