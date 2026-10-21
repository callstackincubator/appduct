import { link, waitForSession, type AppClient } from "appduct/client";

/** The Appduct daemon, as pairing uses it. */
export type Daemon = {
  /** A link that opens the app and pairs it, valid for `ttlSeconds`. */
  deviceLink(ttlSeconds: number): Promise<{ sessionId: string; deepLink: string }>;
  /** A link for the page at `url`, and the script that connects an open page to it. */
  webLink(url: string, ttlSeconds: number): Promise<{ sessionId: string; script: string }>;
  /** Resolves once the app claims `sessionId`; rejects with `"timeout"` after `timeoutMs`. */
  claim(sessionId: string, timeoutMs: number): Promise<AppClient>;
};

/** The daemon `appduct/client` reaches, started on first use. */
export const appductDaemon: Daemon = {
  deviceLink: (ttlSeconds) => link({ ttlSeconds }),
  webLink: (url, ttlSeconds) => link({ target: "web", url, ttlSeconds }),
  claim: (sessionId, timeoutMs) => waitForSession(sessionId, { timeoutMs }),
};
