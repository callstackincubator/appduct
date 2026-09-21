/** A method call against the daemon RPC — satisfied by both `callDaemon` (bound to a method+params)
 * and `DaemonStream.call` from `rpc/client.ts`. The MCP server's built-in tools take one of these
 * rather than a whole stream, so they can be tested against a fake. */
export type DaemonCall = <TResult>(method: string, params?: unknown) => Promise<TResult>;
