import type { WebCorePorts } from "../core/index.js";
import type { PageEnv } from "../page/index.js";
import { createBrowserTransport } from "./browser-transport.js";
import { createSessionStorageStore } from "./session-storage-store.js";

const browserName = (userAgent: string): string =>
  /Edg\//u.test(userAgent) ? "Edge" : /Chrome\//u.test(userAgent) ? "Chrome" : /Firefox\//u.test(userAgent) ? "Firefox" : /Safari\//u.test(userAgent) ? "Safari" : "Browser";

/** The real adapters for the page this script runs in. Only the entry point calls it. */
export const createBrowserEnv = (): { ports: WebCorePorts; page: PageEnv } => ({
  ports: {
    transport: createBrowserTransport(),
    sessionStore: createSessionStorageStore(),
    clock: {
      now: () => Date.now(),
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    random: () => Math.random(),
    device: { manufacturer: navigator.vendor || "Browser", model: browserName(navigator.userAgent), os: navigator.platform },
  },
  page: {
    href: () => location.href,
    replaceUrl: (url) => history.replaceState(history.state, "", url),
    exposeConnect: (connect) => {
      (window as unknown as { __APPDUCT__: { connect: typeof connect } }).__APPDUCT__ = { connect };
    },
  },
});
