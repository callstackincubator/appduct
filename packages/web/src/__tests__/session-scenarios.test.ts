import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createManualClock,
  createMemorySessionStore,
  createMemoryTransport,
  createWebCore,
  type MemoryConnection,
} from "../core/index.js";
import { DEVICE } from "./harness.js";

/**
 * Replays `packages/native/fixtures/session-scenarios.json` through the web core, the way
 * `SessionScenariosTests.swift` replays it through the Swift core. The format is documented in
 * `packages/native/fixtures/README.md`.
 */

type Json = unknown;
type DriveStep = { drive: string; [field: string]: Json };
type ExpectStep = { expect: string; [field: string]: Json };
type Step = DriveStep | ExpectStep;
const isDrive = (step: Step): step is DriveStep => "drive" in step;
type Scenario = { name: string; startMs: number; random: number; steps: Step[] };
/** One thing the core did, in the shape an `expect` step spells out: `{ kind, ...fields }`. */
type Output = { kind: string; [field: string]: Json };

const SCENARIOS_FILE = fileURLToPath(new URL("../../../native/fixtures/session-scenarios.json", import.meta.url));
const scenarios = JSON.parse(readFileSync(SCENARIOS_FILE, "utf8")) as Scenario[];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Plays every step of `scenario` against a fresh core. Throws on the first output that is
 * missing, comes in the wrong order or differs, and on any output left when the steps run out. */
const replay = async (scenario: Scenario, expectTimeoutMs = 1000): Promise<void> => {
  const clock = createManualClock(scenario.startMs);
  const transport = createMemoryTransport();
  const core = createWebCore({
    transport,
    devtoolsTransport: createMemoryTransport(),
    sessionStore: createMemorySessionStore(),
    clock,
    random: () => scenario.random,
    device: DEVICE,
  });

  const wire: Output[] = [];
  const app: Output[] = [];
  core.addListener("stateChange", (event) =>
    app.push({ kind: "state", state: event.state, ...(event.reason !== undefined ? { reason: event.reason } : {}) }),
  );
  core.addListener("sessionChange", (event) =>
    app.push({ kind: "session", type: event.type, ...(event.reason !== undefined ? { reason: event.reason } : {}) }),
  );
  core.addListener("toolCall", (event) =>
    app.push({ kind: "call", name: event.name, args: JSON.parse(event.argsJson) as Json }),
  );
  core.addListener("toolCancel", (event) => app.push({ kind: "cancel", call: event.id, reason: event.reason }));

  // Opens each socket the core made since the last look, which makes the core send its first frame,
  // and turns that frame into the `connect` output. Every later frame is a `send` output.
  const framesSeen = new Map<MemoryConnection, number>();
  const collectWire = () => {
    for (const connection of transport.connections) {
      let seen = framesSeen.get(connection);
      if (seen === undefined) {
        connection.open();
        const first = connection.frames()[0];
        if (!first) throw new Error("the core opened a socket and sent no first frame");
        wire.push({
          kind: "connect",
          mode: first.type === "session_resume" ? "resume" : "claim",
          sessionId: first.session_id,
          ...(typeof first.resume_token === "string" ? { resumeToken: first.resume_token } : {}),
          ...(typeof first.token === "string" ? { token: first.token } : {}),
        });
        seen = 1;
      }
      const frames = connection.frames();
      for (; seen < frames.length; seen += 1) wire.push({ kind: "send", frame: frames[seen] });
      framesSeen.set(connection, seen);
    }
  };

  const latest = (): MemoryConnection => {
    const connection = transport.connections.at(-1);
    if (!connection) throw new Error("the core has not opened a socket yet");
    return connection;
  };

  const drive = async (step: DriveStep) => {
    switch (step.drive) {
      case "connect":
        core
          .connect(
            JSON.stringify({
              ip: "127.0.0.1",
              port: 49152,
              sessionId: step.sessionId,
              token: step.token,
              expiresAt: step.expiresAt,
            }),
            false,
          )
          .catch(() => undefined);
        break;
      case "receive":
        latest().receive(step.frame);
        break;
      case "close":
        latest().closeFromDaemon(step.code as number, step.reason as string | undefined);
        break;
      case "drop":
        latest().drop();
        break;
      case "advance":
        clock.advance(step.ms as number);
        break;
      case "registerTool":
        core.registerTool(JSON.stringify(step.descriptor));
        break;
      case "respond":
        core.respondToToolCall(
          step.call as string,
          step.result !== undefined ? JSON.stringify(step.result) : null,
          step.error !== undefined ? JSON.stringify(step.error) : null,
        );
        break;
      case "disconnect":
        await core.disconnect();
        break;
      default:
        throw new Error(`unknown drive step "${step.drive}"`);
    }
    await sleep(0);
    collectWire();
  };

  const kinds: Record<string, Output[]> = { connect: wire, send: wire, state: app, session: app, call: app, cancel: app };
  const expectOutput = async (step: ExpectStep, label: string) => {
    const channel = kinds[step.expect];
    if (!channel) throw new Error(`${label}: unknown expect step "${step.expect}"`);
    const { expect: kind, ...fields } = step;
    const wanted: Output = { kind, ...fields };

    const deadline = Date.now() + expectTimeoutMs;
    for (;;) {
      collectWire();
      if (channel.length > 0) break;
      if (Date.now() >= deadline) {
        throw new Error(`${label}: expected ${JSON.stringify(wanted)} but nothing arrived within ${expectTimeoutMs} ms`);
      }
      await sleep(2);
    }
    const got = channel.shift();
    if (!isDeepStrictEqual(got, wanted)) {
      throw new Error(`${label}: expected ${JSON.stringify(wanted)} but got ${JSON.stringify(got)}`);
    }
  };

  for (const [index, step] of scenario.steps.entries()) {
    const label = `${scenario.name}, step ${index + 1}`;
    if (isDrive(step)) await drive(step);
    else await expectOutput(step, label);
  }

  await sleep(0);
  collectWire();
  const leftover = [...wire, ...app];
  if (leftover.length > 0) {
    throw new Error(`${scenario.name}: the steps ran out with outputs left over: ${JSON.stringify(leftover)}`);
  }
};

