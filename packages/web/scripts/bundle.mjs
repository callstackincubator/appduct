/**
 * Bundles `@appduct/web` with esbuild into `dist/enabled.js` (real) and `dist/inert.js` (production no-op): browser-ready ES modules with
 * `@appduct/shared` inlined, so a page or bundler imports it by name with no further resolution.
 * Types come from `tsc -p tsconfig.build.json` (declarations only).
 */

import { build } from "esbuild";

await build({
  entryPoints: ["src/enabled.ts", "src/inert.ts"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "info",
});
