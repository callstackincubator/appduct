/**
 * Web / unsupported-platform stub for Metro resolution.
 *
 * `registerTool`, `connect`, `restoreSession`, `disconnect`, and `postEvent` throw — Appduct is
 * iOS/Android-only. `handleUrl`/`getState`/`getSessionId`/`getRegisteredToolsJson` return inert
 * values rather than throwing: they are called unconditionally from code paths that run on every
 * platform (e.g. the deep-link handler), and throwing there would crash any web bundle that merely
 * imports the package before an app ever calls an Appduct API. Apps must still not call the
 * throwing APIs on web.
 *
 * `addListener` returns a no-op subscription for the same reason: the package eagerly constructs
 * `appductClient` at import time, which registers internal listeners.
 *
 * `isAppductNativeModuleAvailable` always returns `true` here — NOT because a native module
 * exists on web, but so that `index.ts`'s default-inert-release-builds degrade path never
 * kicks in on this platform: Metro resolves `./AppductModule` to this `.web.ts` file for web
 * bundles, and web already has its own distinct, intentional "unsupported platform" error surface
 * above. Reporting "unavailable" here would silently swap that actionable error for the generic
 * inert noop behavior instead, which is the "misfire on web" the task explicitly rules out.
 */
import type { AppductBuildConfig } from "./Appduct.types";
import type { AppductNativeModuleLike } from "./client-types";
import { logger } from "./logger";

/** Always `true` on web — see the file-level doc comment above. */
export const isAppductNativeModuleAvailable = (): boolean => true;

const unsupported = (what: string): never => {
  logger.warn(`Appduct native module is not available on web (${what})`);
  throw new Error(
    "@appduct/react-native is only available on iOS and Android development or production builds.",
  );
};

export const appductNativeModule: AppductNativeModuleLike = {
  registerTool() {
    unsupported("registerTool");
  },
  unregisterTool() {},
  handleUrl(): boolean {
    return false;
  },
  async connect() {
    unsupported("connect");
  },
  async restoreSession() {
    return unsupported("restoreSession");
  },
  async disconnect() {
    unsupported("disconnect");
  },
  async postEvent() {
    unsupported("postEvent");
  },
  respondToToolCall() {},
  reportToolProgress() {},
  getState(): string {
    return "idle";
  },
  getSessionId(): string | null {
    return null;
  },
  getRegisteredToolsJson(): string {
    return "[]";
  },
  addListener() {
    return {
      remove() {},
    };
  },
};

/**
 * Web has no native module to read a build config from. Unlike `getState`/`addListener` (called
 * unconditionally from internal code paths, so they degrade quietly), this mirrors `connect`/
 * `registerTool`/`postEvent`: a diagnostic call an app makes deliberately, so — since
 * `isAppductNativeModuleAvailable` is forced `true` on web (see the file-level doc comment) and
 * `index.ts`'s `noopIfNativeUnavailable` therefore always takes this "available" branch on web —
 * it throws the same actionable "unsupported platform" error rather than silently reporting a fake
 * build config.
 */
export const getAppductNativeBuildConfig = (): AppductBuildConfig =>
  unsupported("getAppductBuildConfig");
