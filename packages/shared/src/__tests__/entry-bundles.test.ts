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
    expect(Object.keys(manifest.exports)).toEqual(expect.arrayContaining([".", "./sdk", "./react", "./inert"]));
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

  test("the inert bundle carries the runtime values the noop entry needs and no client code", async () => {
    const inert = (await import(dist("inert.js"))) as Record<string, unknown>;
    expect(Object.keys(inert).sort()).toEqual([
      "APPDUCT_DEFAULT_TOOL_TIMEOUT_MS",
      "AppductBootstrapParseError",
      "AppductDisabledError",
      "createToolGroupFactory",
      "jsonSchema",
    ]);
    const source = read("inert.js");
    for (const client of ["createAppductClient", "exportToolSchemaForKey", "createAppduct"]) {
      expect(source).not.toContain(client);
    }
  });

  test("the sdk entry still exports the values the inert entry carries", async () => {
    const sdk = (await import(dist("sdk.js"))) as Record<string, unknown>;
    for (const name of ["APPDUCT_DEFAULT_TOOL_TIMEOUT_MS", "AppductBootstrapParseError", "AppductDisabledError", "createToolGroupFactory", "jsonSchema"]) {
      expect(sdk[name]).toBeDefined();
    }
  });

  test("maps every subpath to its declarations for moduleResolution node", () => {
    const withTypesVersions = manifest as unknown as { typesVersions?: Record<string, Record<string, string[]>> };
    expect(withTypesVersions.typesVersions?.["*"]).toEqual({
      sdk: ["dist/sdk/index.d.ts"],
      react: ["dist/react/index.d.ts"],
      inert: ["dist/inert/index.d.ts"],
    });
  });
});
