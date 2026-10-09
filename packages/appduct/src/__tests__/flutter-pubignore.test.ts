import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const flutter = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."),
  "packages",
  "flutter",
);

/** The non-blank, non-comment lines of an ignore file. */
function entries(file: string): string[] {
  return readFileSync(join(flutter, file), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("the Flutter package's publish ignore list", () => {
  // A .pubignore makes pub skip .gitignore, so anything only .gitignore lists (build/, after a
  // `flutter test`) would be uploaded to pub.dev, where a version can never be deleted.
  it("excludes everything the package's .gitignore excludes", () => {
    expect(entries(".pubignore")).toEqual(
      expect.arrayContaining(entries(".gitignore")),
    );
  });
});
