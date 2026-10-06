/**
 * `@appduct/web`: lets an agent, test or terminal call functions inside a running web page. Import
 * it in the page; opening the link from `appduct_connect` (or running its script) claims a session
 * on the local daemon. This file is the composition root: it is the only place real browser
 * adapters are built.
 *
 * Without a browser (a server-side render, a build step that imports the page) every call does
 * nothing, so a page can import this unconditionally.
 */
import { createToolGroupFactory } from "@appduct/shared/sdk";

import { createBrowserEnv } from "./browser/index.js";
import { createWebAppduct, type WebAppduct } from "./page/index.js";

const noSubscription = { remove() {} };

const serverSide: WebAppduct = {
  registerTool: () => noSubscription,
  registerEvent: () => noSubscription,
  postEvent: async () => {},
  disconnect: async () => {},
  getRegisteredTools: () => [],
  addAppductListener: () => noSubscription,
  getAppductState: () => "idle",
  connect: () => Promise.reject(new Error("Appduct needs a browser: there is no page to connect here.")),
};

const appduct = typeof window === "undefined" ? serverSide : createWebAppduct(createBrowserEnv());

export const {
  registerTool,
  registerEvent,
  postEvent,
  connect,
  disconnect,
  getRegisteredTools,
  addAppductListener,
  getAppductState,
} = appduct;

/** `registerTool` bound to one group, for a feature module that registers several tools. */
export const createToolGroup = createToolGroupFactory(registerTool);

export type { AppductSubscription } from "@appduct/shared/sdk";
