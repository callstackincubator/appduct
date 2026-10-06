import type { SessionStore } from "./ports.js";

export type MemorySessionStore = SessionStore & {
  /** What is stored now, or null. */
  value(): string | null;
};

export const createMemorySessionStore = (initial: string | null = null): MemorySessionStore => {
  let stored = initial;
  return {
    read: () => stored,
    write: (value) => {
      stored = value;
    },
    clear: () => {
      stored = null;
    },
    value: () => stored,
  };
};
