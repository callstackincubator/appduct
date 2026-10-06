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
