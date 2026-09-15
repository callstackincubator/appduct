import { Linking } from "react-native";

import { logger } from "./logger";

/**
 * Structural seam the auto-bootstrap flow needs from a Cordierite client: startup recovery and
 * `handleUrl`. Issue #48 phase 2 moved the entire "parse this deep link, decide whether it
 * outranks the held session, connect" decision into the native core (`CordieriteClient.handleUrl`
 * in Swift, the analogous entry point in Kotlin) -- this file's only remaining job is wiring
 * `Linking` events into it.
 */
export type CordieriteAutoBootstrapClient = {
  /** Starts recovery from the native process-memory lease, if one is available. */
  restoreSession(): Promise<boolean>;
  /** Feeds a URL to the native core. Returns `true` iff it carried a `cordierite` query param
   * (whatever the parse outcome -- a bad payload surfaces on the unified `error` channel with
   * phase `"bootstrap"`), `false` for any other URL so the app can route it itself. */
  handleUrl(url: string): boolean;
};

/**
 * Subscribes to runtime deep links immediately, then attempts startup recovery before considering
 * the initial URL — recovery goes first so the link is judged against a settled session, not so it
 * wins. Idempotent: later calls no-op.
 *
 * @internal Reached by app code only through the `./auto` entry, which passes the default client.
 */
export function installCordieriteDeepLinkBootstrap(
  client: CordieriteAutoBootstrapClient,
): void {
  if (installed) {
    return;
  }
  installed = true;

  try {
    Linking.addEventListener("url", ({ url }) => {
      client.handleUrl(url);
    });
  } catch (error) {
    logger.warn("Cordierite: Linking.addEventListener(url) failed", error);
  }

  const warnRecoveryFailure = () => {
    // The client reports expected recovery transport failures through its unified error channel.
    // This is only the orchestration safety net; do not include the error because a third-party
    // client implementation could put lease credentials in its rejection message.
    logger.warn(
      "Cordierite: startup session recovery failed; falling back to the initial URL",
    );
  };

  let restorePromise: Promise<boolean>;
  try {
    restorePromise = client.restoreSession();
  } catch {
    warnRecoveryFailure();
    restorePromise = Promise.resolve(false);
  }

  let initialUrlPromise: Promise<string | null>;
  try {
    initialUrlPromise = Linking.getInitialURL().catch((error: unknown) => {
      logger.warn("Cordierite: Linking.getInitialURL failed", error);
      return null;
    });
  } catch (error) {
    logger.warn("Cordierite: Linking.getInitialURL failed", error);
    initialUrlPromise = Promise.resolve(null);
  }

  (async () => {
    // Awaited for ordering, not for its answer: letting recovery settle first means the initial
    // URL is judged against a known session rather than racing one into place.
    try {
      await restorePromise;
    } catch {
      warnRecoveryFailure();
    }

    // The initial URL is handled even when a lease *was* restored. A link delivered to launch this
    // app is newer intent than a session recovered from process memory, and native's `handleUrl`
    // arbitrates between them: same session id keeps the restored one, a different id supersedes
    // it. Returning early here instead is what let a lease-restored app silently ignore the link an
    // operator had just delivered — the session they were waiting on was never claimed and nothing
    // said why.
    const initialUrl = await initialUrlPromise;
    if (initialUrl) {
      client.handleUrl(initialUrl);
    }
  })().catch(() => {
    logger.warn("Cordierite: startup bootstrap orchestration failed");
  });
}

let installed = false;

/** @internal */
export function __cordieriteResetInstallGuardForTests(): void {
  installed = false;
}
