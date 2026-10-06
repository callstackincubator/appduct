/** `@appduct/web/react`: the `useAppductTool` hook. `react` is an optional peer dependency. */
import { createUseAppductTool } from "@appduct/shared/react";
import { exportToolSchemaForKey } from "@appduct/shared/sdk";

import { registerTool } from "../index.js";

export type { UseAppductToolOptions } from "@appduct/shared/react";

/** Registers a tool for the lifetime of the component and re-registers only when its definition changes. */
export const useAppductTool = createUseAppductTool(registerTool, { exportSchema: exportToolSchemaForKey });
