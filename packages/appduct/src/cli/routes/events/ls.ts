/** Route for `appduct events ls` — loaded by `routes/events/index.ts`'s router only when it runs
 * (issue #124). Takes `--name <glob>` but not `--payload-max-bytes`, which only means something for
 * a posted event's payload. */

import type { Route } from "../../router.js";

import { handleEventsLsCommand } from "../../../commands/events-ls.js";
import { usageError } from "../../../errors.js";
import { readTextOption, splitOptionalSelector } from "../../command-options.js";
import { commandName } from "../../router.js";
import { executeCommand } from "../../runner.js";
import { guarded } from "../../version-guard.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;

  return executeCommand(
    commandName(context),
    // Argument parsing runs inside the handler so a usage error renders through the runner.
    () => {
      const { selector } = splitOptionalSelector(context.args, "events ls [selector]");

      if (options.payloadMaxBytes !== undefined) {
        throw usageError('"--payload-max-bytes" applies to events tail and events since, not events ls.');
      }

      const name = readTextOption(context.argv, options.name, "--name");

      return guarded(context)(() => handleEventsLsCommand({ selector, name }, { stateDir }))();
    },
    context.env,
  );
};
