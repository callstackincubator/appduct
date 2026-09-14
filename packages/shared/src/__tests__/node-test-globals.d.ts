// @cordierite/shared is deliberately Node-API-free in its production sources (see
// domains/bootstrap.ts's base64url helpers, which use atob/btoa instead of Buffer for exactly
// this reason), so the package has no @types/node dependency. fixtures-conformance.test.ts is the
// one test file that needs to read a fixture JSON file from disk and resolve its own path — both
// only at test time, under vitest/Node — so this ambient declaration file (test-scoped, not
// shipped: excluded from tsconfig.build.json's "src/**/__tests__/**") gives `tsc -p tsconfig.json`
// (the typecheck task, which does include test files) just enough of `node:fs`/`node:url` to
// resolve those two imports without adding a real dependency.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
