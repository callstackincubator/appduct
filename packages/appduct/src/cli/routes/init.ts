/** Route for `appduct init` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleInitCommand } from "../../commands/init.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;

  return executeCommand(
    commandName(context),
    () =>
      handleInitCommand(
        {
          scheme: typeof options.scheme === "string" ? options.scheme : undefined,
          force: Boolean(options.force),
        },
        // `init` never reads the state dir, but it must know which directory it is so it can
        // refuse to write a "safe to commit" project config into the daemon's own state.
        { stateDir },
      ),
    context.io,
  );
};
