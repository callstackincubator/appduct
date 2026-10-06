/**
 * `@appduct/react-native` on web. Bundlers resolve the `browser` export condition to this file, so
 * a React Native app's web build gets the web SDK with the same API and no web-specific code in
 * the app: `@appduct/web` claims a session over the page's `#appduct=` link, and the hook is the
 * same `useAppductTool`.
 */
import type { AppductBuildConfig } from "./Appduct.types";

export * from "./Appduct.types";
export * from "@appduct/web";
export { useAppductTool } from "@appduct/web/react";

/**
 * A page trusts the one-time link it was opened with: there is no native build config to read and
 * no key pin to embed.
 */
export function getAppductBuildConfig(): AppductBuildConfig {
  return { trust: "link", hasEmbeddedPins: false, allowPrivateLanOnly: true };
}
