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

/**
 * The same API as the real entry with no behaviour: nothing is registered, nothing connects and
 * `window.__APPDUCT__` is never touched. Only `connect()` speaks, once, because that is the call
 * someone makes while expecting a session.
 */
export const createInertAppduct = ({ warn }: InertPorts): WebAppduct => {
  let warned = false;
  return {
    registerTool: () => noopSubscription,
    registerEvent: () => noopSubscription,
    postEvent: async () => {},
    disconnect: async () => {},
    connect: async () => {
      if (warned) return;
      warned = true;
      warn(NOTICE);
    },
  };
};
