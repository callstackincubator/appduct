import type { PageChannel } from "./ports.js";

const RECEIVE_PREFIX = "window.__APPDUCT__.receive(";

export type MemoryPageChannel = PageChannel & {
  /** The page calls its binding with an object, sent as JSON. */
  call(message: Record<string, unknown>): void;
  /** The document is destroyed. */
  resetContext(): void;
  /** The connection is dropped: the context resets once, then the page stops calling the relay. */
  close(): void;
  /** What the relay delivered to `__APPDUCT__.receive`, parsed. */
  received(): Record<string, unknown>[];
  /** Every other expression evaluated in the page, in order. */
  evaluated(): string[];
  /** Makes `evaluate` reject for expressions matching `pattern`. */
  failEvaluate(pattern: RegExp, error: Error): void;
};

const isReceive = (expression: string): boolean => expression.startsWith(RECEIVE_PREFIX) && expression.endsWith(")");

export const createMemoryPageChannel = (): MemoryPageChannel => {
  const bindingHandlers: ((json: string) => void)[] = [];
  const resetHandlers: (() => void)[] = [];
  const expressions: string[] = [];
  const failures: { pattern: RegExp; error: Error }[] = [];

  return {
    onBindingCall: (handler) => void bindingHandlers.push(handler),
    onContextReset: (handler) => void resetHandlers.push(handler),
    evaluate: async (expression) => {
      const failure = failures.find(({ pattern }) => pattern.test(expression));
      if (failure) throw failure.error;
      expressions.push(expression);
    },
    failEvaluate: (pattern, error) => void failures.push({ pattern, error }),
    evaluated: () => expressions.filter((expression) => !isReceive(expression)),
    call: (message) => bindingHandlers.forEach((handler) => handler(JSON.stringify(message))),
    resetContext: () => resetHandlers.forEach((handler) => handler()),
    close: () => {
      resetHandlers.forEach((handler) => handler());
      resetHandlers.length = 0;
      bindingHandlers.length = 0;
    },
    received: () =>
      expressions.filter(isReceive).map((expression) => {
        const json = JSON.parse(expression.slice(RECEIVE_PREFIX.length, -1)) as string;
        return JSON.parse(json) as Record<string, unknown>;
      }),
  };
};
