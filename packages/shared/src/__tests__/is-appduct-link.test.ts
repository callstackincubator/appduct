import { describe, expect, it } from "vitest";

import { isAppductLink } from "../inert/index.js";

describe("isAppductLink", () => {
  it("accepts a full URL whose query has an appduct key", () => {
    expect(isAppductLink("myapp:///?appduct=abc123")).toBe(true);
    expect(isAppductLink("myapp://open?x=1&appduct=abc123&pin=y")).toBe(true);
  });

  it("accepts a bare path with an appduct key", () => {
    expect(isAppductLink("/?appduct=abc123")).toBe(true);
  });

  it("accepts an appduct key with no value", () => {
    expect(isAppductLink("myapp:///?appduct")).toBe(true);
    expect(isAppductLink("myapp:///?appduct&x=1")).toBe(true);
  });

  it("ignores a fragment after the query", () => {
    expect(isAppductLink("myapp:///?appduct=abc#frag")).toBe(true);
    expect(isAppductLink("myapp:///?x=1#appduct=abc")).toBe(false);
  });

  it("rejects links without an appduct key", () => {
    expect(isAppductLink("myapp:///settings")).toBe(false);
    expect(isAppductLink("myapp:///?other=abc123")).toBe(false);
    expect(isAppductLink("myapp:///?notappduct=1")).toBe(false);
    expect(isAppductLink("myapp:///appduct?x=1")).toBe(false);
  });

  it("returns false for invalid input without throwing", () => {
    for (const input of ["", "not a url", "%%%", "?", "http://[", undefined, null, 42] as unknown[]) {
      expect(() => isAppductLink(input as string)).not.toThrow();
      expect(isAppductLink(input as string)).toBe(false);
    }
  });
});
