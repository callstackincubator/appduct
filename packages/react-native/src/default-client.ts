import {
  appductNativeModule,
  isAppductNativeModuleAvailable,
} from "./AppductModule";
import { createAppductClient } from "./client";
import { logger } from "./logger";

/**
 * The default client singleton and the native-availability gate the root (`.`) and `./auto`
 * entries both build on. Kept out of `index.ts` so `./auto` can reach the gate without `index.ts`
 * having to export it — `auto.ts` re-exports the whole root entry (`export * from "./index"`), so
 * anything exported there is public API by construction.
 */

let appductClientInstance: ReturnType<typeof createAppductClient> | null =
  null;

/**
 * Whether Appduct's native module exists in a build at all is decided entirely by
 * autolinking (see `docs/tasks/00-overview.md`'s "Inclusion" contract), not by any runtime
 * check here. When it is absent — Expo Go, a JS-only bundle, or the app excluded Appduct
 * from autolinking — `TurboModuleRegistry` never finds it, and every exported function of the root
 * entry degrades to the exact `./noop` entry's behavior instead of the real client's — see
 * `noopIfNativeUnavailable`. Logged exactly once per process, not once per call, so an app that
 * calls these functions in a loop or on every render is not spammed.
 */
let warnedNativeModuleInert = false;
const warnNativeModuleInertOnce = (): void => {
  if (warnedNativeModuleInert) {
    return;
  }
  warnedNativeModuleInert = true;
  logger.warn(
    "Appduct: the native module is not available in this build (Expo Go/JS-only, or " +
      "excluded via autolinking). The public API is inert, matching the `./noop` entry.",
  );
};

/** Runs `whenInert()` (a `./noop` call) instead of `whenAvailable()` (the real client call) once
 * the native module has been found unavailable, warning exactly once the first time this happens. */
export function noopIfNativeUnavailable<T>(
  whenAvailable: () => T,
  whenInert: () => T,
): T {
  if (!isAppductNativeModuleAvailable()) {
    warnNativeModuleInertOnce();
    return whenInert();
  }
  return whenAvailable();
}

/**
 * Constructing a `AppductClient` subscribes native event listeners immediately —
 * harmless when the native module is unavailable (`AppductModule.ts`'s `addListener` never
 * throws) but still real work. Deferring the construction itself until first use keeps the root
 * entry genuinely side-effect-free at import time (ARCHITECTURE.md §11), not merely
 * non-throwing.
 */
const getAppductClientInstance = (): ReturnType<
  typeof createAppductClient
> => {
  if (!appductClientInstance) {
    appductClientInstance = createAppductClient(appductNativeModule);
  }
  return appductClientInstance;
};

/**
 * Default Appduct client (native TurboModule, real `AppState`). Prefer importing the package
 * top-level functions (`registerTool`, `postEvent`, `addAppductListener`, `getAppductState`,
 * `restoreSession`) for typical app code; use this instance only for advanced flows (manual
 * `connect`/`send`, custom listeners, testing).
 *
 * A `Proxy` so that merely referencing this export (or importing the module) never constructs the
 * underlying client — only an actual property access (e.g. `appductClient.getState()`) does,
 * which is also the first point the root entry's top-level functions touch it.
 */
export const appductClient = new Proxy(
  {} as ReturnType<typeof createAppductClient>,
  {
    get(_target, property, receiver) {
      return Reflect.get(getAppductClientInstance(), property, receiver);
    },
    has(_target, property) {
      return Reflect.has(getAppductClientInstance(), property);
    },
  },
);
