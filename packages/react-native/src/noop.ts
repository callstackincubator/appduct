/**
 * `@appduct/react-native/noop` — inert entry (ARCHITECTURE.md §11): identical public API to the
 * root (`.`) entry, but every operation is a no-op. Intended for release-build compile-out via Metro
 * `resolveRequest` or a conditional `require` (see `docs/BUILD-VARIANTS.md`'s "Compiling
 * Appduct out of production builds" section) — swap `@appduct/react-native` (and `/auto`)
 * for this entry so no Appduct code, native or JS, ships in that build.
 *
 * Typed against the same `CordierePublicApi` interface as `./index.ts` (see
 * `__tests__/noop-parity.test.ts`) so the two cannot drift.
 */
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
import { AppductDisabledError } from "./Appduct.types";
import type { AppductSubscription } from "./public-api";
import { createUseAppductTool } from "./useAppductTool";

export * from "./Appduct.types";
export type { CordierePublicApi, AppductSubscription } from "./public-api";
export type { UseAppductToolOptions } from "./useAppductTool";

const noopSubscription: AppductSubscription = { remove() {} };

/** Accepts any registration and returns a disposer; the tool is never actually registered anywhere. */
export function registerTool<
  TInputSchema extends AppductRuntimeSchema | undefined,
  TOutputSchema extends AppductRuntimeSchema | undefined,
>(
  _registration: AppductToolRegistration<TInputSchema, TOutputSchema>,
): AppductSubscription {
  return noopSubscription;
}

/** `useEffect` wrapper around the inert `registerTool` above — same signature, arity and observable
 * behavior as the real entry, no-op body. No JSON Schema exporter is injected: with a registrar
 * that registers nothing, deriving a registration key would export JSON Schema on every render to
 * decide how often to re-run a no-op, and the import alone would pull `schema.ts` into a bundle
 * whose whole purpose is to carry no Appduct work. */
export const useAppductTool = createUseAppductTool(registerTool);

/** No-op: never sends anything. */
export async function postEvent(
  _name: string,
  _payload?: unknown,
): Promise<void> {}

/** Always empty: this build never registers any tool anywhere. */
export function getRegisteredTools(): ToolDescriptor[] {
  return [];
}

/** No-op: the returned subscription is inert and the callback never fires. */
export function addAppductListener<Kind extends AppductListenerKind>(
  _kind: Kind,
  _callback: AppductUnifiedListenerMap[Kind],
): AppductSubscription {
  return noopSubscription;
}

/** Always `false`: this build has no native module, so there is no resume lease to recover. */
export function restoreSession(): Promise<boolean> {
  return Promise.resolve(false);
}

/** Always `"idle"`. */
export function getAppductState(): AppductClientState {
  return "idle";
}

/** Always rejects with a `AppductDisabledError` (`code: "appduct_disabled"`). */
export function connect(_input: AppductConnectInput): Promise<void> {
  return Promise.reject(new AppductDisabledError());
}

/**
 * Documented "absent" shape: this build has no native module at all (Expo Go/JS-only, or excluded
 * via autolinking), so there is no trust/pin config to report. `trust: "absent"` is a sentinel
 * distinct from the real entry's `"link"`/`"pin"` (or a hand-edited config's raw invalid value) so
 * callers can tell "this build genuinely has no Appduct" apart from a real, resolvable trust
 * mode — this entry never pretends to be a build it isn't. `hasEmbeddedPins`/`allowPrivateLanOnly`
 * are likewise placeholders, not read from anywhere.
 */
export function getAppductBuildConfig(): AppductBuildConfig {
  return { trust: "absent", hasEmbeddedPins: false, allowPrivateLanOnly: true };
}
