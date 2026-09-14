import type { CordieriteBuildConfig } from "./Cordierite.types";
import type {
  CordieriteNativeEvents,
  CordieriteNativeModuleLike,
} from "./client-types";
import { logger } from "./logger";

// Metro/Node's CommonJS `require` is available at runtime in every environment this file actually
// ships to (React Native bundles); this narrow local declaration
// avoids pulling in `@types/node` just for the lazy-resolution trick below.
declare const require: (id: string) => Record<string, unknown>;

type NativeCordieriteModule = typeof import("./NativeCordierite");
type NativeModuleLoader = () => NativeCordieriteModule;

/**
 * ARCHITECTURE.md §11: the root entry is side-effect-free, so the TurboModule lookup
 * (`TurboModuleRegistry.getEnforcing`, which throws when the native module was never registered —
 * Expo Go, a misconfigured build, or a JS-only environment) must happen lazily on the *first* native
 * call, never at import time. `require` here (not a static `import`) is what makes the lookup lazy:
 * `./NativeCordierite`'s top-level `getEnforcing` call only runs the first time this function
 * actually executes.
 */
let cachedNative: NativeCordieriteModule["NativeCordierite"] | null = null;
const defaultNativeModuleLoader: NativeModuleLoader = () =>
  require("./NativeCordierite") as NativeCordieriteModule;
let nativeModuleLoader: NativeModuleLoader = defaultNativeModuleLoader;

/** Memoized answer for `isCordieriteNativeModuleAvailable` — `null` means "not probed yet". Whether
 * the native module is linked cannot change within a process's lifetime, so one probe suffices. */
let nativeModuleAvailable: boolean | null = null;

/** @internal Allows the Node test runner to supply the lazy native-module dependency. */
export const __cordieriteSetNativeModuleLoaderForTests = (
  loader?: NativeModuleLoader,
): void => {
  cachedNative = null;
  nativeModuleAvailable = null;
  nativeModuleLoader = loader ?? defaultNativeModuleLoader;
};

const resolveNativeModule = (): NativeCordieriteModule["NativeCordierite"] => {
  if (cachedNative) {
    return cachedNative;
  }

  try {
    const nativeModule = nativeModuleLoader();
    const resolvedNative = nativeModule.NativeCordierite;
    if (!resolvedNative) {
      // Defensive: the real `NativeCordierite.ts` either resolves or throws (it never resolves to
      // a nullish value), but a test double or an unexpected bundler transform could — treat that
      // the same as "not found" rather than deferring a crash to the first actual method call.
      throw new Error("NativeCordierite module resolved to a nullish value.");
    }
    cachedNative = resolvedNative;
    return cachedNative;
  } catch (error) {
    throw new Error(
      '@cordierite/react-native could not find its native module ("Cordierite"). ' +
        "This library ships native code and requires a custom development build — Expo Go and " +
        "JS-only bundles do not include it. Rebuild with `expo run:ios`/`expo run:android` (or " +
        `your bare React Native dev client), then try again. (${
          error instanceof Error ? error.message : String(error)
        })`,
    );
  }
};

/**
 * Probes whether the native module can be resolved, without throwing. Powers the root (`.`)
 * entry's automatic degrade-to-noop: whether Cordierite's native module exists at all is decided
 * entirely by autolinking (see `docs/tasks/00-overview.md`), so a build that excluded it never
 * registers the module, and `resolveNativeModule()` throws exactly like it already does for
 * Expo Go / a JS-only bundle — this reuses that same signal rather than adding a second one.
 */
export const isCordieriteNativeModuleAvailable = (): boolean => {
  if (nativeModuleAvailable !== null) {
    return nativeModuleAvailable;
  }

  try {
    resolveNativeModule();
    nativeModuleAvailable = true;
  } catch {
    nativeModuleAvailable = false;
  }

  return nativeModuleAvailable;
};

type EventSubscription = { remove(): void };

const bridgeListeners: {
  [K in keyof CordieriteNativeEvents]: (
    listener: CordieriteNativeEvents[K],
  ) => EventSubscription;
} = {
  toolCall(listener) {
    const subscription = resolveNativeModule().onToolCall((nativeEvent) => {
      listener({
        id: nativeEvent.id,
        name: nativeEvent.name,
        argsJson: nativeEvent.argsJson,
      });
    });
    return { remove: () => subscription.remove() };
  },

  toolCancel(listener) {
    const subscription = resolveNativeModule().onToolCancel((nativeEvent) => {
      listener({ id: nativeEvent.id, reason: nativeEvent.reason });
    });
    return { remove: () => subscription.remove() };
  },

  stateChange(listener) {
    const subscription = resolveNativeModule().onStateChange((nativeEvent) => {
      listener({
        state: nativeEvent.state,
        reason: nativeEvent.reason ?? undefined,
      });
    });
    return { remove: () => subscription.remove() };
  },

  sessionChange(listener) {
    const subscription = resolveNativeModule().onSessionChange(
      (nativeEvent) => {
        listener({
          type: nativeEvent.type,
          sessionId: nativeEvent.sessionId ?? null,
          alias: nativeEvent.alias ?? null,
          reason: nativeEvent.reason ?? undefined,
        });
      },
    );
    return { remove: () => subscription.remove() };
  },

  error(listener) {
    const subscription = resolveNativeModule().onError((nativeEvent) => {
      listener({
        phase: nativeEvent.phase,
        message: nativeEvent.message,
        code: nativeEvent.code ?? undefined,
        nativeCode: nativeEvent.nativeCode ?? undefined,
        closeReason: nativeEvent.closeReason ?? undefined,
        isRetryable: nativeEvent.isRetryable ?? undefined,
        hint: nativeEvent.hint ?? undefined,
        toolName: nativeEvent.toolName ?? undefined,
        invocationId: nativeEvent.invocationId ?? undefined,
      });
    });
    return { remove: () => subscription.remove() };
  },
};

