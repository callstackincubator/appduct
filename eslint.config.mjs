// Lint for packages/appduct and packages/shared. It carries exactly the structural rules from
// AGENTS.md and nothing else: Prettier and TypeScript own style. The React Native package has
// its own config. See the `architecture` skill in .claude/skills for the reasoning.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tseslint from "typescript-eslint";

const root = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = ["packages/appduct/src", "packages/shared/src"];
const SOURCE = PACKAGES.map((p) => `${p}/**/*.ts`);
const TESTS = PACKAGES.map((p) => `${p}/__tests__/**/*.ts`);

// Rule 2, ports. Anything that reaches outside the process goes through a port whose real
// adapter is a file named node-<capability>.ts. Only those files and the composition roots
// below may import these modules. Tests may, for their own temp files and sockets.
const NODE_IO = ["fs", "fs/promises", "child_process", "net", "tls", "http", "https", "os", "dns"];

// The entry points that construct real adapters and hand them to everything else.
const COMPOSITION_ROOTS = [
  "packages/appduct/src/bin.ts",
  "packages/appduct/src/cli.ts",
  "packages/appduct/src/daemon/daemon.ts",
];

// Burn-down list: files that reached Node I/O directly before the ports rule existed. Remove
// a file from here when you convert it (port in the module, node-*.ts adapter beside it,
// in-memory fake for tests). Never add a file to this list. lint-boundaries.test.ts checks
// that every entry here still violates, so a converted file cannot be left behind.
export const LEGACY_NODE_IO = [
  "packages/appduct/src/artifact-inspect.ts",
  "packages/appduct/src/cli/open-target.ts",
  "packages/appduct/src/commands/init.ts",
  "packages/appduct/src/commands/keygen.ts",
  "packages/appduct/src/daemon/address.ts",
  "packages/appduct/src/daemon/audit.ts",
  "packages/appduct/src/daemon/config.ts",
  "packages/appduct/src/daemon/listener.ts",
  "packages/appduct/src/daemon/log-rotation.ts",
  "packages/appduct/src/daemon/pidfile.ts",
  "packages/appduct/src/daemon/rpc-server.ts",
  "packages/appduct/src/daemon/socket-probe.ts",
  "packages/appduct/src/daemon/state-dir.ts",
  "packages/appduct/src/daemon/tls.ts",
  "packages/appduct/src/key-material.ts",
  "packages/appduct/src/native-scheme.ts",
  "packages/appduct/src/package-root.ts",
  "packages/appduct/src/package-version.ts",
  "packages/appduct/src/rpc/client.ts",
  "packages/appduct/src/scheme.ts",
];

// Rule 4, tests observe public behaviour only. These three module-mocked before the ban; same
// deal as above: remove when converted, never add.
export const LEGACY_VI_MOCK = [
  "packages/appduct/src/__tests__/audit-retention.test.ts",
  "packages/appduct/src/__tests__/log-rotation.test.ts",
  "packages/appduct/src/__tests__/tools-command.test.ts",
];

// Tests that reached inside the client module before the boundary rule existed. Remove when
// converted to the module's index.ts (exporting what the test needs, if it belongs on the public
// API, or testing through it). Never add a file here.
export const LEGACY_MODULE_BOUNDARY = [
  "packages/appduct/src/__tests__/app-client.test.ts",
  "packages/appduct/src/__tests__/call-timeouts.test.ts",
  "packages/appduct/src/__tests__/link-open.integration.test.ts",
];

// Rule 1, modules. A module is a directory under a package's src that has an index.ts; that
// file is its only import surface. Modules are discovered at lint time, so a directory becomes
// one the moment it gains an index.ts and there is no list to keep in step.
const discoverModules = () => {
  const modules = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "__tests__" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (existsSync(path.join(full, "index.ts"))) modules.push(full);
      walk(full);
    }
  };
  for (const pkg of PACKAGES) walk(path.join(root, pkg));
  return modules;
};
const modules = discoverModules();
const inside = (file, dir) => file === dir || file.startsWith(dir + path.sep);

const PORT_MESSAGE =
  "Reach outside the process through a port: define the interface in the module, put the real adapter in a node-<capability>.ts file beside it, and construct it in a composition root. See the architecture skill.";
const MOCK_MESSAGE =
  "Tests observe public behaviour; a test that needs to mock I/O is telling you the code needs a port with an in-memory fake.";
const NODE_IO_NAMES = new Set(NODE_IO.flatMap((name) => [name, `node:${name}`]));

export const NODE_IO_RESTRICTION = ["error", { paths: [...NODE_IO_NAMES].map((name) => ({ name, message: PORT_MESSAGE })) }];
export const VI_MOCK_RESTRICTION = [
  "error",
  { object: "vi", property: "mock", message: MOCK_MESSAGE },
  { object: "vi", property: "doMock", message: MOCK_MESSAGE },
];

// no-restricted-imports never visits import() expressions, so the dynamic form of the same
// escape gets its own rule under the same exemptions.
const noNodeIoDynamicImport = {
  meta: { type: "problem", docs: { description: "no dynamic import() of Node I/O outside adapters" }, schema: [], messages: { port: PORT_MESSAGE } },
  create(context) {
    return {
      ImportExpression(node) {
        if (node.source.type === "Literal" && NODE_IO_NAMES.has(node.source.value)) context.report({ node, messageId: "port" });
      },
    };
  },
};

const moduleBoundary = {
  meta: {
    type: "problem",
    docs: { description: "import a module only through its index.ts" },
    schema: [],
    messages: {
      pastIndex: "'{{source}}' reaches inside the {{module}} module. Import from its index.ts, or move what you need onto the module's public API.",
    },
  },
  create(context) {
    const file = context.filename;
    const dir = path.dirname(file);
    const check = (node, source) => {
      if (typeof source !== "string" || !source.startsWith(".")) return;
      const target = path.resolve(dir, source).replace(/\.js$/, ".ts");
      for (const mod of modules) {
        if (inside(file, mod) || !inside(target, mod)) continue;
        if (target === mod || target === path.join(mod, "index.ts")) continue;
        context.report({ node, messageId: "pastIndex", data: { source, module: path.relative(root, mod) } });
      }
    };
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source?.value),
      ExportNamedDeclaration: (node) => check(node, node.source?.value),
      ImportExpression: (node) => check(node, node.source.value),
    };
  },
};

export default [
  { ignores: ["**/dist/**", "**/build/**", "**/node_modules/**"] },
  {
    files: SOURCE,
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2024, sourceType: "module" },
    plugins: { appduct: { rules: { "module-boundary": moduleBoundary, "no-node-io-dynamic-import": noNodeIoDynamicImport } } },
  },
  {
    files: SOURCE,
    ignores: LEGACY_MODULE_BOUNDARY,
    rules: { "appduct/module-boundary": "error" },
  },
  {
    files: SOURCE,
    ignores: ["**/__tests__/**", "**/node-*.ts", ...COMPOSITION_ROOTS, ...LEGACY_NODE_IO],
    rules: { "no-restricted-imports": NODE_IO_RESTRICTION, "appduct/no-node-io-dynamic-import": "error" },
  },
  {
    files: TESTS,
    ignores: LEGACY_VI_MOCK,
    rules: { "no-restricted-properties": VI_MOCK_RESTRICTION },
  },
];
