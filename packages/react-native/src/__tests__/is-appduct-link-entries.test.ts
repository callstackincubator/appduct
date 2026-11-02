import { describe, expect, test, vi } from "vitest";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

describe("isAppductLink on every entry", () => {
  test.each(["../index", "../index.web", "../noop"])("%s tells an Appduct link from another link", async (entry) => {
    vi.resetModules();
    vi.doMock("react-native", () => ({
      AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
      Linking: { getInitialURL: () => Promise.resolve(null), addEventListener: () => ({ remove() {} }) },
    }));
    const { isAppductLink } = (await import(entry)) as { isAppductLink: (url: string) => boolean };
    expect(isAppductLink("myapp:///?appduct=abc")).toBe(true);
    expect(isAppductLink("myapp:///settings")).toBe(false);
  });
});
