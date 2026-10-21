import { jsonSchema, tool } from "ai";
import { defineTool } from "e2e/agent";

import type { Appduct } from "./session.js";

/** The session of the running test. e2e runs one test at a time in a worker. */
let current: Appduct | undefined;

/** Points the agent tools at `session` until the returned function is called. */
export const offerToAgent = (session: Appduct): (() => void) => {
  current = session;
  return () => {
    if (current === session) current = undefined;
  };
};

const session = (): Appduct => {
  if (!current) throw new Error("No Appduct session in this test. Write the test with a `test` from `withAppduct`.");
  return current;
};

/**
 * Tools for e2e's agent that call the tools the app registered with Appduct. Add them to an
 * agent's `tools` in `e2e.config.ts`; they work in tests written with a `test` from `withAppduct`.
 */
export const appductTools = () => ({
  appduct_tools: defineTool(
    tool({
      description:
        "List the tools the app under test registered with Appduct: what each one does and the arguments it takes. Use one with appduct_call to read or set app state directly instead of through the screen.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: () => session().tools(),
    }),
    { mutates: false },
  ),
  appduct_call: defineTool(
    tool({
      description: "Call a tool the app under test registered with Appduct and get its result. List the tools with appduct_tools first.",
      inputSchema: jsonSchema<{ name: string; args?: Record<string, unknown> }>({
        type: "object",
        properties: {
          name: { type: "string", description: "The tool's name, as appduct_tools lists it." },
          args: { type: "object", description: "The tool's arguments, matching its input schema." },
        },
        required: ["name"],
        additionalProperties: false,
      }),
      execute: ({ name, args }) => session().call(name, args),
    }),
    // A tool may change app state, which e2e cannot replay from its cache.
    { mutates: true },
  ),
});
