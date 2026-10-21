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

/**
 * Pairs with `pair` on first use and again whenever the session has gone, as it does when the
 * test relaunches the app or reloads the page.
 */
export const createSession = (pair: () => Promise<AppClient>, clock: Clock): Appduct & { close(): void } => {
  let pairing: Promise<AppClient> | undefined;

  const forget = (stale: Promise<AppClient>) => {
    if (pairing === stale) pairing = undefined;
  };

  const paired = (): Promise<AppClient> => {
    if (!pairing) {
      const attempt = pair();
      attempt.catch(() => forget(attempt)); // so the next use pairs again
      pairing = attempt;
    }
    return pairing;
  };

  /** Runs `use` on the paired client, pairing once more if the session has gone. */
  const withClient = async <T>(use: (client: AppClient) => Promise<T>): Promise<T> => {
    const current = paired();
    const client = await current;
    try {
      return await use(client);
    } catch (error) {
      if (!isGone(error)) throw error;
      client.close();
      forget(current);
      return use(await paired());
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
    close: () => {
      pairing?.then((client) => client.close(), () => undefined);
      pairing = undefined;
    },
  };
};
