/**
 * Bundles `@appduct/web` with esbuild into `dist/enabled.js` (real) and `dist/inert.js` (production no-op): browser-ready ES modules with
 * `@appduct/shared` inlined, so a page or bundler imports it by name with no further resolution.
 * `dist/react.js` is the `./react` entry; it imports the package-internal `#appduct-web`
 * (the same conditions as the root export) rather than inlining a copy, so the hook follows whichever entry the consumer's export
 * conditions pick and shares one session with the plain API. Types come from
 * `tsc -p tsconfig.build.json` (declarations only).
 */

import { build } from "esbuild";

const common = { bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "info" };

await build({ ...common, entryPoints: ["src/enabled.ts", "src/inert.ts"], outdir: "dist" });

await build({
  ...common,
  entryPoints: ["src/react/index.ts"],
  outfile: "dist/react.js",
  external: ["react"],
  plugins: [
    {
      name: "share-the-web-entry",
      setup(b) {
        b.onResolve({ filter: /^\.\.\/index\.js$/ }, () => ({ path: "#appduct-web", external: true }));
      },
    },
  ],
});
