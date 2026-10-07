import { linkPayload, relayPage, type RelayLink } from "./relay.js";
import type { DevtoolsBrowser, DevtoolsPage, DevtoolsTarget, OpenDaemonSocket } from "./ports.js";

export type AttachBrowserTabOptions = {
  browser: DevtoolsBrowser;
  /**
   * The page relayed for each target id. Attaching a tab closes the page already relayed for it, so a
   * tab has one relay however its browser was reached; the new page is recorded here once relayed.
   */
  relayedTabs: Map<string, DevtoolsPage>;
  /** The tab's address, or the start of it. */
  url: string;
  /** Picks the tab directly, for when several tabs match `url`. */
  targetId?: string;
  /** Mints the web link for the page. Called once a tab is picked, so a failed pick strands no link. */
  mintLink: () => Promise<RelayLink & { sessionId: string; expiresAt: number }>;
  openDaemonSocket: OpenDaemonSocket;
};

/** `url` is the tab's own address, without the link's payload. */
export type AttachedTab = { sessionId: string; url: string; targetId: string; expiresAt: number };

const listTabs = (tabs: DevtoolsTarget[]): string => (tabs.length === 0 ? "  (none)" : tabs.map((tab) => `  ${tab.id}  ${tab.url}`).join("\n"));

/** The tab with `targetId`, else the one tab whose url starts with `url`; throws with the tabs listed otherwise. */
const pickTab = (tabs: DevtoolsTarget[], url: string, targetId: string | undefined): DevtoolsTarget => {
  if (targetId !== undefined) {
    const byId = tabs.find((tab) => tab.id === targetId);
    if (byId) return byId;
    throw new Error(`No open tab has target id "${targetId}". Open tabs:\n${listTabs(tabs)}`);
  }
  const matching = tabs.filter((tab) => tab.url.startsWith(url));
  if (matching.length === 1) return matching[0]!;
  if (matching.length === 0) throw new Error(`No open tab starts with "${url}". Open tabs:\n${listTabs(tabs)}`);
  throw new Error(`${matching.length} open tabs start with "${url}"; pass the target id of the one you want. Matching tabs:\n${listTabs(matching)}`);
};

/** Resolves once `@appduct/web` has loaded in the page; rejects after five seconds. Runs in the page. */
const WAIT_FOR_WEB = `new Promise((resolve, reject) => {
  const ready = () => typeof window.__APPDUCT__?.connect === 'function';
  if (ready()) return resolve(true);
  const timer = setInterval(() => { if (ready()) { clearInterval(timer); clearTimeout(giveUp); resolve(true); } }, 50);
  const giveUp = setTimeout(() => { clearInterval(timer); reject(new Error('@appduct/web did not load')); }, 5000);
})`;

/**
 * Picks a tab of a debugging-port browser, relays its page to the daemon and connects it over the
 * binding, so the session outlives this call. The page must already load `@appduct/web`. Reloading
 * resumes the session; a popup or a navigation that creates a new target is not relayed.
 */
export const attachBrowserTab = async (options: AttachBrowserTabOptions): Promise<AttachedTab> => {
  const tab = pickTab(await options.browser.targets(), options.url, options.targetId);
  const link = await options.mintLink();
  options.relayedTabs.get(tab.id)?.close();
  options.relayedTabs.delete(tab.id);
  const page = await options.browser.openPage(tab.id);
  try {
    relayPage(page, link, options.openDaemonSocket);
    await page.evaluate(WAIT_FOR_WEB).catch(() => {
      throw new Error(`The tab ${tab.id} (${tab.url}) does not load @appduct/web. Add it to the page, then try again.`);
    });
    await page.evaluate(`window.__APPDUCT__.connect(${JSON.stringify(linkPayload(link))}, { transport: "devtools" })`);
  } catch (error) {
    page.close();
    throw error;
  }
  options.relayedTabs.set(tab.id, page);
  return { sessionId: link.sessionId, url: tab.url, targetId: tab.id, expiresAt: link.expiresAt };
};
