/**
 * `cli/router.ts`: the multi-level lazy router behind `runCli`. Checks the contract the startup
 * budget rests on (ARCHITECTURE.md §10 "Startup cost"): a route's loader runs only when its word
 * matches, nested routers consume one word per level, and an unmatched word is an ordinary
 * `usage_error` rendered through the runner.
 */

import { describe, expect, test, vi } from "vitest";

import { usageError } from "../errors.js";
import { commandName, createRouter, unknownCommandError, type Route, type RouteContext } from "../cli/router.js";
import { fixedClock } from "./fixtures.js";

const makeContext = (args: string[]): { context: RouteContext; stdout: () => string } => {
  let stdout = "";

  const context: RouteContext = {
    path: [],
    args,
    options: {},
    io: {
      json: true,
      color: false,
      clock: fixedClock,
      stdout: {
        isTTY: false,
        write(chunk: string | Uint8Array) {
          stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          return true;
        },
      },
      stderr: { write: () => true },
    },
    stateDir: "/nonexistent",
    versionCheck: { clientVersion: "0.0.0", forceRestart: async () => false, warn: () => {} },
  };

  return { context, stdout: () => stdout };
};

describe("cli/router", () => {
  test("loads only the matched route's module", async () => {
    const seen: RouteContext[] = [];
    const matched: Route = async (context) => {
      seen.push(context);
      return 0;
    };
    const loadMatched = vi.fn(async () => ({ route: matched }));
    const loadOther = vi.fn(async () => ({ route: matched }));

    const router = createRouter({ ls: loadMatched, mcp: loadOther }, { unknown: unknownCommandError });
    const { context } = makeContext(["ls", "extra"]);

    expect(await router(context)).toBe(0);
    expect(loadMatched).toHaveBeenCalledTimes(1);
    expect(loadOther).not.toHaveBeenCalled();
    expect(seen[0]?.path).toEqual(["ls"]);
    expect(seen[0]?.args).toEqual(["extra"]);
    expect(commandName(seen[0]!)).toBe("ls");
  });

  test("nested routers consume one word per level and report the full command name", async () => {
    let name = "";
    const leaf: Route = async (context) => {
      name = commandName(context);
      expect(context.args).toEqual(["tail"]);
      return 0;
    };
    const inner = createRouter(
      { status: async () => ({ route: leaf }) },
      { unknown: (word) => usageError(`bad action ${word}`) },
    );
    const outer = createRouter({ daemon: async () => ({ route: inner }) }, { unknown: unknownCommandError });

    expect(await outer(makeContext(["daemon", "status", "tail"]).context)).toBe(0);
    expect(name).toBe("daemon status");
  });

  test("an unmatched word renders the level's usage error through the runner", async () => {
    const inner = createRouter(
      { run: async () => ({ route: async () => 0 }) },
      { unknown: (word) => usageError(`requires an action (got ${word ?? "none"})`) },
    );
    const outer = createRouter({ daemon: async () => ({ route: inner }) }, { unknown: unknownCommandError });

    const missing = makeContext(["daemon"]);
    expect(await outer(missing.context)).toBe(64);
    const missingPayload = JSON.parse(missing.stdout());
    expect(missingPayload.error).toMatchObject({ type: "usage_error", message: "requires an action (got none)" });
    expect(missingPayload.meta.command).toBe("daemon");

    const wrong = makeContext(["daemon", "dance"]);
    expect(await outer(wrong.context)).toBe(64);
    expect(JSON.parse(wrong.stdout()).error.message).toBe("requires an action (got dance)");
  });

  test("a word that is only on Object.prototype does not match", async () => {
    const router = createRouter({ ls: async () => ({ route: async () => 0 }) }, { unknown: unknownCommandError });
    const { context, stdout } = makeContext(["constructor"]);

    expect(await router(context)).toBe(64);
    expect(JSON.parse(stdout()).error.message).toBe('Unknown command "constructor".');
  });
});
