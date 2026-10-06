/**
 * `attachPage()` (issue #177): runs a web page's Appduct session through a Playwright page instead of
 * a socket the page opens itself. The page and the daemon talk through a binding Playwright exposes,
 * so it works on an `https` page with no permission prompt and no debugging port. The binding belongs
 * to the page's target: a popup, or a navigation that creates a new target, is not relayed, and the
 * session stays on the page it was attached to.
 */
import { linkPayload, openNodeDaemonSocket, relayPage, type PageChannel, type RelayLink } from "../devtools-relay/index.js";
import { toAppductError } from "./errors.js";

/** The part of a Playwright `Page` that `attachPage` uses, so `appduct` has no Playwright dependency. */
export type AttachablePage = {
  exposeBinding(name: string, callback: (source: { frame: unknown }, json: string) => void): Promise<void>;
  addInitScript(script: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  waitForFunction(expression: string): Promise<unknown>;
  mainFrame(): unknown;
  on(event: "close", handler: () => void): unknown;
};

export type AttachPageOptions = {
  /** The result of `link({ target: "web", url })` for the page's address. */
  link: RelayLink;
};

const BINDING = "__appductBinding";

/** Every new document announces itself before its own scripts run, so the relay knows the old one is gone. */
const ANNOUNCE_DOCUMENT = `if (window === window.top) window.${BINDING}(JSON.stringify({ kind: "context" }));`;

const channelOf = async (page: AttachablePage): Promise<PageChannel> => {
  const bindingHandlers: ((json: string) => void)[] = [];
  const resetHandlers: (() => void)[] = [];
  const reset = () => resetHandlers.forEach((handler) => handler());

  await page.exposeBinding(BINDING, (source, json) => {
    if (source.frame !== page.mainFrame()) return;
    if ((JSON.parse(json) as { kind: string }).kind === "context") reset();
    else bindingHandlers.forEach((handler) => handler(json));
  });
  await page.addInitScript(ANNOUNCE_DOCUMENT);
  page.on("close", reset);

  return {
    onBindingCall: (handler) => void bindingHandlers.push(handler),
    onContextReset: (handler) => void resetHandlers.push(handler),
    evaluate: (expression) => page.evaluate(expression),
  };
};

/**
 * Connects the page, which must already load `@appduct/web`, to the daemon through its Playwright
 * binding. Resolves once the session is claimed. A reload resumes the session over the same binding.
 *
 * ```ts
 * await page.goto("https://staging.example.com");
 * await attachPage(page, { link: await link({ target: "web", url: page.url() }) });
 * ```
 */
export const attachPage = async (page: AttachablePage, options: AttachPageOptions): Promise<void> => {
  try {
    const payload = linkPayload(options.link);
    relayPage(await channelOf(page), options.link, openNodeDaemonSocket);
    await page.waitForFunction("typeof window.__APPDUCT__?.connect === 'function'");
    await page.evaluate(`window.__APPDUCT__.connect(${JSON.stringify(payload)}, { transport: "devtools" })`);
  } catch (error) {
    throw toAppductError(error);
  }
};
