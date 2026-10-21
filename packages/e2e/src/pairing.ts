import { AppductError, link, waitForSession, type AppClient } from "appduct/client";

/** The part of e2e's `browser` fixture pairing uses. */
export type PairingBrowser = {
  url(): Promise<string>;
  evaluate(script: string): Promise<unknown>;
};

/** The part of e2e's `device` fixture pairing uses. */
export type PairingDevice = {
  openLink(url: string): Promise<void>;
  alert(action: "accept"): Promise<void>;
};

export type PairingTarget =
  | { platform: "web"; browser: PairingBrowser }
  | { platform: "ios" | "android"; device: PairingDevice };

/** A web page claims at once; a device may still be launching the app. */
const CLAIM_TIMEOUT_MS = 60_000;

/** Connects the page in the test's browser, which must load `@appduct/web`. */
const linkPage = async (browser: PairingBrowser): Promise<string> => {
  const { sessionId, script } = await link({ target: "web", url: await browser.url() });
  await browser.evaluate(`(${script}, null)`);
  return sessionId;
};

/** Has e2e open the app's deep link, launching the app if it is not running. */
const openDeepLink = async (device: PairingDevice): Promise<string> => {
  const { sessionId, deepLink } = await link();
  await device.openLink(deepLink);
  return sessionId;
};

/**
 * Opens the link on the simulator itself when exactly one is booted, which is quick and asks
 * nothing. A link e2e opens for the test makes iOS ask "Open in …?", so that path, taken when
 * several simulators are booted or the device is a phone, accepts the question as well.
 */
const linkIosApp = async (device: PairingDevice): Promise<string> => {
  try {
    return (await link({ target: "ios-sim" })).sessionId;
  } catch (error) {
    if (!(error instanceof AppductError && error.type === "client_error")) throw error;
  }
  const sessionId = await openDeepLink(device);
  // agent-device reports a failure for an accepted question too, after it closes, so the outcome is
  // read from the claim instead.
  await device.alert("accept").catch(() => undefined);
  return sessionId;
};

/** Hands the app under test a fresh link and resolves once the app has claimed it. */
export const pairWith = async (target: PairingTarget): Promise<AppClient> => {
  const sessionId =
    target.platform === "web"
      ? await linkPage(target.browser)
      : target.platform === "ios"
        ? await linkIosApp(target.device)
        : await openDeepLink(target.device);
  return waitForSession(sessionId, { timeoutMs: CLAIM_TIMEOUT_MS });
};
