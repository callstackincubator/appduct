import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const script = join(repoRoot, "scripts", "release-version.mjs");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Versions = { npm?: string; flutter?: string };

/** A repo layout with the three npm packages at `npm` and the Flutter package at `flutter`. */
function fixture({ npm = "0.15.0", flutter = "0.15.0" }: Versions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "release-version-"));
  roots.push(root);
  for (const name of ["shared", "appduct", "react-native"]) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(
      join(root, "packages", name, "package.json"),
      JSON.stringify({ name, version: npm }),
    );
  }
  mkdirSync(join(root, "packages", "flutter"), { recursive: true });
  writeFileSync(
    join(root, "packages", "flutter", "pubspec.yaml"),
    `name: appduct\nversion: ${flutter}\npublish_to: none\n`,
  );
  return root;
}

function run(root: string, ...args: string[]) {
  const result = spawnSync("node", [script, "--root", root, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("release version check", () => {
  it("prints the version when the npm packages and the Flutter package agree", () => {
    expect(run(fixture())).toMatchObject({ code: 0, out: "0.15.0" });
  });

  it("rejects a Flutter package whose version differs from the npm packages", () => {
    const result = run(fixture({ flutter: "0.14.0" }));
    expect(result.code).toBe(1);
    expect(result.err).toContain("packages/flutter/pubspec.yaml");
    expect(result.err).toContain("0.14.0");
  });

  it("rejects npm packages whose versions differ", () => {
    const root = fixture();
    writeFileSync(
      join(root, "packages", "shared", "package.json"),
      JSON.stringify({ version: "0.14.0" }),
    );
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.err).toContain("differ");
  });

  it("rejects a prerelease version", () => {
    const result = run(fixture({ npm: "0.15.0-rc.1", flutter: "0.15.0-rc.1" }));
    expect(result.code).toBe(1);
    expect(result.err).toContain("Prerelease");
  });

  it("accepts a release tag that is v plus the version", () => {
    expect(run(fixture(), "--tag", "v0.15.0").code).toBe(0);
  });

  it("rejects a release tag that does not match the version", () => {
    const result = run(fixture(), "--tag", "v0.16.0");
    expect(result.code).toBe(1);
    expect(result.err).toContain("v0.16.0");
  });

  it("reads a pubspec version with a build suffix as a different version", () => {
    const result = run(fixture({ flutter: "0.15.0+1" }));
    expect(result.code).toBe(1);
    expect(result.err).toContain("differ");
  });

  it("holds for this repository", () => {
    expect(run(repoRoot).code).toBe(0);
  });
});
