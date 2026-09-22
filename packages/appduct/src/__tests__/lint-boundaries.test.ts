/**
 * The architecture rules in AGENTS.md are enforced by the root ESLint config. These tests lint
 * small snippets under hypothetical paths, so they pin the rules themselves rather than the
 * current state of the tree: a module's index.ts is its only import surface, Node I/O is reached
 * only from adapters and composition roots, and tests never module-mock.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const eslint = new ESLint({ cwd: repoRoot });

const lint = async (relativePath: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, relativePath) });
  return result.messages.map((message) => message.ruleId);
};

describe("lint: ports", () => {
  test("a new file reaching Node I/O directly fails", async () => {
    const rules = await lint("packages/appduct/src/daemon/probe-new.ts", 'import { readFile } from "node:fs/promises";\nexport const read = readFile;\n');
    expect(rules).toContain("no-restricted-imports");
  });

  test("an adapter file named node-<capability>.ts may reach Node I/O", async () => {
    const rules = await lint("packages/appduct/src/daemon/node-filesystem.ts", 'import { readFile } from "node:fs/promises";\nexport const read = readFile;\n');
    expect(rules).toEqual([]);
  });

  test("a composition root may reach Node I/O", async () => {
    const rules = await lint("packages/appduct/src/daemon/daemon.ts", 'import { readFile } from "node:fs/promises";\nexport const read = readFile;\n');
    expect(rules).toEqual([]);
  });

  test("a file on the burn-down list still passes until it is converted", async () => {
    const rules = await lint("packages/appduct/src/scheme.ts", 'import { readFile } from "node:fs/promises";\nexport const read = readFile;\n');
    expect(rules).toEqual([]);
  });

  test("the same rule holds in @appduct/shared", async () => {
    const rules = await lint("packages/shared/src/domains/probe-new.ts", 'import { platform } from "node:os";\nexport const p = platform;\n');
    expect(rules).toContain("no-restricted-imports");
  });
});

describe("lint: module boundaries", () => {
  test("importing past a module's index.ts from outside fails", async () => {
    const rules = await lint("packages/appduct/src/mcp/probe.ts", 'import { AppClient } from "../client/app-client.js";\nexport const c = AppClient;\n');
    expect(rules).toContain("appduct/module-boundary");
  });

  test("importing a module's index.ts from outside passes", async () => {
    const rules = await lint("packages/appduct/src/mcp/probe.ts", 'import { AppClient } from "../client/index.js";\nexport const c = AppClient;\n');
    expect(rules).toEqual([]);
  });

  test("a module's own files may import each other", async () => {
    const rules = await lint("packages/appduct/src/client/probe.ts", 'import { AppClient } from "./app-client.js";\nexport const c = AppClient;\n');
    expect(rules).toEqual([]);
  });

  test("a directory without an index.ts is not a module yet, so its files are importable", async () => {
    const rules = await lint("packages/appduct/src/mcp/probe.ts", 'import { createEventBus } from "../daemon/event-bus.js";\nexport const b = createEventBus;\n');
    expect(rules).toEqual([]);
  });
});

describe("lint: tests", () => {
  test("vi.mock in a new test fails", async () => {
    const rules = await lint("packages/appduct/src/__tests__/probe.test.ts", 'import { vi } from "vitest";\nvi.mock("node:fs/promises");\n');
    expect(rules).toContain("no-restricted-properties");
  });

  test("a test may reach Node I/O for its own temp files", async () => {
    const rules = await lint("packages/appduct/src/__tests__/probe.test.ts", 'import { mkdtemp } from "node:fs/promises";\nexport const t = mkdtemp;\n');
    expect(rules).toEqual([]);
  });
});
