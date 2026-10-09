/**
 * `@appduct/web` outside the `development` export condition: the same API as `./enabled` with no
 * session client, so a production bundle carries none of it. Import `@appduct/web/enabled` to
 * opt in.
 */
import { createToolGroupFactory } from "@appduct/shared/inert";

import { createInertAppduct } from "./inert/index.js";

const appduct = createInertAppduct({ warn: (message) => console.warn(message) });

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
