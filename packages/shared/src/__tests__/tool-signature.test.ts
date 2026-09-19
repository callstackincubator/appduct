import { describe, expect, test } from "vitest";

import { renderToolSignature } from "../domains/tool-signature.js";

type Case = [label: string, descriptor: Parameters<typeof renderToolSignature>[0], expected: string];

const cases: Case[] = [
  ["no input/output schema at all", { name: "ping" }, "ping(...)"],
  [
    "input_schema not rooted at type: object",
    { name: "echo", input_schema: { type: "string" } },
    "echo(...)",
  ],
  [
    "object schema, no properties key, additionalProperties: false -> no-args",
    { name: "ping", input_schema: { type: "object", additionalProperties: false } },
    "ping()",
  ],
  [
    "object schema, no properties key, additionalProperties not false -> unresolved",
    { name: "ping", input_schema: { type: "object" } },
    "ping(...)",
  ],
  [
    "object schema, empty properties object -> explicit no-args",
    { name: "ping", input_schema: { type: "object", properties: {} } },
    "ping()",
  ],
  [
    "required and optional params, declared order preserved",
    {
      name: "seed_cart",
      input_schema: {
        type: "object",
        properties: { items: { type: "integer" }, sku: { type: "string" } },
        required: ["items"],
      },
    },
    "seed_cart(items: int, sku?: string)",
  ],
  [
    "optional param with a short default",
    {
      name: "seed_cart",
      input_schema: {
        type: "object",
        properties: { clear: { type: "boolean", default: true } },
      },
    },
    "seed_cart(clear?: bool = true)",
  ],
  [
    "default omitted when its JSON rendering exceeds 20 characters",
    {
      name: "configure",
      input_schema: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" }, default: ["a", "b", "c", "d", "e"] } },
      },
    },
    "configure(tags?: string[])",
  ],
  [
    "primitive type names: string/number/boolean/integer/null",
    {
      name: "types",
      input_schema: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "number" },
          c: { type: "boolean" },
          d: { type: "integer" },
          e: { type: "null" },
        },
        required: ["a", "b", "c", "d", "e"],
      },
    },
    "types(a: string, b: number, c: bool, d: int, e: null)",
  ],
  [
    "type given as an array joins members with ' | '",
    {
      name: "set_value",
      input_schema: {
        type: "object",
        properties: { value: { type: ["string", "null"] } },
        required: ["value"],
      },
    },
    "set_value(value: string | null)",
  ],
  [
    "enum renders JSON values joined with ' | '",
    {
      name: "set_flag",
      input_schema: {
        type: "object",
        properties: { name: { enum: ["dark_mode", "new_checkout"] } },
        required: ["name"],
      },
    },
    'set_flag(name: "dark_mode" | "new_checkout")',
  ],
  [
    "enum longer than 5 values truncates with ' | …'",
    {
      name: "pick",
      input_schema: {
        type: "object",
        properties: { n: { enum: [1, 2, 3, 4, 5, 6] } },
        required: ["n"],
      },
    },
    "pick(n: 1 | 2 | 3 | 4 | 5 | …)",
  ],
  [
    "enum with exactly 5 values shows no ellipsis",
    {
      name: "pick",
      input_schema: {
        type: "object",
        properties: { n: { enum: [1, 2, 3, 4, 5] } },
        required: ["n"],
      },
    },
    "pick(n: 1 | 2 | 3 | 4 | 5)",
  ],
  [
    "const renders its JSON value",
    {
      name: "set_mode",
      input_schema: {
        type: "object",
        properties: { mode: { const: "strict" } },
        required: ["mode"],
      },
    },
    'set_mode(mode: "strict")',
  ],
  [
    "array of primitives",
    {
      name: "tag",
      input_schema: {
        type: "object",
        properties: { labels: { type: "array", items: { type: "string" } } },
      },
    },
    "tag(labels?: string[])",
  ],
  [
    "array with missing items -> unknown[]",
    {
      name: "tag",
      input_schema: { type: "object", properties: { labels: { type: "array" } } },
    },
    "tag(labels?: unknown[])",
  ],
  [
    "array with a non-object-schema items (hostile) -> unknown[]",
    {
      name: "tag",
      input_schema: { type: "object", properties: { labels: { type: "array", items: 3 } } },
    },
    "tag(labels?: unknown[])",
  ],
  [
    "object property expands one level",
    {
      name: "set_address",
      input_schema: {
        type: "object",
        properties: {
          address: {
            type: "object",
            properties: { city: { type: "string" }, zip: { type: "string" } },
            required: ["city"],
          },
        },
        required: ["address"],
      },
    },
    "set_address(address: { city: string, zip?: string })",
  ],
  [
    "object nested two levels deep renders the inner object as {...}",
    {
      name: "set_address",
      input_schema: {
        type: "object",
        properties: {
          address: {
            type: "object",
            properties: {
              city: { type: "string" },
              geo: { type: "object", properties: { lat: { type: "number" } } },
            },
            required: ["city"],
          },
        },
        required: ["address"],
      },
    },
    "set_address(address: { city: string, geo?: {...} })",
  ],
  [
    "anyOf/oneOf/allOf/not/$ref all render as ...",
    {
      name: "poly",
      input_schema: {
        type: "object",
        properties: {
          a: { anyOf: [{ type: "string" }, { type: "number" }] },
          b: { oneOf: [{ type: "string" }] },
          c: { allOf: [{ type: "string" }] },
          d: { not: { type: "string" } },
          e: { $ref: "#/definitions/Thing" },
        },
      },
    },
    "poly(a?: ..., b?: ..., c?: ..., d?: ..., e?: ...)",
  ],
  [
    "output schema omitted -> no arrow",
    { name: "ping", input_schema: { type: "object", properties: {} } },
    "ping()",
  ],
  [
    "output schema object root inlines one level",
    {
      name: "seed_cart",
      input_schema: { type: "object", properties: {} },
      output_schema: {
        type: "object",
        properties: { added: { type: "integer" }, cartId: { type: "string" } },
        required: ["added", "cartId"],
      },
    },
    "seed_cart() -> { added: int, cartId: string }",
  ],
  [
    "output schema non-object root renders as its own type",
    {
      name: "list_tags",
      input_schema: { type: "object", properties: {} },
      output_schema: { type: "array", items: { type: "string" } },
    },
    "list_tags() -> string[]",
  ],
  [
    "output schema unrecognised (composed) -> -> ...",
    {
      name: "weird",
      input_schema: { type: "object", properties: {} },
      output_schema: { anyOf: [{ type: "string" }] },
    },
    "weird() -> ...",
  ],
  [
    "output schema that is not an object at all -> -> ...",
    {
      name: "weird",
      input_schema: { type: "object", properties: {} },
      output_schema: null as unknown as Record<string, unknown>,
    },
    "weird() -> ...",
  ],

  // --- hostile inputs: schema internals are never validated elsewhere, so nothing here may throw ---
  [
    "hostile: properties: null on the root falls back to the additionalProperties rule",
    { name: "ping", input_schema: { type: "object", properties: null } },
    "ping(...)",
  ],
  [
    "hostile: properties: null with additionalProperties: false -> no-args",
    { name: "ping", input_schema: { type: "object", properties: null, additionalProperties: false } },
    "ping()",
  ],
  [
    "hostile: required is a string, not an array -> nothing is treated as required",
    {
      name: "greet",
      input_schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: "name",
      },
    },
    "greet(name?: string)",
  ],
  [
    "hostile: enum is an object, not an array -> falls through to type rendering",
    {
      name: "pick",
      input_schema: {
        type: "object",
        properties: { n: { type: "string", enum: { not: "an array" } } },
      },
    },
    "pick(n?: string)",
  ],
  [
    "hostile: input_schema itself is not an object",
    { name: "ping", input_schema: "not a schema" as unknown as Record<string, unknown> },
    "ping(...)",
  ],
  [
    "hostile: a property schema that is not an object renders as ...",
    { name: "ping", input_schema: { type: "object", properties: { a: 3 } } },
    "ping(a?: ...)",
  ],
  [
    "hostile: deep nesting beyond one level never expands, however many levels down",
    {
      name: "deep",
      input_schema: {
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: {
                type: "object",
                properties: { c: { type: "object", properties: { d: { type: "string" } } } },
              },
            },
          },
        },
      },
    },
    "deep(a?: { b?: {...} })",
  ],
];

describe("renderToolSignature", () => {
  test.each(cases)("%s", (_label, descriptor, expected) => {
    expect(renderToolSignature(descriptor)).toBe(expected);
  });

  test("never throws on a completely empty object", () => {
    expect(() => renderToolSignature({ name: "x" })).not.toThrow();
  });
});
