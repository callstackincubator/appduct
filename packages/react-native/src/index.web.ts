/**
 * `@appduct/react-native` on web. Bundlers resolve the `browser` export condition to this file, so
 * a React Native app's web build gets the web SDK with the same API and no web-specific code in
 * the app: `@appduct/web` claims a session over the page's `#appduct=` link, and the hook is the
 * same `useAppductTool`.
 */
import { appductClient, appductCore } from "@appduct/web";

import type { AppductBuildConfig, AppductConnectInput } from "./Appduct.types";

export * from "./Appduct.types";
export {
  registerTool,
  registerEvent,
  postEvent,
  getRegisteredTools,
  addAppductListener,
  getAppductState,
  createToolGroup,
  appductClient,
} from "@appduct/web";
export { useAppductTool } from "@appduct/web/react";
export { parseBootstrapPayload, parseBootstrapUrl } from "./bootstrap";
export { createAppductClient, type AppductClient, type CreateAppductClientOptions } from "@appduct/shared/sdk";
export type {
  AppductPublicApi,
  CordierePublicApi,
  AppductSubscription,
  AppductToolGroupRegistrar,
} from "./public-api";
export type { UseAppductToolOptions } from "@appduct/shared/react";

/** The web session core, where the native entry exposes the TurboModule; `AppductCore` in `@appduct/shared/sdk`. */
export const appductNativeModule = appductCore;

/** Resumes the session this tab held before a reload; `false` when there is none to resume. */
export function restoreSession(): Promise<boolean> {
  return appductClient.restoreSession();
}

/** Claims a session from a decoded bootstrap payload or explicit connect options. */
export function connect(input: AppductConnectInput): Promise<void> {
  return appductClient.connect(input);
}

/**
 * A page trusts the one-time link it was opened with: there is no native build config to read and
 * no key pin to embed.
 */
export function getAppductBuildConfig(): AppductBuildConfig {
  return { trust: "link", hasEmbeddedPins: false, allowPrivateLanOnly: true };
}
