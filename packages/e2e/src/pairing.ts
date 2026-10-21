import { AppductError, type AppClient } from "appduct/client";

import type { Daemon } from "./daemon.js";
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

/** A device may still be launching the app; a page that loads `@appduct/web` connects at once. */
const DEVICE_CLAIM_SECONDS = 60;
const WEB_CLAIM_SECONDS = 10;
/** How long an iOS app gets to claim before pairing looks for iOS's "Open in …?" question. */
const PROMPT_WAIT_MS = 2_000;

/** Connects the page in the test's browser. */
const linkPage = async (browser: PairingBrowser, daemon: Daemon): Promise<AppClient> => {
  // The link lasts only as long as the wait, so a failed pairing leaves nothing behind.
  const { sessionId, script } = await daemon.webLink(await browser.url(), WEB_CLAIM_SECONDS);
  await browser.evaluate(`(${script}, null)`);
  return daemon.claim(sessionId, WEB_CLAIM_SECONDS * 1000).catch((error: unknown) => {
    if (!(error instanceof AppductError && error.type === "timeout")) throw error;
    throw new AppductError(
      "timeout",
      `The page did not connect to Appduct within ${WEB_CLAIM_SECONDS} s. Check that it loads @appduct/web from a development build.`,
    );
  });
};

/**
 * Has e2e open the app's deep link, which launches the app if it is not running. A simulator asks
 * "Open in …?" for the first link it opens into an app and not again once accepted, so the question
 * is accepted only when the app has not claimed in time.
 */
const linkApp = async (
  target: Extract<PairingTarget, { device: PairingDevice }>,
  daemon: Daemon,
  clock: Clock,
): Promise<AppClient> => {
  const { sessionId, deepLink } = await daemon.deviceLink(DEVICE_CLAIM_SECONDS);
  await target.device.openLink(deepLink);
  const claimed = daemon.claim(sessionId, DEVICE_CLAIM_SECONDS * 1000);
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
export const pairWith = (target: PairingTarget, daemon: Daemon, clock: Clock): Promise<AppClient> =>
  target.platform === "web" ? linkPage(target.browser, daemon) : linkApp(target, daemon, clock);
