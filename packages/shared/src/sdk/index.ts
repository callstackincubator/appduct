/**
 * `@appduct/shared/sdk`: the TypeScript SDK layer every JS binding builds on. A binding (React
 * Native's TurboModule today) implements `AppductCore`; `createAppduct(core)` returns the client
 * that owns the handler map, Standard Schema to JSON Schema conversion, validation, and the
 * mapping of the core's JSON-string events onto the public listener surface. Never imports React;
 * the hook lives in `@appduct/shared/react`.
 */

import { createAppductClient } from "./client.js";
import type { AppductCore } from "./core.js";

export {
  createAppductClient,
  type AppductClient,
} from "./client.js";
export type {
  AppductCore,
  AppductNativeEvents,
  CreateAppductClientOptions,
} from "./core.js";
export { logger } from "./logger.js";
export { exportToolSchemaForKey } from "./schema.js";
export { createToolGroupFactory } from "./tool-group.js";
export * from "./types.js";

/** Wires the SDK layer onto a platform `core`. Constructing the client subscribes the core's
 * events immediately, so call it lazily when import-time side effects matter. */
export const createAppduct = (core: AppductCore) => ({
  client: createAppductClient(core),
});
