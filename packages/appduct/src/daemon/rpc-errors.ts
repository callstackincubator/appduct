/**
 * The error the daemon's RPC handlers throw to answer a request with a typed wire error
 * (ARCHITECTURE.md §5). It lives apart from `rpc-server.ts` so the modules that *raise* it — the
 * session engine, the call engine — don't drag the socket server itself into every bundle that
 * needs, say, a call-timeout constant from `calls.ts` (the CLI's `invoke` route does).
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
