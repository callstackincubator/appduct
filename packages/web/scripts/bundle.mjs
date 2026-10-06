/**
 * Bundles `@appduct/web` with esbuild: `dist/index.js` is one browser-ready ES module with
 * `@appduct/shared` inlined, so a page or bundler imports it by name with no further resolution.
 * `dist/react.js` is the `./react` entry; it imports `@appduct/web` rather than inlining a second
 * copy, so the hook and the plain API share one session. Types come from
 * `tsc -p tsconfig.build.json` (declarations only).
 */

import { build } from "esbuild";

const common = { bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "info" };

await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });

await build({
  ...common,
  entryPoints: ["src/react/index.ts"],
  outfile: "dist/react.js",
  external: ["react"],
  plugins: [
    {
      name: "share-the-web-entry",
      setup(b) {
        b.onResolve({ filter: /^\.\.\/index\.js$/ }, () => ({ path: "@appduct/web", external: true }));
      },
    },
  ],
});
