import type { ToolDescriptor } from "@appduct/shared";
import type { DependencyList } from "react";

import type {
  AppductBuildConfig,
  AppductClientState,
  AppductConnectInput,
  AppductJsonSchemaObject,
  AppductListenerKind,
  AppductRuntimeSchema,
  AppductToolRegistration,
  AppductUnifiedListenerMap,
} from "./Appduct.types";
import type { UseAppductToolOptions } from "./useAppductTool";

export type AppductSubscription = { remove(): void };

/**
 * Public API surface shared by the `.` (real) and `./noop` (inert) entries (ARCHITECTURE.md §11).
 * Both entries are typed against this single interface so they cannot drift — see
 * `__tests__/noop-parity.test.ts`, which mirrors the pattern of `connect-options-parity.test.ts`.
 */
export type CordierePublicApi = {
  registerTool<
    TInputSchema extends AppductRuntimeSchema | undefined,
    TOutputSchema extends AppductRuntimeSchema | undefined,
  >(
    registration: AppductToolRegistration<TInputSchema, TOutputSchema>,
  ): AppductSubscription;

  useAppductTool<
    TInputSchema extends AppductRuntimeSchema | undefined,
    TOutputSchema extends AppductRuntimeSchema | undefined,
  >(
    definition: AppductToolRegistration<TInputSchema, TOutputSchema>,
    deps?: DependencyList,
    options?: UseAppductToolOptions,
  ): void;

  /** Type-only helper for raw JSON Schema tool schemas; identity at runtime. */
  jsonSchema<T = Record<string, unknown>>(
    schema: Record<string, unknown>,
  ): AppductJsonSchemaObject<T>;

  postEvent(name: string, payload?: unknown): Promise<void>;

  getRegisteredTools(): ToolDescriptor[];

  addAppductListener<Kind extends AppductListenerKind>(
    kind: Kind,
    callback: AppductUnifiedListenerMap[Kind],
  ): AppductSubscription;

  restoreSession(): Promise<boolean>;

  getAppductState(): AppductClientState;

  connect(input: AppductConnectInput): Promise<void>;

  getAppductBuildConfig(): AppductBuildConfig;
};
