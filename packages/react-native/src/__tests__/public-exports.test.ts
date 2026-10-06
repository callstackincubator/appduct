import { describe, expect, test, vi } from "vitest";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/**
 * The package's runtime exports, per entry, as of 0.14.0. Moving the JS layer into
 * `@appduct/shared` must not add, remove or rename any of them.
 */
describe("@appduct/react-native public exports", () => {
  test.each(["../index", "../noop", "../auto"])("%s exports exactly the documented names", async (entry) => {
    vi.resetModules();
    vi.doMock("react-native", () => ({
      AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
      Linking: { getInitialURL: () => Promise.resolve(null), addEventListener: () => ({ remove() {} }) },
    }));
    const names = Object.keys(await import(entry)).sort();
    expect(names).toMatchSnapshot();
  });

  test("../index.web exports the same names as ../index", async () => {
    vi.resetModules();
    vi.doMock("react-native", () => ({
      AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
      Linking: { getInitialURL: () => Promise.resolve(null), addEventListener: () => ({ remove() {} }) },
    }));
    const web = Object.keys(await import("../index.web")).sort();
    const native = Object.keys(await import("../index")).sort();
    expect(web).toEqual(native);
  });
});
