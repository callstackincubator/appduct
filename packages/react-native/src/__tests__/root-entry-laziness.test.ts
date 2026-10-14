import { beforeEach, describe, expect, vi, test } from "vitest";

import type { Spec } from "../NativeAppduct";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/**
 * The root entry must be side-effect-free and its TurboModule lookup lazy (ARCHITECTURE.md §11):
 * importing it never touches the native module, and the session lease is read only when asked
 * for. What each export does once the module turns out to be missing is the `./noop` parity
 * contract in `root-entry-inert-parity.test.ts`.
 *
 * "react-native"'s own source cannot be parsed under a Node test runner (Flow-typed; see
 * `deep-link-install.test.ts` for the same constraint), so it is mocked with working `AppState`/
 * `Linking` stubs. The native-module loader resolves to a nullish `NativeAppduct` export --
 * the same "not found" case `AppductModule.ts`'s defensive check
 * treats identically to the real module throwing from `TurboModuleRegistry.getEnforcing` (Expo Go, a
 * misconfigured build, an inert release build, or this test's environment).
 */
let nativeAccessAttempts = 0;

const resetMocks = async () => {
  nativeAccessAttempts = 0;
  vi.resetModules();

  const { __appductSetNativeModuleLoaderForTests } =
    await import("../AppductModule");
  __appductSetNativeModuleLoaderForTests(() => {
    nativeAccessAttempts += 1;
    return { NativeAppduct: undefined as unknown as Spec };
  });

  vi.doMock("react-native", () => ({
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove() {} }),
    },
    Linking: {
      getInitialURL: () => Promise.resolve(null),
      addEventListener: () => ({ remove() {} }),
    },
  }));
};

describe("root entry (@appduct/react-native): TurboModule laziness", () => {
  beforeEach(async () => {
    await resetMocks();
  });

  test("importing the package never touches the native module", async () => {
    await import("../index");
    expect(nativeAccessAttempts).toBe(0);
  });

  test("restoreSession lazily reads the native lease and tolerates a missing module", async () => {
    const { appductClient } = await import("../index");

    await expect(appductClient.restoreSession()).resolves.toBe(false);
    expect(nativeAccessAttempts).toBeGreaterThan(0);
  });

  test("the exported restoreSession() degrades to ./noop's false when no native module exists", async () => {
    const { restoreSession } = await import("../index");

    await expect(restoreSession()).resolves.toBe(false);
  });
});