const noopSubscription: EventSubscription = { remove() {} };

export const cordieriteNativeModule: CordieriteNativeModuleLike = {
  registerTool: (descriptorJson) =>
    resolveNativeModule().registerTool(descriptorJson),
  unregisterTool: (name) => resolveNativeModule().unregisterTool(name),
  handleUrl: (url) => resolveNativeModule().handleUrl(url),
  connect: (inputJson, supersede) =>
    resolveNativeModule().connect(inputJson, supersede),
  /**
   * Never throws, even when the native module cannot be resolved: called unconditionally from
   * startup orchestration (`deep-link-install.ts`, and directly by apps that drive bootstrap
   * themselves) before any app-level call has a chance to surface the actionable error --
   * mirrors `getState`/`getSessionId` above.
   */
  restoreSession: async (): Promise<boolean> => {
    try {
      return await resolveNativeModule().restoreSession();
    } catch (error) {
      logger.debug(
        "restoreSession(): native module unavailable, reporting false",
        error,
      );
      return false;
    }
  },
  disconnect: () => resolveNativeModule().disconnect(),
  postEvent: (name, payloadJson) =>
    resolveNativeModule().postEvent(name, payloadJson),
  respondToToolCall: (id, resultJson, errorJson) =>
    resolveNativeModule().respondToToolCall(id, resultJson, errorJson),
  reportToolProgress: (id, progress, message) =>
    resolveNativeModule().reportToolProgress(id, progress, message),
  /**
   * Never throws, even when the native module cannot be resolved: called unconditionally from
   * code paths that must survive a missing native module (e.g. `default-client.ts`'s constructor
   * wiring) before an app-level call ever gets a chance to surface the actionable error.
   */
  getState: (): string => {
    try {
      return resolveNativeModule().getState();
    } catch (error) {
      logger.debug(
        "getState(): native module unavailable, reporting idle",
        error,
      );
      return "idle";
    }
  },
  getSessionId: (): string | null => {
    try {
      return resolveNativeModule().getSessionId();
    } catch (error) {
      logger.debug(
        "getSessionId(): native module unavailable, reporting null",
        error,
      );
      return null;
    }
  },
  getRegisteredToolsJson: (): string => {
    try {
      return resolveNativeModule().getRegisteredToolsJson();
    } catch (error) {
      logger.debug(
        "getRegisteredToolsJson(): native module unavailable, reporting []",
        error,
      );
      return "[]";
    }
  },
  /**
   * Never throws: constructing a `CordieriteClient` subscribes several of these at creation
   * time, and that must stay side-effect-free at import time. When the native module is
   * unavailable the returned subscription is an inert no-op — the listener simply never fires until
   * an app-level native call (e.g. `connect()`) has a chance to surface the real, actionable error.
   */
  addListener(eventName, listener) {
    const attach = bridgeListeners[eventName];
    if (!attach) {
      throw new Error(`Unknown Cordierite event: ${String(eventName)}`);
    }
    try {
      return attach(listener as CordieriteNativeEvents[typeof eventName]);
    } catch (error) {
      logger.debug(
        `addListener("${String(eventName)}"): native module unavailable, subscription is inert`,
        error,
      );
      return noopSubscription;
    }
  },
};

/**
 * Reads the effective trust/pin build config via the TurboModule's `getConstants()` — the exact
 * same manifest/plist keys `resolveTrustedPins` (task 05) reads on both platforms, never a second
 * parse. Callers reach this only through `noopIfNativeUnavailable` (see `index.ts`'s
 * `getCordieriteBuildConfig`), which already gates on `isCordieriteNativeModuleAvailable()`, so
 * this deliberately does not catch: a resolution failure here would mean the availability probe
 * and this call disagreed, which should surface loudly rather than be swallowed into a fake
 * "absent" result.
 */
export const getCordieriteNativeBuildConfig = (): CordieriteBuildConfig =>
  resolveNativeModule().getConstants();
