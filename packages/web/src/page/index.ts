import { decodeBootstrap } from "@appduct/shared";
import { createAppduct, logger, type AppductClient } from "@appduct/shared/sdk";

import { createWebCore, type WebCorePorts } from "../core/index.js";
import type { PageEnv } from "./memory-page.js";

export { createMemoryPage, type MemoryPage, type PageEnv } from "./memory-page.js";

/** The plain-JS surface of `@appduct/web`. */
export type WebAppduct = Pick<AppductClient, "registerTool" | "registerEvent" | "postEvent" | "disconnect"> & {
  /** Claims a session with the link from `appduct_connect`: the value after `#appduct=`. */
  connect(link: string): Promise<void>;
};

/**
 * Wires the web core under the SDK layer and reads the page's address: a `#appduct=` link is
 * removed from the address bar and claimed, otherwise a session held in `sessionStorage` is
 * resumed. Also publishes `window.__APPDUCT__.connect` for a page that is already loaded.
 */
export const createWebAppduct = ({ ports, page }: { ports: WebCorePorts; page: PageEnv }): WebAppduct => {
  const { client } = createAppduct(createWebCore(ports));

  const connect = async (link: string): Promise<void> => {
    const payload = typeof link === "string" ? decodeBootstrap(link) : null;
    if (!payload) {
      throw new Error("Invalid Appduct link: pass the value after #appduct= from appduct_connect.");
    }
    // A link someone with local access just minted outranks whatever session this page holds.
    await client.connect(payload, { supersede: true });
  };
  page.exposeConnect(connect);

  const url = new URL(page.href());
  const fragment = new URLSearchParams(url.hash.slice(1));
  const link = fragment.get("appduct");
  if (link === null) {
    void client.restoreSession();
  } else {
    fragment.delete("appduct");
    url.hash = fragment.toString();
    page.replaceUrl(url.href);
    connect(link).catch((error: unknown) => logger.warn("Could not connect with the link in the address bar.", error));
  }

  return {
    registerTool: client.registerTool,
    registerEvent: client.registerEvent,
    postEvent: client.postEvent,
    disconnect: client.disconnect,
    connect,
  };
};
