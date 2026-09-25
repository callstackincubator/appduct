/**
 * `appduct/client` (issue #8): a first-class programmatic client for test runners — a thin typed
 * wrapper over the same daemon RPC the CLI and MCP server use, so a Jest/Vitest/Detox spec can
 * `connect()`/`call()` instead of spawning `appduct tools call ... --json` and parsing stdout.
 *
 * ```ts
 * import { connect } from "appduct/client";
 *
 * const app = await connect();
 * const { total } = await app.call("sum", { a: 2, b: 3 });
 * await app.close();
 * ```
 */
export { connect, type ConnectOptions } from "./connect.js";
export { link, waitForSession, type LinkOptions, type LinkResult, type WaitForSessionOptions } from "./bootstrap.js";
export { AppductError, type AppductErrorType } from "./errors.js";
export type {
  AppClient,
  AppEvent,
  CallOptions,
  EventsOptions,
  EventsResult,
  ToolMap,
  WaitForEventOptions,
} from "./app-client.js";
export type { AgentEndpoint, ErrorType, ListedToolDescriptor, ToolDescriptor } from "@appduct/shared";
