/**
 * The error the daemon's RPC handlers throw to answer a request with a typed wire error
 * (ARCHITECTURE.md §5). It lives apart from `rpc-server.ts` so the modules that *raise* it — the
 * session engine, the call engine — don't drag the socket server itself into every bundle that
 * needs, say, a call-timeout constant from `calls.ts` (the CLI's `tools call` route does).
 */

import type { ErrorType } from "@appduct/shared";

export class RpcApplicationError extends Error {
  constructor(
    readonly type: ErrorType,
    message: string,
    /** JSON-RPC error code; defaults to the shared "server error" range. */
    readonly code = -32000,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RpcApplicationError";
  }
}

/** The `session_suspended` message for an app that closed its socket because it went to the
 * background: says why and how to recover. */
export const appBackgroundedMessage = (alias: string): string =>
  `Session "${alias}" is suspended because the app is in the background. Bring the app to the foreground to resume it.`;

/** The `session_suspended` message for a call that was pending when the app reconnected on a new
 * socket: the app dropped the call with the old socket, so its result is lost. */
export const appReconnectedMessage = (alias: string): string =>
  `Session "${alias}" reconnected while the call was pending, so its result was lost. The call can be retried.`;
