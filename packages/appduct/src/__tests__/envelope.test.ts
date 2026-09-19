/**
 * `cli/envelope.ts`: the result envelope. `finalizeResult` only attaches `meta` under
 * `--verbose`, and never leaves a `meta: undefined` key behind otherwise.
 */

import { describe, expect, test } from "vitest";

import { createCommandMeta, finalizeResult } from "../cli/envelope.js";
import { FIXED_NOW } from "./fixtures.js";

describe("createCommandMeta", () => {
  test("computes duration_ms from the two dates and stamps the finish time", () => {
    const startedAt = FIXED_NOW;
    const finishedAt = new Date(FIXED_NOW.getTime() + 42);

    expect(createCommandMeta("ls", startedAt, finishedAt)).toEqual({
      command: "ls",
      timestamp: finishedAt.toISOString(),
      duration_ms: 42,
    });
  });
});

describe("finalizeResult", () => {
  const timing = { command: "ls", startedAt: FIXED_NOW, finishedAt: new Date(FIXED_NOW.getTime() + 5) };

  test("attaches meta under --verbose", () => {
    const finalized = finalizeResult({ ok: true, data: [] }, timing, { verbose: true });

    expect(finalized).toEqual({
      ok: true,
      data: [],
      meta: { command: "ls", timestamp: timing.finishedAt.toISOString(), duration_ms: 5 },
    });
  });

  test("leaves no meta key at all when not --verbose (not meta: undefined)", () => {
    const finalized = finalizeResult({ ok: true, data: [] }, timing, { verbose: false });

    expect(finalized).toEqual({ ok: true, data: [] });
    expect("meta" in finalized).toBe(false);
  });

  test("also attaches meta to a failure result under --verbose, and omits it otherwise", () => {
    const error = { ok: false as const, error: { type: "usage_error", message: "bad" } };

    const verbose = finalizeResult(error, timing, { verbose: true });
    expect(verbose.meta).toEqual({ command: "ls", timestamp: timing.finishedAt.toISOString(), duration_ms: 5 });

    const quiet = finalizeResult(error, timing, { verbose: false });
    expect("meta" in quiet).toBe(false);
  });
});
