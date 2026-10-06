import type { WebCorePorts } from "../core/index.js";
import type { PageEnv } from "../page/index.js";
import { createDevtoolsBindingTransport } from "./devtools-binding.js";
import { createBrowserTransport } from "./browser-transport.js";
import { createSessionStorageStore } from "./session-storage-store.js";

const browserName = (userAgent: string): string =>
  /Edg\//u.test(userAgent)
    ? "Edge"
    : /Chrome\//u.test(userAgent)
      ? "Chrome"
      : /Firefox\//u.test(userAgent)
        ? "Firefox"
        : /Safari\//u.test(userAgent)
          ? "Safari"
          : "Browser";

export { createDevtoolsBindingTransport } from "./devtools-binding.js";

type AppductWindow = {
  __appductBinding?: (json: string) => void;
  __APPDUCT__?: Record<string, unknown>;
};

/** The real adapters for the page this script runs in. Only the entry point calls it. */
export const createBrowserEnv = (): { ports: WebCorePorts; page: PageEnv } => {
  const global = window as unknown as AppductWindow;
  const devtools = createDevtoolsBindingTransport((json) => {
    if (typeof global.__appductBinding !== "function") {
      throw new Error(
        "The devtools transport needs a relay: call attachPage(page, { link }) from appduct/client.",
      );
    }
    global.__appductBinding(json);
  });
  global.__APPDUCT__ = { receive: devtools.receive };

  return {
    ports: {
      transport: createBrowserTransport(),
      devtoolsTransport: devtools.transport,
      sessionStore: createSessionStorageStore(),
      clock: {
        now: () => Date.now(),
        setTimeout: (run, ms) => setTimeout(run, ms),
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      random: () => Math.random(),
      device: {
        manufacturer: navigator.vendor || "Browser",
        model: browserName(navigator.userAgent),
        os: navigator.platform,
      },
    },
    page: {
      href: () => location.href,
      replaceUrl: (url) => history.replaceState(history.state, "", url),
      exposeConnect: (connect) => {
        global.__APPDUCT__ = { ...global.__APPDUCT__, connect };
      },
    },
  };
};
