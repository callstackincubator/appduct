/**
 * Per-session registry of what an app declared, by name (ARCHITECTURE.md §7): one instance holds a
 * session's tools, another its events (issue #124). Callers (sessions.ts) must validate incoming
 * `tool_registry_*`/`event_registry_*` wire messages with the shared guards *before* calling into
 * this module — v1 crashed by indexing into an unvalidated `tools: [null]` snapshot; this module
 * only ever stores already-validated descriptors.
 */

import type { EventDescriptor, ToolDescriptor } from "@appduct/shared";

export type Registry<T extends { name: string }> = {
  /** Authoritative replace: used for the initial snapshot and every post-resume re-sync. */
  snapshot: (items: T[]) => void;
  upsert: (item: T) => void;
  remove: (name: string) => void;
  list: () => T[];
  get: (name: string) => T | undefined;
  count: () => number;
};

export type ToolRegistry = Registry<ToolDescriptor>;
export type EventRegistry = Registry<EventDescriptor>;

/** `onChange` fires after every mutation (snapshot/upsert/remove) — used to emit `tools_changed`
 * and `events_changed`. */
export const createRegistry = <T extends { name: string }>(onChange?: () => void): Registry<T> => {
  let tools = new Map<string, T>();

  const notify = (): void => {
    onChange?.();
  };

  return {
    snapshot: (incoming) => {
      tools = new Map(incoming.map((tool) => [tool.name, tool] as const));
      notify();
    },
    upsert: (tool) => {
      tools.set(tool.name, tool);
      notify();
    },
    remove: (name) => {
      if (tools.delete(name)) {
        notify();
      }
    },
    list: () => Array.from(tools.values()),
    get: (name) => tools.get(name),
    count: () => tools.size,
  };
};
