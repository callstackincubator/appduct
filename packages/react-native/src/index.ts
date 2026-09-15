import type { ToolDescriptor } from "@appduct/shared";

import type {
  AppductBuildConfig,
  AppductClientState,
  AppductConnectInput,
  AppductListenerKind,
  AppductRuntimeSchema,
  AppductToolRegistration,
  AppductUnifiedListenerMap,
} from "./Appduct.types";
import {
  appductNativeModule,
  getAppductNativeBuildConfig,
} from "./AppductModule";
import { parseBootstrapPayload, parseBootstrapUrl } from "./bootstrap";
import { appductClient, noopIfNativeUnavailable } from "./default-client";
import * as noop from "./noop";
import { exportToolSchemaForKey } from "./schema";
import { createUseAppductTool } from "./useAppductTool";

export * from "./Appduct.types";
export { parseBootstrapPayload, parseBootstrapUrl };
export {
  createAppductClient,
  type AppductClient,
  type AppductNativeModuleLike,
  type CreateAppductClientOptions,
} from "./client";
export { appductNativeModule };
export { appductClient };
export type { CordierePublicApi, AppductSubscription } from "./public-api";
export type { UseAppductToolOptions } from "./useAppductTool";

/**
 * Register an Appduct tool on the default client. Same as `appductClient.registerTool` —
 * prefer this for typical app code so you do not need to touch the singleton. The returned
 * disposer removes only this registration (identity-based), even if a later call re-registers the
 * same tool name.
 */
export function registerTool<
  TInputSchema extends AppductRuntimeSchema | undefined,
  TOutputSchema extends AppductRuntimeSchema | undefined,
>(registration: AppductToolRegistration<TInputSchema, TOutputSchema>) {
  return noopIfNativeUnavailable(
    () => appductClient.registerTool(registration),
    () => noop.registerTool(registration),
  );
}

/** Emits an `event` frame on the default client while active; drops (dev warning) otherwise. */
export function postEvent(name: string, payload?: unknown): Promise<void> {
  return noopIfNativeUnavailable(
    () => appductClient.postEvent(name, payload),
    () => noop.postEvent(name, payload),
  );
}

/**
 * Snapshot of tools currently registered on the default client (i.e. exactly what the last
 * `tool_registry_snapshot`/`tool_registry_delta` sent to the daemon reflects). Useful for rendering
 * a live tool list in app UI instead of hand-maintaining a duplicate array.
 */
export function getRegisteredTools(): ToolDescriptor[] {
  return noopIfNativeUnavailable(
    () => appductClient.getRegisteredTools(),
    () => noop.getRegisteredTools(),
  );
}

/**
 * Unified listener API (ARCHITECTURE.md §11) on the default client: `stateChange`,
 * `sessionChange`, `error` (bootstrap parse/connect, socket, and tool-handler failures — one
 * channel). Every registration returns `{ remove() }`.
 */
export function addAppductListener<Kind extends AppductListenerKind>(
  kind: Kind,
  callback: AppductUnifiedListenerMap[Kind],
) {
  return noopIfNativeUnavailable(
    () => appductClient.addAppductListener(kind, callback),
    () => noop.addAppductListener(kind, callback),
  );
}

/**
 * Recovers the session held in the native process-memory lease, on the default client. Resolves
 * `true` once a resume attempt has started (not once the daemon has acknowledged it), `false` when
 * there is no valid, unexpired lease to restore or this client is already connecting/active.
 *
 * The `./auto` entry already calls this at startup, so apps importing it need nothing more. Call
 * this explicitly if you handle bootstrap links yourself —
 * custom deep-link routing, QR scanning, a manual `connect()` — because otherwise **nothing** reads
 * the lease, and every Metro reload silently drops a session the native side could still have
 * resumed. Call it once at startup, before your own bootstrap handling: a successful restore means
 * you should skip claiming a fresh link.
 *
 * Only a JS runtime replacement is recoverable this way; the lease is process memory and never
 * touches disk, so native process death still requires a fresh bootstrap link.
 */
export function restoreSession(): Promise<boolean> {
  return noopIfNativeUnavailable(
    () => appductClient.restoreSession(),
    () => noop.restoreSession(),
  );
}

/** Unified client state on the default client: `idle | connecting | active | reconnecting | closed`. */
export function getAppductState(): AppductClientState {
  return noopIfNativeUnavailable(
    () => appductClient.getClientState(),
    () => noop.getAppductState(),
  );
}

/**
 * Manually starts the claim/resume handshake on the default client from a decoded bootstrap payload
 * or explicit connect options. Most apps never call this directly — the `./auto` entry drives it
 * from incoming deep links — but it is exposed for manual bootstrap flows (custom deep-link
 * handling, QR scanning, tests).
 */
export function connect(input: AppductConnectInput): Promise<void> {
  return noopIfNativeUnavailable(
    () => appductClient.connect(input),
    () => noop.connect(input),
  );
}

/**
 * Effective trust/pin config this build was compiled with — read from the TurboModule's
 * `getConstants()`, the exact same manifest/plist source `resolveTrustedPins` (task 05) uses on
 * both platforms, never a second parse. Diagnostics only: this never enables dead-code elimination
 * (bundling runs before native config is known) — see `docs/tasks/07-native-module-constants.md`.
 * On the `./noop` entry this reports the documented "absent" shape instead of a real trust mode.
 */
export function getAppductBuildConfig(): AppductBuildConfig {
  return noopIfNativeUnavailable(
    () => getAppductNativeBuildConfig(),
    () => noop.getAppductBuildConfig(),
  );
}

/**
 * `useEffect` wrapper around `registerTool`: registers once per mount and re-registers only when
 * the registration itself changed (name, description, exported schemas, annotations, `timeoutMs`,
 * `enabled`), disposing the previous registration first (identity-safe — see `registerTool`'s doc
 * comment). Calls are routed through the latest render's handler, so `deps` is an optional
 * override rather than something every call site has to remember. `options.enabled` (default
 * `true`) gates registration without breaking the rules of hooks — see `docs/SECURITY.md`'s
 * "Gating a tool by build variant" section.
 *
 * `exportToolSchemaForKey` is injected (rather than imported by the hook) so the inert `./noop` entry
 * below does not pull JSON Schema export into a bundle that registers nothing.
 */
export const useAppductTool = createUseAppductTool(registerTool, {
  exportSchema: exportToolSchemaForKey,
});
