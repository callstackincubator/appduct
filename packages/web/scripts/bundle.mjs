/**
 * Bundles `@appduct/web` with esbuild into `dist/index.js`: one browser-ready ES module with
 * `@appduct/shared` inlined, so a page or bundler imports it by name with no further resolution.
 * Types come from `tsc -p tsconfig.build.json` (declarations only).
 */

import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "info",
});
