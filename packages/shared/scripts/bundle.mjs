/**
 * Bundles `@appduct/shared` with esbuild into one file per entry: `dist/index.js` (the wire
 * protocol), `dist/sdk.js` (the TypeScript SDK layer), `dist/inert.js` (the few values the inert noop entry needs, free of client code) and `dist/react.js` (the React hook, with
 * `react` left external). The package has no runtime dependencies, so each bundle is simply its
 * sources concatenated: consumers pay one module resolution per entry instead of one per source
 * file. The entries share no chunks, so the CLI, which loads only the root bundle, never loads the
 * SDK or React code. Types come from `tsc -p tsconfig.build.json` (declarations only).
 */

import { build } from "esbuild";

const entries = { index: "src/index.ts", sdk: "src/sdk/index.ts", react: "src/react/index.ts", inert: "src/inert/index.ts" };

for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}.js`,
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["react"],
    // Consumed by Node ≥ 20 (`appduct`) and by Metro (`@appduct/react-native`): ES2022 syntax, no
    // platform APIs assumed.
    target: "es2022",
    logLevel: "info",
  });
}
