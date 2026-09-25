/**
 * `cli/create-cli.ts` (issue #96, criterion 5): cac matches only the noun and builds its
 * boolean/string flag table from that noun's own declared options, so every verb's flags have to
 * be declared at the noun level or a boolean flag ahead of a positional would swallow it as that
 * flag's value. Checked directly against `cac`'s parse result — no daemon, no subprocess.
 */

import { describe, expect, test } from "vitest";

import { createCli } from "../cli/create-cli.js";

const parse = (argv: string[]) => {
  const cli = createCli();
  cli.parse(["node", "appduct", ...argv], { run: false });

  return { matched: cli.matchedCommandName, args: cli.args as string[], options: cli.options as Record<string, unknown> };
};

describe("a boolean flag ahead of a positional does not swallow it", () => {
  test('"tools ls --full <selector>" parses --full as a boolean and keeps the selector', () => {
    const result = parse(["tools", "ls", "--full", "my-selector"]);

    expect(result.matched).toBe("tools");
    expect(result.args).toEqual(["ls", "my-selector"]);
    expect(result.options.full).toBe(true);
  });

  test('"sessions link --qr --open ios-sim" parses both flags and keeps their values', () => {
    const result = parse(["sessions", "link", "--qr", "--open", "ios-sim"]);

    expect(result.matched).toBe("sessions");
    expect(result.args).toEqual(["link"]);
    expect(result.options.qr).toBe(true);
    expect(result.options.open).toBe("ios-sim");
  });
});

describe("each noun declares every option its verbs use", () => {
  test('"tools call" flags (--input/--timeout) parse under the "tools" command', () => {
    const result = parse(["tools", "call", "my-selector", "echo", "--input", "{}", "--timeout", "500"]);

    expect(result.matched).toBe("tools");
    expect(result.args).toEqual(["call", "my-selector", "echo"]);
    expect(result.options.input).toBe("{}");
    expect(result.options.timeout).toBe(500);
  });

  test('"sessions ls"/"sessions revoke" take no flags of their own but still match the "sessions" command', () => {
    const ls = parse(["sessions", "ls", "my-selector"]);
    expect(ls.matched).toBe("sessions");
    expect(ls.args).toEqual(["ls", "my-selector"]);

    const revoke = parse(["sessions", "revoke", "my-selector"]);
    expect(revoke.matched).toBe("sessions");
    expect(revoke.args).toEqual(["revoke", "my-selector"]);
  });

  test('"events since <cursor>" keeps the cursor as a positional, not a flag value', () => {
    const result = parse(["events", "since", "my-selector", "42"]);

    expect(result.matched).toBe("events");
    expect(result.args).toEqual(["since", "my-selector", "42"]);
  });
});
