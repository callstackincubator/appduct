import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Observes the built package (`pnpm build` first): the root bundle is what the CLI loads at
 * startup, so the SDK and React layers must live in their own entries.
 */
const dist = (name: string) => fileURLToPath(new URL(`../../dist/${name}`, import.meta.url));
const read = (name: string) => readFileSync(dist(name), "utf8");
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as {
  exports: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

describe("@appduct/shared entries", () => {
  test("the root bundle contains none of the SDK or React code", () => {
    const root = read("index.js");
    for (const moved of ["createAppduct", "createAppductClient", "toToolDescriptor", "createUseAppductTool"]) {
      expect(root).not.toContain(moved);
    }
  });

  test("exports ./sdk and ./react as their own entries", () => {
    expect(Object.keys(manifest.exports)).toEqual(expect.arrayContaining([".", "./sdk", "./react"]));
  });

  test("the sdk bundle never imports react", () => {
    expect(read("sdk.js")).not.toMatch(/from\s*["']react["']/);
  });

  test("the sdk bundle loads when react is not installed", async () => {
    const sdk = (await import(dist("sdk.js"))) as { createAppduct: unknown };
    expect(typeof sdk.createAppduct).toBe("function");
  });

  test("the react bundle imports react and leaves it external", () => {
    expect(read("react.js")).toMatch(/from\s*["']react["']/);
  });

  test("react is an optional peer dependency", () => {
    expect(manifest.peerDependencies?.react).toBeDefined();
    expect(manifest.peerDependenciesMeta?.react?.optional).toBe(true);
  });
});
