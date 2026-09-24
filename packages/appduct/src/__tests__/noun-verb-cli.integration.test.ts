/**
 * Issue #96: the CLI is unified as noun-verb commands (`sessions`, `tools`, `events`), with no
 * aliases for the removed bare-verb forms. Every usage-error case here is resolved by the router
 * before any daemon contact, so it runs in-process (`runCliWithCapture`) with no state dir and no
 * daemon, exactly like `global-flags.integration.test.ts`. The `--help` cases spawn the real
 * binary (`runCliBinary`) instead: cac's own `--help` handler prints through `console.log`
 * directly, bypassing the writer `runCliWithCapture` injects.
 */

import { describe, expect, test } from "vitest";

import { runCliBinary, runCliWithCapture } from "./fixtures.js";

describe("removed top-level commands name their replacement (criterion 2)", () => {
  test.each([
    ["ls", "sessions ls"],
    ["revoke", "sessions revoke"],
    ["link", "sessions link"],
    ["invoke", "tools call"],
  ])('"appduct %s" exits 64 naming "appduct %s"', async (removed, replacement) => {
    const result = await runCliWithCapture([removed, "--json"]);

    expect(result.exitCode).toBe(64);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.type).toBe("usage_error");
    expect(parsed.error.message).toBe(`Unknown command "${removed}"; use "appduct ${replacement}".`);
  });

  test("an unrelated unknown command is not treated as a removed one", async () => {
    const result = await runCliWithCapture(["bogus-command", "--json"]);

    expect(result.exitCode).toBe(64);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.message).toBe('Unknown command "bogus-command".');
  });
});

describe("a bare noun with no verb, or an unknown verb, names its verbs (criterion 3)", () => {
  test.each([
    ["sessions", "ls, revoke, or link"],
    ["tools", "ls, describe, or call"],
    ["events", "tail or since"],
  ])('"appduct %s" alone exits 64 naming its verbs', async (noun, verbList) => {
    const result = await runCliWithCapture([noun, "--json"]);

    expect(result.exitCode).toBe(64);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.type).toBe("usage_error");
    expect(parsed.error.message).toBe(`The ${noun} command requires a verb: ${verbList} (got none).`);
  });

  test.each([
    ["sessions", "ls, revoke, or link"],
    ["tools", "ls, describe, or call"],
    ["events", "tail or since"],
  ])('"appduct %s bogus-verb" exits 64 naming its verbs', async (noun, verbList) => {
    const result = await runCliWithCapture([noun, "bogus-verb", "--json"]);

    expect(result.exitCode).toBe(64);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.type).toBe("usage_error");
    expect(parsed.error.message).toBe(`The ${noun} command requires a verb: ${verbList} (got "bogus-verb").`);
  });

  test.each(["sessions", "tools", "events"])('"appduct %s --help" exits 0', (noun) => {
    const result = runCliBinary([noun, "--help"]);

    expect(result.exitCode).toBe(0);
  });

  // cac's per-command `--help` shows usage and flags but never a command's own description
  // (checked against `appduct daemon --help`, the existing model, which doesn't print its verbs
  // either) — a description only surfaces in the *global* `--help`'s "Commands" section, so that
  // is where each noun's verbs actually get printed, exactly like `daemon`'s already does.
  test.each([
    ["sessions", ["ls", "revoke", "link"]],
    ["tools", ["ls", "describe", "call"]],
    ["events", ["tail", "since"]],
  ])('"appduct --help" prints %s\'s verbs in its description', (noun, verbs) => {
    const result = runCliBinary(["--help"]);

    expect(result.exitCode).toBe(0);

    const commandsSection = result.stdout.split(/\n\s*\n/u).find((block) => block.startsWith("Commands:"));
    expect(commandsSection).toBeDefined();
    const nounLine = commandsSection!.split("\n").find((line) => line.trim().startsWith(`${noun} `));
    expect(nounLine, commandsSection).toBeDefined();

    for (const verb of verbs) {
      expect(nounLine).toContain(verb);
    }
  });
});

describe("events ls is reserved for #95, until then it is just an unknown verb (criterion 4)", () => {
  test('"appduct events ls" exits 64 naming tail and since', async () => {
    const result = await runCliWithCapture(["events", "ls", "--json"]);

    expect(result.exitCode).toBe(64);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.type).toBe("usage_error");
    expect(parsed.error.message).toBe('The events command requires a verb: tail or since (got "ls").');
  });
});
