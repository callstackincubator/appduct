import { describe, expect, test } from "vitest";

import {
  appductNativeModule,
  getAppductNativeBuildConfig,
  isAppductNativeModuleAvailable,
} from "../AppductModule.web";

describe("AppductModule.web stub", () => {
  test(
    "isAppductNativeModuleAvailable() is always true (the default-inert-release-" +
      "builds degrade path must not misfire on web, which has its own throwing stub above)",
    () => {
      // Metro resolves `./AppductModule` to this `.web.ts` file for web bundles, so `index.ts`'s
      // `noopIfNativeUnavailable` calls this exact export on web. Returning `false` here would swap
      // web's intentional "unsupported platform" errors for the generic inert noop behavior instead.
      expect(isAppductNativeModuleAvailable()).toBe(true);
    },
  );

  test('getState() returns "idle" instead of throwing (v1 defect)', () => {
    // Regression test: getState() used to throw on web, which crashed any code path that calls it
    // unconditionally (e.g. the deep-link handler's "already connecting/active?" guard) before an
    // app has a chance to guard against calling Appduct APIs on an unsupported platform.
    expect(appductNativeModule.getState()).toBe("idle");
  });

  test("getSessionId()/getRegisteredToolsJson()/handleUrl() are inert, not throwing", () => {
    expect(appductNativeModule.getSessionId()).toBeNull();
    expect(appductNativeModule.getRegisteredToolsJson()).toBe("[]");
    expect(appductNativeModule.handleUrl("myapp://open?appduct=x")).toBe(
      false,
    );
  });

  test("registerTool/connect/restoreSession/disconnect/postEvent all throw or reject: Appduct is iOS/Android-only", async () => {
    expect(() => appductNativeModule.registerTool("{}")).toThrow();
    await expect(appductNativeModule.connect("{}", false)).rejects.toThrow();
    await expect(appductNativeModule.restoreSession()).rejects.toThrow();
    await expect(appductNativeModule.disconnect()).rejects.toThrow();
    await expect(appductNativeModule.postEvent("x", null)).rejects.toThrow();
  });

  test("respondToToolCall/reportToolProgress/unregisterTool are no-ops, not throwing", () => {
    expect(() =>
      appductNativeModule.respondToToolCall("id", null, null),
    ).not.toThrow();
    expect(() =>
      appductNativeModule.reportToolProgress("id", null, null),
    ).not.toThrow();
    expect(() => appductNativeModule.unregisterTool("name")).not.toThrow();
  });

  test("addListener returns a no-op removable subscription", () => {
    const subscription = appductNativeModule.addListener("error", () => {});
    expect(() => {
      subscription.remove();
    }).not.toThrow();
  });

  test("getAppductNativeBuildConfig() throws: no native module to read on web", () => {
    // Regression test (task 07 self-review): `index.ts`'s `getAppductBuildConfig` imports
    // `getAppductNativeBuildConfig` from `./AppductModule`, which Metro resolves to this
    // `.web.ts` file on web bundles. Since `isAppductNativeModuleAvailable()` is forced `true`
    // above, `noopIfNativeUnavailable` always takes this "available" branch on web — an omitted
    // export here would throw an unactionable "is not a function" instead of this file's
    // intentional "unsupported platform" error.
    expect(() => getAppductNativeBuildConfig()).toThrow();
  });
});
