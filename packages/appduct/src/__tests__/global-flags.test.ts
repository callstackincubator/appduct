/**
 * `cli/global-flags.ts`: the declarative global-flags table. Checks that `resolveGlobalFlags`
 * (the `cac`-options path) and `resolveGlobalFlagsFromArgv` (the parse-failure fallback path)
 * agree for every flag, and that `formatJson` picks compact vs. indented correctly.
 */

import { describe, expect, test } from "vitest";

import {
  formatJson,
  resolveGlobalFlags,
  resolveGlobalFlagsFromArgv,
  type GlobalFlags,
} from "../cli/global-flags.js";

type Case = {
  name: string;
  argv: string[];
  options: Record<string, unknown>;
  expected: GlobalFlags;
};

const cases: Case[] = [
  {
    name: "defaults when nothing is passed",
    argv: [],
    options: {},
    expected: { json: false, pretty: false, verbose: false, color: true },
  },
  {
    name: "--json",
    argv: ["ls", "--json"],
    options: { json: true },
    expected: { json: true, pretty: false, verbose: false, color: true },
  },
  {
    name: "--pretty",
    argv: ["ls", "--pretty"],
    options: { pretty: true },
    expected: { json: false, pretty: true, verbose: false, color: true },
  },
  {
    name: "--verbose",
    argv: ["ls", "--verbose"],
    options: { verbose: true },
    expected: { json: false, pretty: false, verbose: true, color: true },
  },
  {
    name: "--no-color",
    argv: ["ls", "--no-color"],
    options: { color: false },
    expected: { json: false, pretty: false, verbose: false, color: false },
  },
  {
    name: "every flag combined",
    argv: ["ls", "--json", "--pretty", "--verbose", "--no-color"],
    options: { json: true, pretty: true, verbose: true, color: false },
    expected: { json: true, pretty: true, verbose: true, color: false },
  },
];

describe("resolveGlobalFlags / resolveGlobalFlagsFromArgv", () => {
  for (const { name, argv, options, expected } of cases) {
    test(`${name}: both resolution paths agree`, () => {
      expect(resolveGlobalFlags(options)).toEqual(expected);
      expect(resolveGlobalFlagsFromArgv(argv)).toEqual(expected);
    });
  }

  test("an option cac never set (undefined) reads as its default, not as truthy", () => {
    expect(resolveGlobalFlags({})).toEqual({ json: false, pretty: false, verbose: false, color: true });
  });
});

describe("formatJson", () => {
  const value = { a: 1, b: { c: [1, 2] } };

  test("compact by default", () => {
    expect(formatJson(value, { pretty: false })).toBe(JSON.stringify(value));
    expect(formatJson(value, { pretty: false })).not.toContain("\n");
  });

  test("indented under --pretty", () => {
    expect(formatJson(value, { pretty: true })).toBe(JSON.stringify(value, null, 2));
    expect(formatJson(value, { pretty: true })).toContain("\n");
  });
});
