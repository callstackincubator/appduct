export type ConnectOptions = {
  /** `"devtools"` carries the session over the binding `attachPage` installs, not a `WebSocket`. */
  transport?: "devtools";
};

/** What the entry needs from the loaded page: its address, a way to rewrite the address without
 * reloading, and a place to publish `window.__APPDUCT__`. The browser adapter wraps `window`. */
export type PageEnv = {
  /** `location.href`. */
  href(): string;
  /** `history.replaceState`: changes the address bar without reloading or adding a history entry. */
  replaceUrl(url: string): void;
  /** Publishes `window.__APPDUCT__.connect`. */
  exposeConnect(connect: (link: string, options?: ConnectOptions) => Promise<void>): void;
};

export type MemoryPage = PageEnv & {
  /** The script an agent runs on a page that is already loaded. */
  readonly connect: ((link: string, options?: ConnectOptions) => Promise<void>) | undefined;
  /** How many times `replaceUrl` ran. */
  readonly replaceCount: number;
};

export const createMemoryPage = (href: string): MemoryPage => {
  let current = href;
  let replaceCount = 0;
  let connect: ((link: string, options?: ConnectOptions) => Promise<void>) | undefined;
  return {
    href: () => current,
    replaceUrl: (url) => {
      current = url;
      replaceCount += 1;
    },
    exposeConnect: (fn) => {
      connect = fn;
    },
    get connect() {
      return connect;
    },
    get replaceCount() {
      return replaceCount;
    },
  };
};
