import { link, waitForSession, type AppClient } from "appduct/client";

import type { Clock } from "./session.js";

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
/** How long an iOS app gets to claim before pairing looks for iOS's "Open in …?" question. */
const PROMPT_WAIT_MS = 2_000;

const claim = (sessionId: string): Promise<AppClient> => waitForSession(sessionId, { timeoutMs: CLAIM_TIMEOUT_MS });

/** Connects the page in the test's browser, which must load `@appduct/web`. */
const linkPage = async (browser: PairingBrowser): Promise<AppClient> => {
  const { sessionId, script } = await link({ target: "web", url: await browser.url() });
  await browser.evaluate(`(${script}, null)`);
  return claim(sessionId);
};

/**
 * Has e2e open the app's deep link, which launches the app if it is not running. A simulator asks
 * "Open in …?" for the first link it opens into an app and not again once accepted, so the question
 * is accepted only when the app has not claimed in time.
 */
const linkApp = async (target: Extract<PairingTarget, { device: PairingDevice }>, clock: Clock): Promise<AppClient> => {
  const { sessionId, deepLink } = await link();
  await target.device.openLink(deepLink);
  const claimed = claim(sessionId);
  if (target.platform === "ios") {
    const settled = claimed.then(
      () => true,
      () => true,
    );
    if (!(await Promise.race([settled, clock.sleep(PROMPT_WAIT_MS).then(() => false)]))) {
      // agent-device can report a failure for a question it did accept, so the claim decides.
      await target.device.alert("accept").catch(() => undefined);
    }
  }
  return claimed;
};

/** Hands the app under test a fresh link and resolves once the app has claimed it. */
export const pairWith = (target: PairingTarget, clock: Clock): Promise<AppClient> =>
  target.platform === "web" ? linkPage(target.browser) : linkApp(target, clock);
