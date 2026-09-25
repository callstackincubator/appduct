import { describe, expect, test } from "vitest";

import {
  parseJsonInputOption,
  parseNonNegativeIntegerOption,
  parsePositiveIntegerOption,
  readTextOption,
  splitOptionalSelector,
  splitSelectorAndRequiredTarget,
} from "../cli/command-options.js";

describe("parsePositiveIntegerOption", () => {
  test("passes through undefined", () => {
    expect(parsePositiveIntegerOption(undefined, "--ttl")).toBeUndefined();
  });

  test("accepts a numeric string", () => {
    expect(parsePositiveIntegerOption("60", "--ttl")).toBe(60);
  });

  test("rejects zero, negative, and non-numeric values", () => {
    expect(() => parsePositiveIntegerOption("0", "--ttl")).toThrow(/positive integer/u);
    expect(() => parsePositiveIntegerOption("-5", "--ttl")).toThrow(/positive integer/u);
    expect(() => parsePositiveIntegerOption("abc", "--ttl")).toThrow(/positive integer/u);
  });
});

describe("parseNonNegativeIntegerOption", () => {
  test("passes through undefined", () => {
    expect(parseNonNegativeIntegerOption(undefined, "--offset")).toBeUndefined();
  });

  test("accepts a numeric string, including zero", () => {
    expect(parseNonNegativeIntegerOption("0", "--offset")).toBe(0);
    expect(parseNonNegativeIntegerOption("42", "--offset")).toBe(42);
  });

  test("rejects negative, non-integer, and non-numeric values", () => {
    expect(() => parseNonNegativeIntegerOption("-1", "--offset")).toThrow(/non-negative integer/u);
    expect(() => parseNonNegativeIntegerOption("1.5", "--offset")).toThrow(/non-negative integer/u);
    expect(() => parseNonNegativeIntegerOption("abc", "--offset")).toThrow(/non-negative integer/u);
  });
});

describe("integer options given without a value", () => {
  // `cac` reports `--limit` with no value, or `--limit -1` (it reads `-1` as a flag), as `true`.
  test("a boolean is rejected rather than coerced to 1", () => {
    expect(() => parsePositiveIntegerOption(true, "--limit")).toThrow(/positive integer/u);
    expect(() => parseNonNegativeIntegerOption(true, "--offset")).toThrow(/non-negative integer/u);
  });

  test("a repeated flag (an array) is rejected", () => {
    expect(() => parsePositiveIntegerOption([1, 2], "--limit")).toThrow(/positive integer/u);
  });
});

describe("readTextOption", () => {
  test("passes through undefined", () => {
    expect(readTextOption([], undefined, "--filter")).toBeUndefined();
  });

  test("recovers the verbatim string cac coerced to a number", () => {
    expect(readTextOption(["tools", "--filter", "007"], 7, "--filter")).toBe("007");
    expect(readTextOption(["tools", "--filter=1e3"], 1000, "--filter")).toBe("1e3");
    expect(readTextOption(["tools", "--filter", "404"], 404, "--filter")).toBe("404");
  });

  test("the last occurrence wins and nothing after -- counts", () => {
    expect(readTextOption(["--filter", "a", "--filter", "b", "--", "--filter", "c"], ["a", "b"], "--filter")).toBe(
      "b",
    );
  });

  test("a flag with no value is a usage error", () => {
    expect(() => readTextOption(["tools", "--filter"], true, "--filter")).toThrow(/requires a value/u);
  });
});

describe("parseJsonInputOption", () => {
  test("parses a valid JSON object", () => {
    expect(parseJsonInputOption('{"text":"hi"}')).toEqual({ text: "hi" });
  });

  test("requires --input to be present", () => {
    expect(() => parseJsonInputOption(undefined)).toThrow(/"--input" is required/u);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseJsonInputOption("{not-json")).toThrow(/valid JSON/u);
  });

  test("rejects non-object JSON (arrays, scalars)", () => {
    expect(() => parseJsonInputOption("[1,2,3]")).toThrow(/JSON object/u);
    expect(() => parseJsonInputOption("42")).toThrow(/JSON object/u);
    expect(() => parseJsonInputOption("null")).toThrow(/JSON object/u);
  });
});

describe("splitSelectorAndRequiredTarget (tools call [selector] <name> / tools describe [selector] <name> / events since [selector] <cursor>)", () => {
  test("one arg: no selector, target is the sole arg", () => {
    expect(splitSelectorAndRequiredTarget(["echo"], "tools call")).toEqual({ target: "echo" });
  });

  test("two args: selector then target", () => {
    expect(splitSelectorAndRequiredTarget(["pixel-8", "echo"], "tools call")).toEqual({
      selector: "pixel-8",
      target: "echo",
    });
  });

  test("zero args: usage error (target is required)", () => {
    expect(() => splitSelectorAndRequiredTarget([], "tools call")).toThrow(/Usage/u);
  });

  test("three or more args: usage error", () => {
    expect(() => splitSelectorAndRequiredTarget(["a", "b", "c"], "tools call")).toThrow(/Usage/u);
  });
});

describe("splitOptionalSelector (sessions revoke [selector] / events tail [selector])", () => {
  test("zero args", () => {
    expect(splitOptionalSelector([], "sessions revoke")).toEqual({ selector: undefined });
  });

  test("one arg", () => {
    expect(splitOptionalSelector(["pixel-8"], "sessions revoke")).toEqual({ selector: "pixel-8" });
  });

  test("two or more args: usage error", () => {
    expect(() => splitOptionalSelector(["a", "b"], "sessions revoke")).toThrow(/Usage/u);
  });
});
