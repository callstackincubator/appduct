import { beforeEach, describe, expect, test, vi } from "vitest";

import type * as NativeAppductModule from "../NativeAppduct";

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

/**
 * A build that does not link the native module (a Release build that autolinks Appduct in Debug
 * only, Expo Go) must leave the root entry inert, never crash. The native module is resolved by a
 * lazy `require("./NativeAppduct")` on first use, typically from a `useEffect`. Once the app's
 * entry has finished loading, Metro runs every such `require` through `guardedLoadModule`, which
 * catches anything the module throws while loading and calls `ErrorUtils.reportFatalError` instead
 * of rethrowing (metro-runtime 0.83 `src/polyfills/require.js`). So `./NativeAppduct` must load
 * without throwing; a try/catch around the `require` never sees the error.
 *
 * The loader below reproduces that guard around the real `./NativeAppduct`, loaded against a
 * `TurboModuleRegistry` that has no "Appduct" module and behaves like React Native 0.81's: `get`
 * returns null, `getEnforcing` throws.
 */
const reportFatalError = vi.fn();

const loadNativeAppductLikeMetro = async () => {
  try {
    const loaded: typeof NativeAppductModule = await import("../NativeAppduct");
    return () => loaded;
  } catch (error) {
    return () => {
      reportFatalError(error);
      return undefined as unknown as typeof NativeAppductModule;
    };
  }
};

beforeEach(async () => {
  reportFatalError.mockReset();
  vi.resetModules();

  vi.doMock("react-native", () => ({
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove() {} }),
    },
    Linking: {
      getInitialURL: () => Promise.resolve(null),
      addEventListener: () => ({ remove() {} }),
    },
    TurboModuleRegistry: {
      get: () => null,
      getEnforcing: (name: string) => {
        throw new Error(
          `TurboModuleRegistry.getEnforcing(...): '${name}' could not be found.`,
        );
      },
    },
  }));

  const { __appductSetNativeModuleLoaderForTests } =
    await import("../AppductModule");
  __appductSetNativeModuleLoaderForTests(await loadNativeAppductLikeMetro());
});

describe("root entry in a build without the native module, under Metro's guarded require", () => {
  test("registerTool stays inert without reporting a fatal error", async () => {
    const { registerTool, getRegisteredTools } = await import("../index");

    registerTool({
      name: "release-build-tool",
      description: "test",
      handler: () => undefined,
    });

    expect(reportFatalError).not.toHaveBeenCalled();
    expect(getRegisteredTools()).toEqual([]);
  });

  test("a direct native call still fails with the actionable error", async () => {
    const { appductNativeModule } = await import("../index");

    expect(() => appductNativeModule.unregisterTool("x")).toThrow(
      /could not find its native module/,
    );
    expect(reportFatalError).not.toHaveBeenCalled();
  });
});
