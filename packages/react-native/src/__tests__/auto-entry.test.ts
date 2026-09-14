import { describe, expect, test, vi } from "vitest";

import type { Spec } from "../NativeCordierite";

/**
 * Issue #48 phase 2: native owns lease recovery entirely now (there is no more JS-visible
 * `getResumeLease()`/`clearResumeLease()` pair, and no JS-side "read the lease, then call
 * `connect()` myself" resume flow) -- `restoreSession()` is a single opaque native call. This test
 * now covers only what `./auto` still orchestrates in JS: install the runtime `url` listener once,
 * call `restoreSession()` once, read the initial URL once, and re-export the root API.
 */
describe("./auto entry in a fresh runtime", () => {
  test("restores the native session once, reads the initial URL once, and re-exports the root API", async () => {
    vi.resetModules();

    let restoreSessionCalls = 0;
    let initialUrlReads = 0;
    let urlListenerCount = 0;
    const subscription = () => ({ remove() {} });

    const nativeModule = {
      registerTool() {},
      unregisterTool() {},
      handleUrl: () => false,
      async connect() {},
      async restoreSession() {
        restoreSessionCalls += 1;
        return true;
      },
      async disconnect() {},
      async postEvent() {},
      respondToToolCall() {},
      reportToolProgress() {},
      getState: () => "idle",
      getSessionId: () => null,
      getRegisteredToolsJson: () => "[]",
      onToolCall: subscription,
      onToolCancel: subscription,
      onStateChange: subscription,
      onSessionChange: subscription,
      onError: subscription,
    } as unknown as Spec;

    vi.doMock("react-native", () => ({
      Linking: {
        getInitialURL: () => {
          initialUrlReads += 1;
          return Promise.resolve(null);
        },
        addEventListener: () => {
          urlListenerCount += 1;
          return subscription();
        },
      },
    }));

    const { __cordieriteSetNativeModuleLoaderForTests } =
      await import("../CordieriteModule");
    __cordieriteSetNativeModuleLoaderForTests(() => ({
      NativeCordierite: nativeModule,
    }));
    const rootModule = await import("../index");
    expect(restoreSessionCalls).toBe(0);
    expect(initialUrlReads).toBe(0);
    expect(urlListenerCount).toBe(0);

    const autoModule = await import("../auto");
    await import("../auto");
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(restoreSessionCalls).toBe(1);
    expect(initialUrlReads).toBe(1);
    expect(urlListenerCount).toBe(1);
    expect(autoModule.registerTool).toBe(rootModule.registerTool);
  });
});
