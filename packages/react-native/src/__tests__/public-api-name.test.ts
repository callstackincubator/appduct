/**
 * The name React Native users see for the type shared by the `.` (real) and `./noop` (inert)
 * entries (issue #155). It shipped as `CordierePublicApi`, the product's old name, misspelled; it
 * is now `AppductPublicApi`, with the old name kept as a deprecated alias until 0.16.0 removes it
 * (#161) so an existing import warns instead of breaking. When #161 runs, the three tests below that
 * name `CordierePublicApi` go: delete them with the alias.
 *
 * Which name resolves as a type is enforced by `tsc` (`pnpm typecheck` / `pnpm build`), not by
 * Vitest, which strips types — the pattern of `schema-inference.test.ts`, so each type-level test
 * keeps one runtime assertion to stay a real test. Whether the old name *carries* `@deprecated` is
 * not a type-level fact, so the tests that check it read it through the compiler API the way an
 * editor resolves it: on the exported symbol of each entry, through the export alias.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import type * as AutoEntry from "../auto";
import type * as RealEntry from "../index";
import type * as NoopEntry from "../noop";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** The entries an app can import the package by, i.e. everything that must name the type. */
const ENTRIES = ["index", "index.web", "noop", "auto"] as const;

/** The release that removes the alias (#161), as the `@deprecated` tag and `CHANGELOG.md` name it. */
const REMOVED_IN = "0.16.0";

const entryPath = (entry: string): string =>
  fileURLToPath(new URL(`../${entry}.ts`, import.meta.url));

/** The package's own `tsconfig` compiler options, so this sees what `pnpm typecheck` sees. */
const program = ts.createProgram(
  ENTRIES.map((entry) => entryPath(entry)),
  {
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  },
);

/**
 * JSDoc tags on the type `typeName` as an entry exports it, or `undefined` when that entry does not
 * export the name at all — so "not exported" cannot read as "exported without tags".
 */
const tagsOfExportedType = (
  entry: string,
  typeName: string,
): { name: string; message: string }[] | undefined => {
  const checker = program.getTypeChecker();
  const path = entryPath(entry);
  const sourceFile = program.getSourceFile(path);
  if (!sourceFile) throw new Error(`program does not include ${path}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`no module symbol for ${path}`);

  const exported = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.getName() === typeName);
  if (!exported) return undefined;

  const declaration =
    exported.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exported)
      : exported;
  return declaration.getJsDocTags(checker).map((tag) => ({
    name: tag.name,
    message: (tag.text ?? []).map((part) => part.text).join(""),
  }));
};

describe("public API type name (issue #155)", () => {
  test("every entry exports the type as AppductPublicApi", () => {
    // A name an entry does not export is a `tsc` error on the annotations below; the identity checks
    // are what keep `/auto`'s `export *` from being the only entry that happens to carry it.
    const sameTypeOnEveryEntry: Equals<
      RealEntry.AppductPublicApi,
      NoopEntry.AppductPublicApi
    > &
      Equals<AutoEntry.AppductPublicApi, RealEntry.AppductPublicApi> = true;
    // It is still the shared surface, not an empty type both entries satisfy by accident.
    const namesTheSharedSurface: "registerTool" extends keyof RealEntry.AppductPublicApi
      ? true
      : false = true;

    expect([sameTypeOnEveryEntry, namesTheSharedSurface]).toEqual([
      true,
      true,
    ]);
  });

  test("the old name stays available as an alias, not a copy that can drift", () => {
    // Grace until 0.16.0 (#161): `CordierePublicApi` keeps resolving, on every entry, to exactly the
    // renamed type rather than a second declaration someone can update on its own.
    const aliasIsTheRenamedType: Equals<
      RealEntry.CordierePublicApi,
      RealEntry.AppductPublicApi
    > &
      Equals<NoopEntry.CordierePublicApi, RealEntry.AppductPublicApi> &
      Equals<AutoEntry.CordierePublicApi, RealEntry.AppductPublicApi> = true;

    expect(aliasIsTheRenamedType).toBe(true);
  });

  test("the old name is marked deprecated on every entry, naming the new one and the release that removes it", () => {
    for (const entry of ENTRIES) {
      const tags = tagsOfExportedType(entry, "CordierePublicApi");
      expect(tags, `${entry} does not export CordierePublicApi`).toBeDefined();
      const deprecated = tags!.find((tag) => tag.name === "deprecated");
      expect(
        deprecated?.message,
        `${entry} does not mark CordierePublicApi @deprecated`,
      ).toContain("AppductPublicApi");
      expect(
        deprecated?.message,
        `${entry} does not say which release removes CordierePublicApi`,
      ).toContain(REMOVED_IN);
    }
  });

  test("the changelog names the same removal release as the deprecation does", () => {
    // The alias outlives this repo, so the promise is what a consumer reads. This is the one check
    // that the two places stating it cannot drift. Nothing here tries to stop the deletion itself:
    // that is #161's job, and the guarantee that matters there is its `Breaking:` changelog line,
    // which is what makes the removing release a minor bump instead of a patch that breaks apps.
    const changelog = readFileSync(
      fileURLToPath(new URL("../../../../CHANGELOG.md", import.meta.url)),
      "utf8",
    );
    const from = changelog.indexOf("## Unreleased");
    expect(from).toBeGreaterThan(-1);
    const unreleased = changelog.slice(from, changelog.indexOf("\n## ", from + 1));
    expect(unreleased).toContain("CordierePublicApi");
    expect(unreleased).toContain(REMOVED_IN);
  });

  test("the new name is exported without a deprecation warning", () => {
    for (const entry of ENTRIES) {
      const tags = tagsOfExportedType(entry, "AppductPublicApi");
      expect(tags, `${entry} does not export AppductPublicApi`).toBeDefined();
      expect(
        tags!.map((tag) => tag.name),
        `${entry} marks AppductPublicApi deprecated`,
      ).not.toContain("deprecated");
    }
  });
});
