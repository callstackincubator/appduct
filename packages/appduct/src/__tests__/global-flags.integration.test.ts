/**
 * End-to-end coverage for the global output flags (`--json`, `--pretty`, `--verbose`,
 * `--no-color`) that needs no daemon: an unknown command is rejected before any RPC, through the
 * same `dispatch.ts` parse-failure/unmatched-command paths every other command goes through.
 */

import { describe, expect, test } from "vitest";

import { runCliWithCapture } from "./fixtures.js";

describe("global flags (no daemon required)", () => {
  test("--json error output is a single line, with no meta by default", async () => {
    const result = await runCliWithCapture(["bogus-command", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.replace(/\n$/u, "").split("\n")).toHaveLength(1);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.type).toBe("usage_error");
    expect(parsed).not.toHaveProperty("meta");
  });

  test("--json --pretty error output is indented", async () => {
    const result = await runCliWithCapture(["bogus-command", "--json", "--pretty"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.split("\n").length).toBeGreaterThan(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  });

  test("--json --verbose error output carries meta.command", async () => {
    const result = await runCliWithCapture(["bogus-command", "--json", "--verbose"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.meta.command).toBe("cli");
  });

  test("human-mode error output never mentions Meta without --verbose", async () => {
    const result = await runCliWithCapture(["bogus-command"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain("Meta");
  });

  test("human-mode --verbose error output includes the Meta block", async () => {
    const result = await runCliWithCapture(["bogus-command", "--verbose"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Meta");
    expect(result.stderr).toContain("Command: cli");
  });
});

/**
 * A route's own argument errors (bad `--limit`, missing `<tool>`, too many positionals) must render
 * through the runner like any other usage error. Parsed in the route body, they escaped as an
 * uncaught rejection and the built CLI crashed with a stack trace.
 */
describe("route argument errors render as usage errors (no daemon required)", () => {
  test.each([
    [["tools", "--limit", "0"], /"--limit" must be a positive integer/u],
    [["tools", "--limit", "-1"], /"--limit" must be a positive integer/u],
    [["tools", "--offset", "abc"], /"--offset" must be a non-negative integer/u],
    [["tools", "--filter"], /"--filter" requires a value/u],
    [["tools", "a", "b", "c"], /Usage/u],
    [["invoke"], /Usage/u],
    [["revoke", "a", "b"], /Usage/u],
    [["events", "a", "b"], /Usage/u],
    [["events", "--since", "-1"], /"--since" must be a non-negative integer/u],
  ])("%j", async (argv, message) => {
    const result = await runCliWithCapture([...argv, "--json", "--state-dir", "/nonexistent-appduct-state"]);

    expect(result.exitCode).toBe(64);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.type).toBe("usage_error");
    expect(parsed.error.message).toMatch(message);
  });
});
