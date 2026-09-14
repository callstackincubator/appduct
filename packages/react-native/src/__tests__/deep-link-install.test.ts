import { afterEach, beforeEach, describe, expect, vi, test } from "vitest";

import type { CordieriteAutoBootstrapClient } from "../deep-link-install";

/**
 * Issue #48 phase 2 moved bootstrap decode, expiry/private-IP checks, and the
 * ignore-vs-supersede decision entirely into the native core's `handleUrl` -- see
 * `packages/native/ios/Tests/CordieriteCoreTests/CordieriteClientTests.swift`'s `testHandleUrl*`
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
): CordieriteAutoBootstrapClient & {
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
      return url.includes("cordierite=");
    },
  };
};

describe("installCordieriteDeepLinkBootstrap", () => {
  beforeEach(async () => {
    getInitialURLImpl = () => Promise.resolve(null);
    urlListeners = [];
    const mod = await import("../deep-link-install");
    mod.__cordieriteResetInstallGuardForTests();
  });

  afterEach(async () => {
    const mod = await import("../deep-link-install");
    mod.__cordieriteResetInstallGuardForTests();
  });

  test("a rejecting getInitialURL() is caught, not thrown (v1 defect: missing .catch)", async () => {
    getInitialURLImpl = () => Promise.reject(new Error("getInitialURL failed"));
    const { installCordieriteDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient();

    expect(() => {
      installCordieriteDeepLinkBootstrap(client);
    }).not.toThrow();

    await flushMicrotasks();
    expect(client.handleUrlCalls).toEqual([]);
  });

  test("second call is a no-op", async () => {
    const { installCordieriteDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient();

    installCordieriteDeepLinkBootstrap(client);
    installCordieriteDeepLinkBootstrap(client);

    expect(urlListeners).toHaveLength(1);
    expect(client.restoreCalls).toBe(1);
  });

  test("restoreSession runs before the initial URL is fed to handleUrl", async () => {
    getInitialURLImpl = () => Promise.resolve("myapp://open?cordierite=abc");
    let resolveRestore: ((restored: boolean) => void) | undefined;
    const restoreResult = new Promise<boolean>((resolve) => {
      resolveRestore = resolve;
    });
    const { installCordieriteDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient(() => restoreResult);

    installCordieriteDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(urlListeners).toHaveLength(1);
    expect(client.handleUrlCalls).toEqual([]);

    resolveRestore?.(false);
    await flushMicrotasks();

    expect(client.handleUrlCalls).toEqual(["myapp://open?cordierite=abc"]);
  });

  test("the initial URL is still fed to handleUrl even when a lease was restored", async () => {
    // A link delivered to launch this app is newer intent than a session recovered from process
    // memory; native's `handleUrl` (not this file) arbitrates same-session-ignore vs.
    // different-session-supersede -- this file's only job is to always forward it.
    getInitialURLImpl = () => Promise.resolve("myapp://open?cordierite=abc");
    const { installCordieriteDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient(() => Promise.resolve(true));

    installCordieriteDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.restoreCalls).toBe(1);
    expect(client.handleUrlCalls).toEqual(["myapp://open?cordierite=abc"]);
  });

  test("an unexpected recovery rejection still falls back to feeding the initial URL", async () => {
    getInitialURLImpl = () => Promise.resolve("myapp://open?cordierite=abc");
    const { installCordieriteDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient(() =>
      Promise.reject(new Error("restore failed")),
    );

    installCordieriteDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.handleUrlCalls).toEqual(["myapp://open?cordierite=abc"]);
  });

  test("a null initial URL is never forwarded to handleUrl", async () => {
    getInitialURLImpl = () => Promise.resolve(null);
    const { installCordieriteDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient();

    installCordieriteDeepLinkBootstrap(client);
    await flushMicrotasks();

    expect(client.handleUrlCalls).toEqual([]);
  });

  test("a runtime `url` event is forwarded to handleUrl", async () => {
    const { installCordieriteDeepLinkBootstrap } =
      await import("../deep-link-install");
    const client = createMockClient();

    installCordieriteDeepLinkBootstrap(client);
    expect(urlListeners).toHaveLength(1);

    urlListeners[0]?.({ url: "myapp://open?cordierite=runtime" });
    await flushMicrotasks();

    expect(client.handleUrlCalls).toEqual(["myapp://open?cordierite=runtime"]);
  });
});