describe("session-scenarios.json", () => {
  it("has scenarios", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))("replays: %s", async (_name, scenario) => {
    await replay(scenario);
  });
});

describe("the scenario runner", () => {
  const SESSION_ID = "session-1";
  const ack = {
    type: "session_ack",
    session_id: SESSION_ID,
    status: "ok",
    alias: "phone",
    resume_token: "resume-1",
    keepalive_interval_s: 15,
    grace_s: 10,
  };
  const claimThenActive: Step[] = [
    { drive: "connect", sessionId: SESSION_ID, token: "claim-token", expiresAt: 1700000300 },
    { expect: "connect", mode: "claim", sessionId: SESSION_ID, token: "claim-token" },
    { expect: "state", state: "connecting" },
    { drive: "receive", frame: ack },
    { expect: "state", state: "active" },
    { expect: "session", type: "claimed" },
  ];
  const snapshot: Step = {
    expect: "send",
    frame: { tools: [], session_id: SESSION_ID, type: "tool_registry_snapshot" },
  };
  const inline = (steps: Step[]): Scenario => ({ name: "inline", startMs: 1700000000000, random: 0.5, steps });

  it("passes a scenario whose frame keys are in another order", async () => {
    await replay(inline([...claimThenActive, snapshot]));
  });

  it("fails a scenario that expects an output the core never produces", async () => {
    const missing = inline([...claimThenActive, snapshot, { expect: "state", state: "closed" }]);
    await expect(replay(missing, 50)).rejects.toThrow(/step 8: .*nothing arrived/);
  });

  it("fails a scenario that leaves an output the core produced unexpected", async () => {
    await expect(replay(inline(claimThenActive), 50)).rejects.toThrow(/outputs left over.*tool_registry_snapshot/);
  });

  it("fails a scenario that expects two outputs of one channel in the wrong order", async () => {
    const swapped = inline([
      ...claimThenActive.slice(0, 2),
      { expect: "state", state: "active" },
      { expect: "state", state: "connecting" },
      ...claimThenActive.slice(3),
    ]);
    await expect(replay(swapped, 50)).rejects.toThrow(/step 3: expected .*"active".* but got .*"connecting"/);
  });

  it("passes a tool call answered by the app", async () => {
    await replay(
      inline([
        { drive: "registerTool", descriptor: { name: "echo", description: "Echoes." } },
        ...claimThenActive,
        { expect: "send", frame: { type: "tool_registry_snapshot", session_id: SESSION_ID, tools: [{ name: "echo", description: "Echoes." }] } },
        { drive: "receive", frame: { type: "tool_call", session_id: SESSION_ID, id: "call-1", name: "echo", args: { a: 1 } } },
        { expect: "call", name: "echo", args: { a: 1 } },
        { drive: "respond", call: "call-1", result: { ok: true } },
        { expect: "send", frame: { type: "tool_result", session_id: SESSION_ID, id: "call-1", result: { ok: true } } },
      ]),
    );
  });
});
