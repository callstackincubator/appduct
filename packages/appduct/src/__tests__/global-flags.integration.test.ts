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
