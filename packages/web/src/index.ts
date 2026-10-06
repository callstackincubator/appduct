/**
 * `@appduct/web`: lets an agent, test or terminal call functions inside a running web page. Import
 * it in the page; opening the link from `appduct_connect` (or running its script) claims a session
 * on the local daemon. This file is the composition root: it is the only place real browser
 * adapters are built.
 *
 * Without a browser (a server-side render, a build step that imports the page) every call does
 * nothing, so a page can import this unconditionally.
 */
import { createAppduct, createToolGroupFactory, type AppductCore } from "@appduct/shared/sdk";

import { createBrowserEnv } from "./browser/index.js";
import { createWebAppduct, type WebAppduct } from "./page/index.js";

const noSubscription = { remove() {} };

const noBrowser = (): Promise<never> =>
  Promise.reject(new Error("Appduct needs a browser: there is no page to connect here."));

/** The core for a render with no page: no session, nothing to resume, connecting is refused. */
const serverSideCore: AppductCore = {
  registerTool() {},
  unregisterTool() {},
  registerEvent() {},
  unregisterEvent() {},
  handleUrl: () => false,
  connect: noBrowser,
  restoreSession: async () => false,
  disconnect: async () => {},
  postEvent: async () => {},
  respondToToolCall() {},
  reportToolProgress() {},
  getState: () => "idle",
  getSessionId: () => null,
  getRegisteredToolsJson: () => "[]",
  addListener: () => noSubscription,
};

const serverSide: WebAppduct = {
  registerTool: () => noSubscription,
  registerEvent: () => noSubscription,
  postEvent: async () => {},
  disconnect: async () => {},
  getRegisteredTools: () => [],
  addAppductListener: () => noSubscription,
  getAppductState: () => "idle",
  connect: noBrowser,
  appductClient: createAppduct(serverSideCore).client,
  appductCore: serverSideCore,
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
  appductClient,
  appductCore,
} = appduct;

/** `registerTool` bound to one group, for a feature module that registers several tools. */
export const createToolGroup = createToolGroupFactory(registerTool);

export type { AppductSubscription } from "@appduct/shared/sdk";
