import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";

// `autolink-env.js` is a CommonJS helper at the package root, not a TS module under `src/` --
// see `metro.test.ts` for the same pattern with `metro.js`.
const require = createRequire(import.meta.url);

const autolinkEnv = require("../../autolink-env.js") as {
  isAppductAutolinkEnabled: (env?: NodeJS.ProcessEnv) => boolean;
  parseAppductEnabled: (env?: NodeJS.ProcessEnv) => "unset" | boolean;
  ENV_VAR: string;
};

const { isAppductAutolinkEnabled, parseAppductEnabled, ENV_VAR } =
  autolinkEnv;

describe("parseAppductEnabled", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test('unset -> "unset"', () => {
    delete process.env[ENV_VAR];
    expect(parseAppductEnabled()).toBe("unset");
  });

  test('empty string -> "unset"', () => {
    process.env[ENV_VAR] = "  ";
    expect(parseAppductEnabled()).toBe("unset");
  });

  test.each(["1", "true", "True"])("%s -> true", (value) => {
    process.env[ENV_VAR] = value;
    expect(parseAppductEnabled()).toBe(true);
  });

  test.each(["0", "false", "False"])("%s -> false", (value) => {
    process.env[ENV_VAR] = value;
    expect(parseAppductEnabled()).toBe(false);
  });

  test("unrecognized value throws, naming the offending value", () => {
    process.env[ENV_VAR] = "nope";
    expect(() => parseAppductEnabled()).toThrow(/"nope"/);
  });
});

describe("isAppductAutolinkEnabled", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test("unset -> true (present in at least the dev build)", () => {
    delete process.env[ENV_VAR];
    expect(isAppductAutolinkEnabled()).toBe(true);
  });

  test("truthy -> true", () => {
    process.env[ENV_VAR] = "1";
    expect(isAppductAutolinkEnabled()).toBe(true);
  });

  test("falsy -> false", () => {
    process.env[ENV_VAR] = "0";
    expect(isAppductAutolinkEnabled()).toBe(false);
  });
});
