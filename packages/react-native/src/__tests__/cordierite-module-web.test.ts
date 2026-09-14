import { describe, expect, test } from "vitest";

import {
  cordieriteNativeModule,
  getCordieriteNativeBuildConfig,
  isCordieriteNativeModuleAvailable,
} from "../CordieriteModule.web";

describe("CordieriteModule.web stub", () => {
  test(
    "isCordieriteNativeModuleAvailable() is always true (the default-inert-release-" +
      "builds degrade path must not misfire on web, which has its own throwing stub above)",
    () => {
      // Metro resolves `./CordieriteModule` to this `.web.ts` file for web bundles, so `index.ts`'s
      // `noopIfNativeUnavailable` calls this exact export on web. Returning `false` here would swap
      // web's intentional "unsupported platform" errors for the generic inert noop behavior instead.
      expect(isCordieriteNativeModuleAvailable()).toBe(true);
    },
  );

  test('getState() returns "idle" instead of throwing (v1 defect)', () => {
    // Regression test: getState() used to throw on web, which crashed any code path that calls it
    // unconditionally (e.g. the deep-link handler's "already connecting/active?" guard) before an
    // app has a chance to guard against calling Cordierite APIs on an unsupported platform.
    expect(cordieriteNativeModule.getState()).toBe("idle");
  });

  test("getSessionId()/getRegisteredToolsJson()/handleUrl() are inert, not throwing", () => {
    expect(cordieriteNativeModule.getSessionId()).toBeNull();
    expect(cordieriteNativeModule.getRegisteredToolsJson()).toBe("[]");
    expect(cordieriteNativeModule.handleUrl("myapp://open?cordierite=x")).toBe(
      false,
    );
  });

  test("registerTool/connect/restoreSession/postEvent still throw or reject: Cordierite is iOS/Android-only", async () => {
    expect(() => cordieriteNativeModule.registerTool("{}")).toThrow();
    await expect(cordieriteNativeModule.connect("{}", false)).rejects.toThrow();
    await expect(cordieriteNativeModule.restoreSession()).resolves.toBe(false);
    await expect(cordieriteNativeModule.disconnect()).resolves.toBeUndefined();
    await expect(cordieriteNativeModule.postEvent("x", null)).rejects.toThrow();
  });

  test("respondToToolCall/reportToolProgress/unregisterTool are no-ops, not throwing", () => {
    expect(() =>
      cordieriteNativeModule.respondToToolCall("id", null, null),
    ).not.toThrow();
    expect(() =>
      cordieriteNativeModule.reportToolProgress("id", null, null),
    ).not.toThrow();
    expect(() => cordieriteNativeModule.unregisterTool("name")).not.toThrow();
  });

  test("addListener returns a no-op removable subscription", () => {
    const subscription = cordieriteNativeModule.addListener("error", () => {});
    expect(() => {
      subscription.remove();
    }).not.toThrow();
  });

  test("getCordieriteNativeBuildConfig() throws: no native module to read on web", () => {
    // Regression test (task 07 self-review): `index.ts`'s `getCordieriteBuildConfig` imports
    // `getCordieriteNativeBuildConfig` from `./CordieriteModule`, which Metro resolves to this
    // `.web.ts` file on web bundles. Since `isCordieriteNativeModuleAvailable()` is forced `true`
    // above, `noopIfNativeUnavailable` always takes this "available" branch on web — an omitted
    // export here would throw an unactionable "is not a function" instead of this file's
    // intentional "unsupported platform" error.
    expect(() => getCordieriteNativeBuildConfig()).toThrow();
  });
});
