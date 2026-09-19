/**
 * Bundles `@appduct/shared` into a single `dist/index.js` with esbuild. The package has no runtime
 * dependencies and one entry point, so the bundle is simply its sources concatenated: consumers
 * that load it at startup — every `appduct` CLI command does — pay one module resolution instead of
 * one per source file. Types come from `tsc -p tsconfig.build.json` (declarations only).
 */

import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  // Consumed by Node ≥ 20 (`appduct`) and by Metro (`@appduct/react-native`): ES2022 syntax, no
  // platform APIs assumed.
  target: "es2022",
  logLevel: "info",
});
