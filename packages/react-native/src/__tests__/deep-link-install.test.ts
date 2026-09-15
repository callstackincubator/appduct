import { afterEach, beforeEach, describe, expect, vi, test } from "vitest";

import type { AppductAutoBootstrapClient } from "../deep-link-install";

/**
 * Issue #48 phase 2 moved bootstrap decode, expiry/private-IP checks, and the
 * ignore-vs-supersede decision entirely into the native core's `handleUrl` -- see
 * `packages/native/ios/Tests/AppductCoreTests/AppductClientTests.swift`'s `testHandleUrl*`
 * cases for that behavioral spec now. This file only covers the thin JS wiring left:
 * `Linking` events and the initial URL forwarded to `client.handleUrl`, in the right order
 * relative to `restoreSession()`, and the orchestration never throwing on a native/Linking
 * failure.
 */

(globalThis as { __DEV__?: boolean }).__DEV__ = true;

type UrlListener = (event: { url: string }) => void;

let getInitialURLImpl: () => Promise<string | null> = () =>
  Promise.resolve(null);
let urlListeners: UrlListener[] = [];

// `deep-link-install.ts` imports `Linking` from "react-native" at module scope; "react-native"'s
// own source cannot be parsed under a Node test runner (it is Flow-typed), so it must be mocked
// before the module under test is imported.
vi.mock("react-native", () => ({
  Linking: {
    getInitialURL: () => getInitialURLImpl(),
    addEventListener: (_type: "url", listener: UrlListener) => {
      urlListeners.push(listener);
      return {
        remove() {
          urlListeners = urlListeners.filter((l) => l !== listener);
        },
      };
    },
  },
}));

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createMockClient = (
  restoreSessionImpl: () => Promise<boolean> = () => Promise.resolve(false),
): AppductAutoBootstrapClient & {
  handleUrlCalls: string[];
  restoreCalls: number;
} => {
  const handleUrlCalls: string[] = [];
  let restoreCalls = 0;
  return {
    handleUrlCalls,
    get restoreCalls() {
      return restoreCalls;
    },
    async restoreSession() {
      restoreCalls += 1;
      return restoreSessionImpl();
    },
    handleUrl(url: string) {
      handleUrlCalls.push(url);
      return url.includes("appduct=");
    },
  };
};

describe("installAppductDeepLinkBootstrap", () => {
  beforeEach(async () => {
    getInitialURLImpl = () => Promise.resolve(null);
    urlListeners = [];
    const mod = await import("../deep-link-install");
    mod.__appductResetInstallGuardForTests();
  });

  afterEach(async () => {
    const mod = await import("../deep-link-install");
    mod.__appductResetInstallGuardForTests();
  });

  test("a rejecting getInitialURL() is caught, not thrown (v1 defect: missing .catch)", async () => {
    getInitialURLImpl = () => Promise.reject(new Error("getInitialURL failed"));
    const { installAppductDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient();

    expect(() => {
      installAppductDeepLinkBootstrap(client);
    }).not.toThrow();

    await flushMicrotasks();
    expect(client.handleUrlCalls).toEqual([]);
  });

  test("second call is a no-op", async () => {
    const { installAppductDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient();

    installAppductDeepLinkBootstrap(client);
    installAppductDeepLinkBootstrap(client);

    expect(urlListeners).toHaveLength(1);
    expect(client.restoreCalls).toBe(1);
  });

  test("restoreSession runs before the initial URL is fed to handleUrl", async () => {
    getInitialURLImpl = () => Promise.resolve("myapp://open?appduct=abc");
    let resolveRestore: ((restored: boolean) => void) | undefined;
    const restoreResult = new Promise<boolean>((resolve) => {
      resolveRestore = resolve;
    });
    const { installAppductDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient(() => restoreResult);

    installAppductDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(urlListeners).toHaveLength(1);
    expect(client.handleUrlCalls).toEqual([]);

    resolveRestore?.(false);
    await flushMicrotasks();

    expect(client.handleUrlCalls).toEqual(["myapp://open?appduct=abc"]);
  });

  test("the initial URL is still fed to handleUrl even when a lease was restored", async () => {
    // A link delivered to launch this app is newer intent than a session recovered from process
    // memory; native's `handleUrl` (not this file) arbitrates same-session-ignore vs.
    // different-session-supersede -- this file's only job is to always forward it.
    getInitialURLImpl = () => Promise.resolve("myapp://open?appduct=abc");
    const { installAppductDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient(() => Promise.resolve(true));

    installAppductDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.restoreCalls).toBe(1);
    expect(client.handleUrlCalls).toEqual(["myapp://open?appduct=abc"]);
  });

  test("an unexpected recovery rejection still falls back to feeding the initial URL", async () => {
    getInitialURLImpl = () => Promise.resolve("myapp://open?appduct=abc");
    const { installAppductDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient(() =>
      Promise.reject(new Error("restore failed")),
    );

    installAppductDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.handleUrlCalls).toEqual(["myapp://open?appduct=abc"]);
  });

  test("a null initial URL is never forwarded to handleUrl", async () => {
    getInitialURLImpl = () => Promise.resolve(null);
    const { installAppductDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient();

    installAppductDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.handleUrlCalls).toEqual([]);
  });

  test("a runtime `url` event is forwarded to handleUrl", async () => {
    const { installAppductDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient();

    installAppductDeepLinkBootstrap(client);
    expect(urlListeners).toHaveLength(1);

    urlListeners[0]?.({ url: "myapp://open?appduct=runtime" });
    await flushMicrotasks();

    expect(client.handleUrlCalls).toEqual(["myapp://open?appduct=runtime"]);
  });
});
