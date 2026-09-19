/**
 * Bundles the package with esbuild: one self-contained file per entry point, no shared chunks.
 *
 * Why bundle at all: the CLI is spawned once per command, and on Node a startup is dominated by
 * per-file module resolution, not by code. The lazy router (`src/cli/router.ts`, ARCHITECTURE.md
 * §10 "Startup cost") already keeps each command from loading the others; bundling collapses the
 * files a command does need into as few as possible.
 *
 * Why no code splitting: esbuild's tree-shaking is per bundle, and a chunk shared by several
 * routes carries everything *any* of them uses from the modules in it (`invoke` would load the
 * daemon's RPC server because `daemon run` needs it). Making every route its own entry point
 * bundles each one alone, so each is tree-shaken alone and a command loads exactly two files of
 * ours: `dist/bin.js` and its route. The price is that the modules a route shares with the eager
 * entry (`errors`, `output`, `rpc/client`, …) are duplicated into every route bundle — a few tens
 * of kilobytes each, parsed in well under a millisecond — and that a route runs its own *copy* of
 * them: see `RouteContext` in `src/cli/router.ts` for the one rule that follows from that.
 *
 * Types are not produced here: `tsc -p tsconfig.build.json` emits the `.d.ts` files beside these
 * outputs (see the `build` script in package.json).
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { build } from "esbuild";

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const srcDir = join(packageRoot, "src");
const outDir = join(packageRoot, "dist");

const { dependencies } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));


/** The public entry points, at the paths package.json's `bin` and `exports` name. */
const publicEntries = ["src/bin.ts", "src/index.ts", "src/client/index.ts"];

/** Every route module: what the routers `import()` at runtime, each bundled on its own. */
const routesDir = join(srcDir, "cli", "routes");
const routeEntries = readdirSync(routesDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => relative(packageRoot, join(entry.parentPath ?? entry.path, entry.name)))
  .sort();

/** Where `file` (a source path) is emitted, given `outbase: src`. */
const outputPathOf = (file) => join(outDir, relative(srcDir, file)).replace(/\.ts$/, ".js");

/**
 * Keeps a router's `import("./routes/<name>.js")` a real runtime import — of the route's own
 * bundle — instead of letting esbuild inline the route into the importer. The path is rewritten
 * to be relative to where the *importer* is emitted: `src/cli/dispatch.ts` is bundled into the
 * public entries at the `dist` root, so its `./routes/x.js` becomes `./cli/routes/x.js`; a nested
 * router (`routes/daemon/index.ts`) is itself a route bundle whose siblings mirror `src`, so its
 * paths already hold.
 */
const lazyRoutesPlugin = {
  name: "lazy-routes",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
      if (args.kind !== "dynamic-import") {
        return undefined;
      }

      const target = resolve(args.resolveDir, args.path).replace(/\.js$/, ".ts");

      if (!target.startsWith(join(srcDir, "cli", "routes"))) {
        return undefined;
      }

      const importerIsPublicEntry = basename(args.importer) === "dispatch.ts";
      const importerOutputDir = importerIsPublicEntry ? outDir : dirname(outputPathOf(args.importer));
      let path = relative(importerOutputDir, outputPathOf(target)).split("\\").join("/");

      if (!path.startsWith(".")) {
        path = `./${path}`;
      }

      return { path, external: true };
    });
  },
};

await build({
  absWorkingDir: packageRoot,
  entryPoints: [...publicEntries, ...routeEntries],
  outdir: "dist",
  outbase: "src",
  entryNames: "[dir]/[name]",
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  // The daemon needs Node ≥ 20 (ARCHITECTURE.md §13); the bundle targets the same floor.
  target: "node20",
  // Every dependency (`ws`, `cac`, the MCP SDK, …) stays an ordinary import resolved from
  // node_modules at runtime; `external` names them by package so a sub-path import such as
  // `@modelcontextprotocol/sdk/server/index.js` is covered too. That includes `@appduct/shared`:
  // inlining it would copy it into every one of these bundles, whereas as an external it is one
  // module instance shared by all of them — and it ships as a single file (its own build bundles
  // it), so it costs one resolution, not one per source file.
  external: Object.keys(dependencies).flatMap((name) => [name, `${name}/*`]),
  plugins: [lazyRoutesPlugin],
  logLevel: "info",
});
