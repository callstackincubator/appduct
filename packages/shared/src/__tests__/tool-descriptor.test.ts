import { describe, expect, test } from "vitest";

import {
  clampToolTimeoutMs,
  isToolDescriptor,
  isValidToolGroup,
  summarizeToolGroups,
  toolGroupMatches,
  MAX_TOOL_DESCRIPTION_LENGTH,
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
  TOOL_NAME_PATTERN,
  type ToolDescriptor,
} from "../domains/tool-descriptor.js";

const valid = () => ({
  name: "read_file",
  description: "Reads a file.",
});

describe("isToolDescriptor", () => {
  test("accepts the minimal required shape", () => {
    expect(isToolDescriptor(valid())).toBe(true);
  });

  test("accepts optional schemas, and annotations", () => {
    expect(
      isToolDescriptor({
        ...valid(),
        input_schema: { type: "object" },
        output_schema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      }),
    ).toBe(true);
  });

  test("accepts partial annotations", () => {
    expect(isToolDescriptor({ ...valid(), annotations: { readOnlyHint: true } })).toBe(true);
  });

  test.each([
    ["empty string", ""],
    ["too long", "a".repeat(65)],
    ["invalid characters", "read file!"],
    ["invalid characters (dot)", "read.file"],
  ])("rejects a name that is %s", (_label, name) => {
    expect(isToolDescriptor({ ...valid(), name })).toBe(false);
  });

  test("name pattern accepts the documented alphabet", () => {
    expect(TOOL_NAME_PATTERN.test("A-Za-z0-9_-")).toBe(true);
    expect(TOOL_NAME_PATTERN.test("a".repeat(64))).toBe(true);
    expect(TOOL_NAME_PATTERN.test("a".repeat(65))).toBe(false);
  });

  test("rejects missing description", () => {
    const { description: _description, ...rest } = valid();
    expect(isToolDescriptor(rest)).toBe(false);
  });

  test("rejects a non-string description", () => {
    expect(isToolDescriptor({ ...valid(), description: 42 })).toBe(false);
  });

  test("rejects an oversized description", () => {
    expect(isToolDescriptor({ ...valid(), description: "a".repeat(MAX_TOOL_DESCRIPTION_LENGTH + 1) })).toBe(
      false,
    );
  });

  test("rejects a non-object input_schema", () => {
    expect(isToolDescriptor({ ...valid(), input_schema: "not-an-object" })).toBe(false);
  });

  test("rejects a non-object output_schema", () => {
    expect(isToolDescriptor({ ...valid(), output_schema: ["not", "an", "object"] })).toBe(false);
  });

  test("rejects annotation keys outside the three boolean hints", () => {
    expect(isToolDescriptor({ ...valid(), annotations: { readOnlyHint: true, extra: true } })).toBe(false);
  });

  test("rejects a non-boolean annotation value", () => {
    expect(isToolDescriptor({ ...valid(), annotations: { readOnlyHint: "yes" } })).toBe(false);
  });

  test("accepts a positive integer timeout_ms", () => {
    expect(isToolDescriptor({ ...valid(), timeout_ms: 60_000 })).toBe(true);
    expect(isToolDescriptor({ ...valid(), timeout_ms: 1 })).toBe(true);
  });

  test("accepts a descriptor that omits timeout_ms (older apps keep the daemon default)", () => {
    expect(isToolDescriptor(valid())).toBe(true);
    expect(isToolDescriptor({ ...valid(), timeout_ms: undefined })).toBe(true);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["a numeric string", "60000"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
  ])("rejects a timeout_ms that is %s", (_label, timeout_ms) => {
    expect(isToolDescriptor({ ...valid(), timeout_ms })).toBe(false);
  });

  test("ignores a camelCase timeoutMs: it is not the wire field, so it is neither honoured nor validated", () => {
    // Every protocol-defined descriptor field is snake_case. A camelCase key is just an unknown
    // extra: the guard must not read a deadline out of it, and must not reject the descriptor for
    // it either (an app is free to carry its own extras).
    const descriptor: unknown = { ...valid(), timeoutMs: 60_000 };
    expect(isToolDescriptor(descriptor)).toBe(true);

    if (isToolDescriptor(descriptor)) {
      expect(descriptor.timeout_ms).toBeUndefined();
    }

    // …not even when its value is one the snake_case field would have been rejected for.
    expect(isToolDescriptor({ ...valid(), timeoutMs: -1 })).toBe(true);
    expect(isToolDescriptor({ ...valid(), timeoutMs: "nonsense" })).toBe(true);
  });

  test("rejects null", () => {
    expect(isToolDescriptor(null)).toBe(false);
  });

  test("rejects an array", () => {
    expect(isToolDescriptor(["not", "an", "object"])).toBe(false);
  });

  test("rejects a bare primitive", () => {
    expect(isToolDescriptor("not-an-object")).toBe(false);
  });
});

describe("clampToolTimeoutMs", () => {
  test("passes an in-range value through, truncated to whole milliseconds", () => {
    expect(clampToolTimeoutMs(60_000)).toBe(60_000);
    expect(clampToolTimeoutMs(1_500.9)).toBe(1_500);
  });

  test("clamps to the bounds the daemon enforces", () => {
    expect(clampToolTimeoutMs(0)).toBe(MIN_TOOL_TIMEOUT_MS);
    expect(clampToolTimeoutMs(-1)).toBe(MIN_TOOL_TIMEOUT_MS);
    expect(clampToolTimeoutMs(999)).toBe(MIN_TOOL_TIMEOUT_MS);
    expect(clampToolTimeoutMs(900_000)).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(clampToolTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TOOL_TIMEOUT_MS);
  });

  test("always returns a value the descriptor guard accepts", () => {
    for (const raw of [0, -1, 999, 1_000, 1_500.9, 60_000, 600_000, 900_000]) {
      expect(
        isToolDescriptor({
          name: "t",
          description: "d",
          timeout_ms: clampToolTimeoutMs(raw),
        }),
      ).toBe(true);
    }
  });
});

describe("tool groups", () => {
  test("isValidToolGroup accepts one or two name-pattern segments and nothing else", () => {
    expect(isValidToolGroup("checkout")).toBe(true);
    expect(isValidToolGroup("checkout/payment")).toBe(true);
    expect(isValidToolGroup(`${"a".repeat(64)}/${"b".repeat(64)}`)).toBe(true);

    for (const bad of [
      "",
      "/",
      "checkout/",
      "/payment",
      "a//b",
      "a/b/c",
      "a".repeat(65),
      `a/${"b".repeat(65)}`,
      "a b",
      "a.b",
      "a\n",
      "café",
    ]) {
      expect(isValidToolGroup(bad), JSON.stringify(bad)).toBe(false);
    }

    for (const nonString of [undefined, null, 42, ["a"], { group: "a" }]) {
      expect(isValidToolGroup(nonString)).toBe(false);
    }
  });

  test("isToolDescriptor rejects an invalid group and accepts a valid or omitted one", () => {
    expect(isToolDescriptor({ ...valid(), group: "checkout/payment" })).toBe(true);
    expect(isToolDescriptor(valid())).toBe(true);
    expect(isToolDescriptor({ ...valid(), group: "a/b/c" })).toBe(false);
    expect(isToolDescriptor({ ...valid(), group: null })).toBe(false);
  });

  test("the ToolDescriptor type rejects the null group that registration rejects", () => {
    // `ToolDescriptor` is what an app author writes against (`appduct/client`, the React Native
    // SDK's `getRegisteredTools`). A type that admits `group: null` promises a registration the
    // guard below — and the `group-null` conformance vector — throws out.
    // @ts-expect-error -- an ungrouped tool omits `group`; `null` is not a way to spell it.
    const registered: ToolDescriptor = { ...valid(), group: null };

    expect(isToolDescriptor(registered)).toBe(false);
  });

  test("toolGroupMatches matches by segment: a parent includes its subgroups, never a longer name", () => {
    expect(toolGroupMatches("checkout", "checkout")).toBe(true);
    expect(toolGroupMatches("checkout/payment", "checkout")).toBe(true);
    expect(toolGroupMatches("checkout/payment", "checkout/payment")).toBe(true);
    expect(toolGroupMatches("checkoutx", "checkout")).toBe(false);
    expect(toolGroupMatches("checkoutx/payment", "checkout")).toBe(false);
    expect(toolGroupMatches("checkout", "checkout/payment")).toBe(false);
    expect(toolGroupMatches("checkout/paymentx", "checkout/payment")).toBe(false);
    expect(toolGroupMatches("Checkout", "checkout")).toBe(false);
    expect(toolGroupMatches(undefined, "checkout")).toBe(false);
    // The `null` a `tools.list` entry carries for an ungrouped tool behaves like the `undefined` an
    // app registered with: it matches no group, so `--group` can never sweep in ungrouped tools.
    expect(toolGroupMatches(null, "checkout")).toBe(false);
    expect(toolGroupMatches(null, "")).toBe(false);
  });

  test("summarizeToolGroups treats a listing entry's null group like an omitted one", () => {
    // The daemon summarizes over `tools.list` entries, where an ungrouped tool's `group` is `null`
    // rather than absent. If only `undefined` counted, the summary's ungrouped row would vanish the
    // moment entries were normalised — silently, and only for the listing that made them so.
    const asRegistered = [{ group: "cart" }, {}, {}];
    const asListed = [{ group: "cart" }, { group: null }, { group: null }];

    expect(summarizeToolGroups(asListed)).toEqual(summarizeToolGroups(asRegistered));
    expect(summarizeToolGroups(asListed)).toEqual([
      { group: "cart", total: 1 },
      { group: null, total: 2 },
    ]);
  });

  test("summarizeToolGroups counts parents including subgroups, keeps a parent before its subgroups, null last", () => {
    const summary = summarizeToolGroups([
      { group: "checkout/payment" },
      {},
      { group: "checkout-x" },
      { group: "cart" },
      { group: "checkout" },
      { group: "checkout/payment" },
      { group: "checkout/address" },
      { group: "Zeta" },
      {},
    ]);

    expect(summary).toEqual([
      { group: "Zeta", total: 1 },
      { group: "cart", total: 1 },
      // `checkout/*` sorts right after `checkout`, even though "-" < "/" would put "checkout-x"
      // between them under a whole-path code-point comparison.
      { group: "checkout", total: 4 },
      { group: "checkout/address", total: 1 },
      { group: "checkout/payment", total: 2 },
      { group: "checkout-x", total: 1 },
      { group: null, total: 2 },
    ]);
  });

  test("summarizeToolGroups lists a parent that only has subgroup tools, and omits null with no ungrouped tools", () => {
    expect(summarizeToolGroups([{ group: "checkout/payment" }])).toEqual([
      { group: "checkout", total: 1 },
      { group: "checkout/payment", total: 1 },
    ]);
    expect(summarizeToolGroups([])).toEqual([]);
    expect(summarizeToolGroups([{}])).toEqual([{ group: null, total: 1 }]);
  });
});
