import type {
  AppductRuntimeSchema,
  AppductToolRegistration,
} from "./Appduct.types";
import type {
  AppductSubscription,
  AppductToolGroupRegistrar,
} from "./public-api";

type ToolRegistrar = <
  TInputSchema extends AppductRuntimeSchema | undefined,
  TOutputSchema extends AppductRuntimeSchema | undefined,
>(
  registration: AppductToolRegistration<TInputSchema, TOutputSchema>,
) => AppductSubscription;

/**
 * Builds `createToolGroup` on top of a `registerTool` implementation, the same way
 * `createUseAppductTool` builds the hook: the real (`.`) and inert (`./noop`) entries each pass
 * their own registrar, so the two cannot drift.
 *
 * The group is not validated here: the real registrar hands the descriptor to native, which
 * validates it (PROTOCOL.md §5) and throws synchronously on a malformed group at registration —
 * the same place a malformed `name` surfaces — while the inert registrar accepts anything. An
 * eager check here would make the root entry throw where `./noop` does not.
 */
export const createToolGroupFactory = (registerTool: ToolRegistrar) => {
  return (group: string): AppductToolGroupRegistrar => {
    return (registration) => registerTool({ ...registration, group });
  };
};
