/**
 * The daemon's own event log (`<stateDir>/events.log`): one JSON line per recorded event, rotated
 * to a single backup once it grows past its cap. Observed through `createEventsLog` with the
 * in-memory `AppendOnlyFile` fake.
 */

import { describe, expect, test } from "vitest";

import type { EventNotification } from "@appduct/shared";

import { createEventsLog } from "../daemon/events-log.js";
import { MemoryAppendOnlyFile } from "../daemon/memory-append-only-file.js";

const event = (seq: number): EventNotification => ({
  kind: "tool_call_started",
  sessionId: "session-1",
  alias: "pixel-8",
  ts: 1_700_000_000_000 + seq,
  data: { callId: `call-${seq}`, name: "echo" },
  seq,
});

/** Bytes one {@link event} line takes on disk, newline included. */
const lineBytes = (seq: number): number => Buffer.byteLength(`${JSON.stringify(event(seq))}\n`);

describe("events log", () => {
  test("appends each recorded event as one JSON line, in order", async () => {
    const file = new MemoryAppendOnlyFile();
    const log = createEventsLog({ file, maxBytes: 1024 * 1024, warn: () => {} });

    log.record(event(1));
    log.record(event(2));
    await log.flush();

    expect(file.lines().map((line) => JSON.parse(line))).toEqual([event(1), event(2)]);
    expect(file.backupLines()).toEqual([]);
  });

  test("rotates to the backup once the file exceeds maxBytes, and never leaves the file above the cap after a write", async () => {
    const file = new MemoryAppendOnlyFile();
    // Room for two lines, not three.
    const maxBytes = lineBytes(1) * 2 + 1;
    const log = createEventsLog({ file, maxBytes, warn: () => {} });

    for (let seq = 1; seq <= 3; seq += 1) {
      log.record(event(seq));
      await log.flush();
      expect(await file.size()).toBeLessThanOrEqual(maxBytes);
    }

    expect(file.backupLines().map((line) => JSON.parse(line))).toEqual([event(1), event(2), event(3)]);
    expect(file.lines()).toEqual([]);

    log.record(event(4));
    await log.flush();

    expect(file.lines().map((line) => JSON.parse(line))).toEqual([event(4)]);
  });

  test("replaces the previous backup on a second rotation", async () => {
    const file = new MemoryAppendOnlyFile();
    const maxBytes = lineBytes(1) + 1;
    const log = createEventsLog({ file, maxBytes, warn: () => {} });

    for (let seq = 1; seq <= 4; seq += 1) {
      log.record(event(seq));
    }
    await log.flush();

    // Every second line tips the file over the cap, so the backup holds only the last pair.
    expect(file.backupLines().map((line) => JSON.parse(line))).toEqual([event(3), event(4)]);
    expect(file.lines()).toEqual([]);
  });

  test("warns about a failed write, never throws, and keeps writing afterwards", async () => {
    const file = new MemoryAppendOnlyFile();
    const warnings: string[] = [];
    const log = createEventsLog({ file, maxBytes: 1024 * 1024, warn: (message) => warnings.push(message) });

    file.failAppendsWith(new Error("disk full"));
    expect(() => log.record(event(1))).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("disk full");

    file.failAppendsWith(undefined);
    log.record(event(2));
    await log.flush();

    expect(file.lines().map((line) => JSON.parse(line))).toEqual([event(2)]);
  });
});
