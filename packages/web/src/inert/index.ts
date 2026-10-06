import type { AppductClient, AppductCore } from "@appduct/shared/sdk";

import type { WebAppduct } from "../page/index.js";

export type InertPorts = {
  /** Where the one-time notice goes; the entry passes `console.warn`. */
  warn(message: string): void;
};

const NOTICE =
  "Appduct is inactive: this build resolved @appduct/web to its inert entry, so connect() does nothing. " +
  "Bundlers pick the real entry under the `development` export condition; if yours sets none, or this is a " +
  "staging build, import @appduct/web/enabled instead.";

const noopSubscription = { remove() {} };

/** What the real entry's `appductClient` does when nothing is connected, with nothing behind it. */
const createInertClient = (connect: () => Promise<void>) =>
  ({
    registerTool: () => noopSubscription,
    registerEvent: () => noopSubscription,
    unregisterTool() {},
    getRegisteredTools: () => [],
    restoreSession: async () => false,
    connect,
    postEvent: async () => {},
    close: async () => {},
    disconnect: async () => {},
    getState: () => "idle",
    getClientState: () => "idle",
    getSessionId: () => null,
    handleUrl: () => false,
    addAppductListener: () => noopSubscription,
    destroy() {},
  }) as unknown as AppductClient;

const createInertCore = (connect: () => Promise<void>): AppductCore => ({
  registerTool() {},
  unregisterTool() {},
  registerEvent() {},
  unregisterEvent() {},
  handleUrl: () => false,
  connect,
  restoreSession: async () => false,
  disconnect: async () => {},
  postEvent: async () => {},
  respondToToolCall() {},
  reportToolProgress() {},
  getState: () => "idle",
  getSessionId: () => null,
  getRegisteredToolsJson: () => "[]",
  addListener: () => noopSubscription,
});

/**
 * The same API as the real entry with no behaviour: nothing is registered, nothing connects and
 * `window.__APPDUCT__` is never touched. Only `connect()` speaks, once in total however it is
 * reached (React Native web goes through `appductClient.connect`), because that is the call
 * someone makes while expecting a session.
 */
export const createInertAppduct = ({ warn }: InertPorts): WebAppduct => {
  let warned = false;
  const connect = async () => {
    if (warned) return;
    warned = true;
    warn(NOTICE);
  };
  return {
    registerTool: () => noopSubscription,
    registerEvent: () => noopSubscription,
    postEvent: async () => {},
    disconnect: async () => {},
    getRegisteredTools: () => [],
    addAppductListener: () => noopSubscription,
    getAppductState: () => "idle",
    appductClient: createInertClient(connect),
    appductCore: createInertCore(connect),
    connect,
  };
};
