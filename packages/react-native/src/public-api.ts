import type { ToolDescriptor } from "@appduct/shared";
import type { DependencyList } from "react";

import type {
  AppductBuildConfig,
  AppductClientState,
  AppductConnectInput,
  AppductEventDefinition,
  AppductJsonSchemaObject,
  AppductListenerKind,
  AppductRuntimeSchema,
  AppductToolRegistration,
  AppductUnifiedListenerMap,
} from "./Appduct.types";
import type { UseAppductToolOptions } from "./useAppductTool";

export type AppductSubscription = { remove(): void };

/** `createToolGroup`'s result: `registerTool` with `group` bound (a registration passed to it
 * cannot set its own `group`). */
export type AppductToolGroupRegistrar = <
  TInputSchema extends AppductRuntimeSchema | undefined,
  TOutputSchema extends AppductRuntimeSchema | undefined,
>(
  registration: AppductToolRegistration<TInputSchema, TOutputSchema> & {
    group?: undefined;
  },
) => AppductSubscription;

/**
 * Public API surface shared by the `.` (real) and `./noop` (inert) entries (ARCHITECTURE.md §11).
 * Both entries are typed against this single interface so they cannot drift — see
 * `__tests__/noop-parity.test.ts`, which mirrors the pattern of `connect-options-parity.test.ts`.
 */
export type AppductPublicApi = {
  registerTool<
    TInputSchema extends AppductRuntimeSchema | undefined,
    TOutputSchema extends AppductRuntimeSchema | undefined,
  >(
    registration: AppductToolRegistration<TInputSchema, TOutputSchema>,
  ): AppductSubscription;

  /**
   * `registerTool` bound to one group (`"cart"`, or a subgroup like `"checkout/payment"`), so a
   * feature module registers its tools without repeating the group name on each one.
   */
  createToolGroup(group: string): AppductToolGroupRegistrar;

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

  /**
   * Declares an event the app posts so agents can list it. Advisory: `postEvent` still sends an
   * undeclared name, with a development warning.
   */
  registerEvent<TPayloadSchema extends AppductRuntimeSchema | undefined>(
    definition: AppductEventDefinition<TPayloadSchema>,
  ): AppductSubscription;

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

/**
 * The name this type shipped under before the product was called Appduct.
 *
 * @deprecated Use `AppductPublicApi`. The alias ships for one release and is then removed.
 */
export type CordierePublicApi = AppductPublicApi;
