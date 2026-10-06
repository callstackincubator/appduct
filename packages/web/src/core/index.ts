import type { AppductCore } from "@appduct/shared/sdk";

import type { WebCorePorts } from "./ports.js";

export { createManualClock, type ManualClock } from "./manual-clock.js";
export { createMemorySessionStore, type MemorySessionStore } from "./memory-session-store.js";
export { createMemoryTransport, type MemoryConnection, type MemoryTransport } from "./memory-transport.js";
export type {
  Clock,
  DeviceFields,
  SessionStore,
  Socket,
  SocketEvents,
  TimerHandle,
  Transport,
  WebCorePorts,
} from "./ports.js";

/** The session core for web: a TypeScript port of the Swift and Kotlin cores. */
export const createWebCore = (_ports: WebCorePorts): AppductCore => {
  throw new Error("createWebCore is not implemented yet.");
};
