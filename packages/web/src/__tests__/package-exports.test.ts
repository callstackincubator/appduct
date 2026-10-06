import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  private?: boolean;
  main: string;
  exports: Record<string, Record<string, string>>;
};

describe("the @appduct/web package manifest", () => {
  it("is publishable", () => {
    expect(manifest.private).toBeUndefined();
  });

  it("resolves the root entry to the real entry under the development condition only", () => {
    const root = manifest.exports["."]!;
    expect(root.development).toBe("./dist/enabled.js");
    expect(root.default).toBe("./dist/inert.js");
    expect(root.import).toBeUndefined();
    expect(manifest.main).toBe("./dist/inert.js");
  });

  it("always resolves @appduct/web/enabled to the real entry", () => {
    expect(manifest.exports["./enabled"]).toEqual({
      types: "./dist/enabled.d.ts",
      default: "./dist/enabled.js",
    });
  });

  it("gives both entries the same types", () => {
    expect(manifest.exports["."]!.types).toBe("./dist/index.d.ts");
  });
});
