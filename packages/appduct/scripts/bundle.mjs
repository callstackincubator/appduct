/**
 * Bundles the package's three entry points (`bin`, `.`, `./client`) into `dist/` with esbuild.
 *
 * Why bundle at all: the CLI is spawned once per command, and on Node a startup is dominated by
 * per-file module resolution, not by code. The lazy router (`src/cli/router.ts`, ARCHITECTURE.md
 * §10 "Startup cost") already keeps each command from loading the others; bundling collapses the
 * ~50 files every command still shares into one chunk. Code splitting keeps each route's dynamic
 * `import()` a separate chunk, so the router's laziness survives the bundle.
 *
 * Types are not produced here: `tsc -p tsconfig.build.json` emits the `.d.ts` files beside these
 * outputs (see the `build` script in package.json).
 */

import { readFileSync } from "node:fs";

import { build } from "esbuild";

const { dependencies } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/**
 * `@appduct/shared` is inlined: it is pure functions, constants and types with no runtime
 * dependencies and no classes whose identity could matter across the package boundary, and as a
 * dozen separate files it would otherwise be the largest remaining per-file cost on every command's
 * startup. It stays a declared dependency for the types the `.d.ts` files reference.
 */
const INLINED = new Set(["@appduct/shared"]);

await build({
  entryPoints: ["src/bin.ts", "src/index.ts", "src/client/index.ts"],
  outdir: "dist",
  outbase: "src",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  // The daemon needs Node ≥ 20 (ARCHITECTURE.md §13); the bundle targets the same floor.
  target: "node20",
  // Every other dependency (`ws`, `cac`, the MCP SDK, …) stays an ordinary import resolved from
  // node_modules at runtime; `external` names them by package so a sub-path import such as
  // `@modelcontextprotocol/sdk/server/index.js` is covered too.
  external: Object.keys(dependencies)
    .filter((name) => !INLINED.has(name))
    .flatMap((name) => [name, `${name}/*`]),
  // Entries keep their `src`-relative paths so package.json's `exports` stay valid; shared chunks
  // land beside them at the `dist` root.
  entryNames: "[dir]/[name]",
  chunkNames: "[name]-[hash]",
  logLevel: "info",
});
