/**
 * The architecture rules in AGENTS.md are enforced by the root ESLint config. These tests lint
 * small snippets under hypothetical paths, so they pin the rules themselves rather than the
 * current state of the tree: a module's index.ts is its only import surface, Node I/O is reached
 * only from adapters and composition roots, and tests never module-mock.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ESLint, type Linter } from "eslint";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const eslint = new ESLint({ cwd: repoRoot });

const lint = async (relativePath: string, code: string) => {
  const results = await eslint.lintText(code, { filePath: path.join(repoRoot, relativePath) });
  return (results[0]?.messages ?? []).map((message) => message.ruleId);
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

  test("a dynamic import() of Node I/O fails too", async () => {
    const rules = await lint("packages/appduct/src/daemon/probe-new.ts", 'export const read = async (p: string) => (await import("node:fs/promises")).readFile(p, "utf8");\n');
    expect(rules).toContain("appduct/no-node-io-dynamic-import");
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

  test("a directory without an index.ts is not a module, so its files are importable", async () => {
    // Discovery only lists directories that exist and have an index.ts, so a path that never
    // will is the one that cannot turn this test stale.
    const rules = await lint("packages/appduct/src/mcp/probe.ts", 'import { thing } from "../no-such-dir/thing.js";\nexport const t = thing;\n');
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

/**
 * The burn-down lists exempt files that predate the rules. Each entry must still be a genuine
 * violator: a file converted to a port but left on the list would silently re-admit the exact
 * regression it was converted to remove. Linting each listed file with its exemption removed
 * must therefore be red, and a file that no longer exists fails here rather than lingering.
 */
describe("lint: burn-down lists", () => {
  type Config = {
    LEGACY_NODE_IO: string[];
    LEGACY_VI_MOCK: string[];
    LEGACY_MODULE_BOUNDARY: string[];
    NODE_IO_RESTRICTION: Linter.RuleEntry;
    VI_MOCK_RESTRICTION: Linter.RuleEntry;
  };
  const loadConfig = async (): Promise<Config> => import(pathToFileURL(path.join(repoRoot, "eslint.config.mjs")).href);

  const violators = async (files: string[], rules: Linter.RulesRecord, expectedRule: string) => {
    const withoutExemption = new ESLint({ cwd: repoRoot, overrideConfig: [{ files, rules }] });
    const results = await withoutExemption.lintFiles(files);
    return results.filter((r) => r.messages.some((m) => m.ruleId === expectedRule)).map((r) => path.relative(repoRoot, r.filePath));
  };

  test("every LEGACY_NODE_IO entry still reaches Node I/O directly", async () => {
    const { LEGACY_NODE_IO, NODE_IO_RESTRICTION } = await loadConfig();
    expect(LEGACY_NODE_IO.length).toBeGreaterThan(0);
    expect(await violators(LEGACY_NODE_IO, { "no-restricted-imports": NODE_IO_RESTRICTION }, "no-restricted-imports")).toEqual(LEGACY_NODE_IO);
  });

  test("every LEGACY_VI_MOCK entry still module-mocks", async () => {
    const { LEGACY_VI_MOCK, VI_MOCK_RESTRICTION } = await loadConfig();
    expect(await violators(LEGACY_VI_MOCK, { "no-restricted-properties": VI_MOCK_RESTRICTION }, "no-restricted-properties")).toEqual(LEGACY_VI_MOCK);
  });

  test("every LEGACY_MODULE_BOUNDARY entry still reaches inside a module", async () => {
    const { LEGACY_MODULE_BOUNDARY } = await loadConfig();
    expect(await violators(LEGACY_MODULE_BOUNDARY, { "appduct/module-boundary": "error" }, "appduct/module-boundary")).toEqual(LEGACY_MODULE_BOUNDARY);
  });
});
