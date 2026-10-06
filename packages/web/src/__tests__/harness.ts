import type { AppductCore } from "@appduct/shared/sdk";

import {
  createManualClock,
  createMemorySessionStore,
  createMemoryTransport,
  createWebCore,
  type MemoryConnection,
  type MemorySessionStore,
  type MemoryTransport,
  type ManualClock,
} from "../core/index.js";

export const START_MS = 1_700_000_000_000;
export const SESSION_ID = "XzAERP54_Goh74hZ";

export const DEVICE = { manufacturer: "Google", model: "Chrome 140", os: "macOS" };

export type Recorded = {
  states: { state: string; reason?: string }[];
  sessions: { type: string; sessionId: string | null; alias: string | null; reason?: string }[];
  errors: { phase: string; message: string; closeReason?: string }[];
  toolCalls: { id: string; name: string; argsJson: string }[];
  toolCancels: { id: string; reason: string }[];
};

export type Harness = {
  core: AppductCore;
  transport: MemoryTransport;
  sessionStore: MemorySessionStore;
  clock: ManualClock;
  recorded: Recorded;
  /** A new core over the same transport, store and clock, as after a page reload. */
  reload(): Harness;
  /** Starts `connect` with a claim token and returns the pending promise. */
  startClaim(overrides?: Record<string, unknown>): Promise<void>;
  /** Claims a session end to end and returns the socket. */
  claim(options?: { eventRegistry?: boolean; graceS?: number; resumeToken?: string }): Promise<MemoryConnection>;
  /** Waits for pending promise callbacks and socket close notifications. */
  settle(): Promise<void>;
  last(): MemoryConnection;
};

export const connectInput = (overrides: Record<string, unknown> = {}) => ({
  ip: "127.0.0.1",
  port: 49152,
  sessionId: SESSION_ID,
  token: "claim-token",
  expiresAt: Math.floor(START_MS / 1000) + 60,
  ...overrides,
});

export const ack = (
  options: { eventRegistry?: boolean; graceS?: number; resumeToken?: string; sessionId?: string } = {},
) => ({
  type: "session_ack",
  session_id: options.sessionId ?? SESSION_ID,
  status: "ok",
  alias: "chrome",
  resume_token: options.resumeToken ?? "resume-1",
  keepalive_interval_s: 15,
  grace_s: options.graceS ?? 600,
  ...(options.eventRegistry ? { event_registry: true } : {}),
});

export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const build = (
  transport: MemoryTransport,
  sessionStore: MemorySessionStore,
  clock: ManualClock,
): Harness => {
  const core = createWebCore({ transport, sessionStore, clock, random: () => 0.5, device: DEVICE });
  const recorded: Recorded = { states: [], sessions: [], errors: [], toolCalls: [], toolCancels: [] };
  core.addListener("stateChange", (event) => recorded.states.push(event));
  core.addListener("sessionChange", (event) => recorded.sessions.push(event));
  core.addListener("error", (event) => recorded.errors.push(event));
  core.addListener("toolCall", (event) => recorded.toolCalls.push(event));
  core.addListener("toolCancel", (event) => recorded.toolCancels.push(event));

  const last = () => {
    const connection = transport.connections.at(-1);
    if (!connection) throw new Error("the core has not opened a socket");
    return connection;
  };

  const harness: Harness = {
    core,
    transport,
    sessionStore,
    clock,
    recorded,
    last,
    settle,
    reload: () => build(transport, sessionStore, clock),
    startClaim: (overrides) => core.connect(JSON.stringify(connectInput(overrides)), false),
    async claim(options = {}) {
      const connecting = harness.startClaim();
      const connection = last();
      connection.open();
      connection.receive(ack(options));
      await connecting;
      await settle();
      return connection;
    },
  };
  return harness;
};

export const setup = (): Harness =>
  build(createMemoryTransport(), createMemorySessionStore(), createManualClock(START_MS));

export const toolDescriptor = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, description: `The ${name} tool.`, ...extra });
