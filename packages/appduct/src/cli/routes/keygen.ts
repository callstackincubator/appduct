/** Route for `appduct keygen` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleKeygenCommand } from "../../commands/keygen.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;

  return executeCommand(
    commandName(context),
    () =>
      handleKeygenCommand(
        {
          out: typeof options.out === "string" ? options.out : undefined,
          force: Boolean(options.force),
        },
        { stateDir },
      ),
    context.env,
  );
};
