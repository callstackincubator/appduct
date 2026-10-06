import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Observes the built package (`pnpm build` first). A release build swaps `./noop` in for the real
 * entry (ARCHITECTURE.md §11), so everything `./noop` imports, transitively, ships. None of it
 * may be client code.
 */
const here = dirname(fileURLToPath(import.meta.url));
const noopEntry = resolve(here, "../../build/noop.js");
const sharedRoot = resolve(here, "../../../shared");
const sharedManifest = JSON.parse(readFileSync(resolve(sharedRoot, "package.json"), "utf8")) as {
  exports: Record<string, { import: string }>;
};

const specifiersOf = (source: string) =>
  [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]!);

const resolveFile = (from: string, specifier: string): string | undefined => {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(from), specifier);
    return [base, `${base}.js`, resolve(base, "index.js")].find((f) => f.endsWith(".js") && existsSync(f));
  }
  if (specifier.startsWith("@appduct/shared")) {
    const subpath = "." + specifier.slice("@appduct/shared".length);
    const target = sharedManifest.exports[subpath]?.import;
    return target ? resolve(sharedRoot, target) : undefined;
  }
  return undefined;
};

const noopGraph = () => {
  const seen = new Map<string, string>();
  const queue = [noopEntry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    for (const specifier of specifiersOf(source)) {
      const next = resolveFile(file, specifier);
      if (next) queue.push(next);
    }
  }
  return seen;
};

describe("the ./noop entry's import graph", () => {
  test("reaches the shared package but never its SDK client", () => {
    const files = [...noopGraph().keys()];
    expect(files.some((f) => f.startsWith(sharedRoot))).toBe(true);
    expect(files.filter((f) => f.endsWith("/dist/sdk.js"))).toEqual([]);
  });

  test("contains no client code", () => {
    const graph = [...noopGraph().values()].join("\n");
    for (const client of ["createAppductClient", "exportToolSchemaForKey", "createAppduct(", "client.js"]) {
      expect(graph).not.toContain(client);
    }
  });
});
