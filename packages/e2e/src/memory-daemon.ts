import type { AppClient } from "appduct/client";

import type { Daemon } from "./daemon.js";

type Claim = { promise: Promise<AppClient>; resolve(client: AppClient): void; reject(error: unknown): void };

/** A daemon in memory: the test decides when an app claims a link or a claim wait runs out. */
export const createMemoryDaemon = () => {
  const claims = new Map<string, Claim>();
  const links: { sessionId: string; ttlSeconds: number; url?: string }[] = [];
  const claimTimeouts = new Map<string, number>();

  const claimOf = (sessionId: string): Claim => {
    let claim = claims.get(sessionId);
    if (!claim) {
      let resolve!: (client: AppClient) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<AppClient>((res, rej) => ((resolve = res), (reject = rej)));
      promise.catch(() => undefined); // a claim nobody waits for must not fail the test run
      claim = { promise, resolve, reject };
      claims.set(sessionId, claim);
    }
    return claim;
  };

  const daemon: Daemon = {
    deviceLink: async (ttlSeconds) => {
      const sessionId = `s${links.length + 1}`;
      links.push({ sessionId, ttlSeconds });
      return { sessionId, deepLink: `myapp:///?appduct=${sessionId}` };
    },
    webLink: async (url, ttlSeconds) => {
      const sessionId = `s${links.length + 1}`;
      links.push({ sessionId, ttlSeconds, url });
      return { sessionId, script: `connect("${sessionId}")` };
    },
    claim: (sessionId, timeoutMs) => {
      claimTimeouts.set(sessionId, timeoutMs);
      return claimOf(sessionId).promise;
    },
  };

  return {
    daemon,
    /** Every link minted, oldest first. */
    links,
    /** The `timeoutMs` each claim wait was given. */
    claimTimeouts,
    /** The app claims `sessionId`, before or after anyone waits for it. */
    appClaims: (sessionId: string, client: AppClient) => claimOf(sessionId).resolve(client),
    /** The wait for `sessionId` runs out. */
    expire: (sessionId: string, error: unknown) => claimOf(sessionId).reject(error),
  };
};
