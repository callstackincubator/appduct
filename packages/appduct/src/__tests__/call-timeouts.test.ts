/**
 * `daemon/calls.ts`'s timeout arithmetic (issue #25). `clampTimeout` decides the deadline the
 * daemon actually enforces for a `tools.call`; `deriveCallTransportTimeoutMs` is what every caller
 * (the MCP server, `appduct invoke`) sizes its own socket watchdog off, so that the daemon's
 * `tool_timeout` always wins the race and the caller reports the real error type.
 */

import { describe, expect, test } from "vitest";

import { transportTimeoutForToolCall } from "../client/app-client.js";
import {
  CALL_TRANSPORT_TIMEOUT_SLACK_MS,
  clampTimeout,
  DEFAULT_CALL_TIMEOUT_MS,
  deriveCallTransportTimeoutMs,
  MAX_CALL_TIMEOUT_MS,
  MIN_CALL_TIMEOUT_MS,
} from "../daemon/calls.js";

describe("clampTimeout", () => {
  test("falls back to the daemon default when unset or not finite", () => {
    expect(clampTimeout(undefined)).toBe(DEFAULT_CALL_TIMEOUT_MS);
    expect(clampTimeout(Number.NaN)).toBe(DEFAULT_CALL_TIMEOUT_MS);
    expect(clampTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CALL_TIMEOUT_MS);
  });

  test("passes an in-range value through, truncated to whole milliseconds", () => {
    expect(clampTimeout(60_000)).toBe(60_000);
    expect(clampTimeout(1_500.9)).toBe(1_500);
  });

  test("clamps to the documented bounds", () => {
    expect(clampTimeout(0)).toBe(MIN_CALL_TIMEOUT_MS);
    expect(clampTimeout(-1)).toBe(MIN_CALL_TIMEOUT_MS);
    expect(clampTimeout(MAX_CALL_TIMEOUT_MS + 1)).toBe(MAX_CALL_TIMEOUT_MS);
    expect(clampTimeout(Number.MAX_SAFE_INTEGER)).toBe(MAX_CALL_TIMEOUT_MS);
  });
});

describe("deriveCallTransportTimeoutMs", () => {
  test("is the enforced deadline plus slack", () => {
    expect(deriveCallTransportTimeoutMs(undefined)).toBe(DEFAULT_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
    expect(deriveCallTransportTimeoutMs(60_000)).toBe(60_000 + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
  });

  test("adds slack to the clamped value, not the raw one", () => {
    expect(deriveCallTransportTimeoutMs(500)).toBe(MIN_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
    // Clamping first is what keeps this inside Node's ~24.8-day timer range: an unclamped
    // MAX_SAFE_INTEGER would overflow and fire the watchdog immediately.
    const derived = deriveCallTransportTimeoutMs(Number.MAX_SAFE_INTEGER);
    expect(derived).toBe(MAX_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
    expect(derived).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  test("always exceeds the deadline the daemon will enforce for the same input", () => {
    for (const timeoutMs of [undefined, 0, 1_000, 10_000, 60_000, 600_000, 900_000]) {
      expect(deriveCallTransportTimeoutMs(timeoutMs)).toBeGreaterThan(clampTimeout(timeoutMs));
    }
  });
});

/**
 * `appduct invoke` and `AppClient.call` differ from the MCP server: they pass the *caller's*
 * timeout, so `undefined` there means "the daemon will fall back to the tool's own declared
 * deadline", which neither knows. Sizing their watchdog off the 10 s default would make the caller
 * the thing that fails a long tool call.
 */
describe("callers that do not know the effective deadline", () => {
  test("invoke with no --timeout sizes its watchdog for the largest deadline the daemon could enforce", () => {
    // Mirrors `commands/invoke.ts`: `options.timeoutMs ?? MAX_CALL_TIMEOUT_MS`.
    const noCallerTimeout: number | undefined = undefined;
    expect(deriveCallTransportTimeoutMs(noCallerTimeout ?? MAX_CALL_TIMEOUT_MS)).toBe(
      MAX_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS,
    );
    // …and never below what a tool declaring the maximum would actually be given.
    expect(deriveCallTransportTimeoutMs(MAX_CALL_TIMEOUT_MS)).toBeGreaterThan(clampTimeout(MAX_CALL_TIMEOUT_MS));
  });

  test("AppClient.call falls back to the same bound, and uses the exact deadline when given one", () => {
    expect(transportTimeoutForToolCall(undefined)).toBe(MAX_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
    expect(transportTimeoutForToolCall(Number.NaN)).toBe(MAX_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
    expect(transportTimeoutForToolCall(60_000)).toBe(60_000 + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
    expect(transportTimeoutForToolCall(500)).toBe(MIN_CALL_TIMEOUT_MS + CALL_TRANSPORT_TIMEOUT_SLACK_MS);
  });
});
