/**
 * `@appduct/web/enabled`: the real entry. Lets an agent, test or terminal call functions inside a running web page. Import
 * it in the page; opening the link from `appduct_connect` (or running its script) claims a session
 * on the local daemon. This file is the composition root: it is the only place real browser
 * adapters are built.
 */
import { createBrowserEnv } from "./browser/index.js";
import { createWebAppduct } from "./page/index.js";

const appduct = createWebAppduct(createBrowserEnv());

export const { registerTool, registerEvent, postEvent, connect, disconnect } = appduct;
