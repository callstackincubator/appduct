/** What the relay needs from outside the process. Each port has a memory fake beside it. */

/** The page the session runs in, as the relay sees it. A Playwright `Page` is adapted to this by `attachPage`. */
export type PageChannel = {
  /** Calls the page makes to its exposed binding, as the JSON string it passed. */
  onBindingCall(handler: (json: string) => void): void;
  /** Runs an expression in the page's current document. Rejects when there is none. */
  evaluate(expression: string): Promise<unknown>;
  /** A document was destroyed or replaced: a reload, a navigation to another document, or the page closing. */
  onContextReset(handler: () => void): void;
};

export type DaemonSocketEvents = {
  open(): void;
  message(text: string): void;
  close(code: number, reason: string): void;
};

export type DaemonSocket = {
  send(text: string): void;
  close(code: number, reason: string): void;
};

/** Opens a WebSocket to the daemon's web listener, with no `Origin`. */
export type OpenDaemonSocket = (url: string, events: DaemonSocketEvents) => DaemonSocket;

/** A tab the browser lists. */
export type DevtoolsTarget = {
  /** The CDP target id, stable for the life of the tab. */
  id: string;
  url: string;
  title: string;
};

/** A tab opened for relaying: the page channel plus the way to let go of it. */
export type DevtoolsPage = PageChannel & {
  /** Drops the tab's binding connection. The page keeps running; it just has no relay. */
  close(): void;
};

/** A Chromium launched with `--remote-debugging-port`, as the daemon sees it. */
export type DevtoolsBrowser = {
  /** The open tabs, in the order the browser lists them. Rejects when the browser cannot be reached. */
  targets(): Promise<DevtoolsTarget[]>;
  /**
   * Opens the tab for relaying: `window.__appductBinding(json)` exists in its current document and in
   * every later one, and `onContextReset` fires when its document is destroyed or the tab closes.
   * Opening a tab that is already open drops the earlier connection.
   */
  openPage(targetId: string): Promise<DevtoolsPage>;
  /** Drops every connection `openPage` made. */
  close(): void;
};

/** Reaches the browser whose debugging endpoint is `browserUrl`, such as `http://127.0.0.1:9222`. */
export type ConnectDevtoolsBrowser = (browserUrl: string) => DevtoolsBrowser;
