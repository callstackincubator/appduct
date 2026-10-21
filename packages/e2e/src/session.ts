import { AppductError, type AppClient, type CallOptions, type FullAppEvent, type ListedToolDescriptor, type WaitForEventOptions } from "appduct/client";

/** The app's Appduct session in one e2e test, paired the first time a test or agent step uses it. */
export type Appduct = {
  /** Calls a tool the app registered, waiting up to 10 s for a tool the app has not registered yet. */
  call(name: string, args?: Record<string, unknown>, options?: CallOptions): Promise<unknown>;
  /** The tools the app registered, waiting up to 10 s for the app to register its first. */
  tools(): Promise<ListedToolDescriptor[]>;
  /** Resolves with the next event the app posts under `name`. */
  waitForEvent<TPayload = unknown>(name: string, options?: EventWait): Promise<FullAppEvent<TPayload>>;
};

/** How long to wait and which events count; the payload always arrives in full. */
export type EventWait = Omit<WaitForEventOptions, "payloadMaxBytes">;

export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

/** An app registers its tools just after it claims a session, and a screen may register more as it opens. */
const TOOL_WAIT_MS = 10_000;
const POLL_MS = 50;

const isGone = (error: unknown): boolean =>
  error instanceof AppductError &&
  (error.type === "session_suspended" || error.type === "session_not_active" || error.type === "unknown_session");

/** Ends a session that is no longer worth keeping. The daemon may have forgotten it already. */
const discard = (client: AppClient): void => {
  void client.revoke().catch(() => undefined);
  client.close();
};

/**
 * The worker's Appduct session, kept across tests: e2e runs one test at a time in a worker, and a
 * test that leaves the app running hands the next one an app that is still connected.
 */
export const createSessions = (clock: Clock) => {
  let kept: AppClient | undefined;

  /** The kept session while the app is still connected to it, else a newly paired one. */
  const resume = async (pair: () => Promise<AppClient>): Promise<AppClient> => {
    const previous = kept;
    kept = undefined;
    if (previous) {
      // Anything but `active` means the app went away: relaunched, reloaded or closed.
      if ((await previous.state().catch(() => undefined)) === "active") return (kept = previous);
      discard(previous);
    }
    return (kept = await pair());
  };

  /**
   * One test's view of the session. It connects on first use, reusing the kept session when it can,
   * and pairs again once if the session goes away during the test.
   */
  const forTest = (pair: () => Promise<AppClient>): Appduct => {
    let current: Promise<AppClient> | undefined;

    const connected = (): Promise<AppClient> => {
      if (!current) {
        const attempt = resume(pair);
        attempt.catch(() => {
          if (current === attempt) current = undefined; // so the next use tries again
        });
        current = attempt;
      }
      return current;
    };

    const withClient = async <T>(use: (client: AppClient) => Promise<T>): Promise<T> => {
      const attempt = connected();
      const client = await attempt;
      try {
        return await use(client);
      } catch (error) {
        if (!isGone(error)) throw error;
        if (current === attempt) current = undefined; // a concurrent call may have reconnected already
        return use(await connected());
      }
    };

    return {
      call: async (name, args = {}, options) => {
        const deadline = clock.now() + TOOL_WAIT_MS;
        for (;;) {
          try {
            return await withClient((client) => client.call(name, args, options));
          } catch (error) {
            const missing = error instanceof AppductError && error.type === "tool_not_found";
            if (!missing || clock.now() >= deadline) throw error;
            await clock.sleep(POLL_MS);
          }
        }
      },
      tools: async () => {
        const deadline = clock.now() + TOOL_WAIT_MS;
        for (;;) {
          const tools = await withClient((client) => client.tools());
          if (tools.length > 0 || clock.now() >= deadline) return tools;
          await clock.sleep(POLL_MS);
        }
      },
      waitForEvent: <TPayload>(name: string, options?: EventWait) =>
        withClient((client) => client.waitForEvent<TPayload>(name, options)),
    };
  };

  return { forTest };
};
