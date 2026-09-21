/** Route for `appduct tools` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import { isValidToolGroup } from "@appduct/shared";

import type { Route } from "../router.js";

import { handleToolsCommand } from "../../commands/tools.js";
import { usageError } from "../../errors.js";
import {
  parseNonNegativeIntegerOption,
  parsePositiveIntegerOption,
  readTextOption,
  splitOptionalSelectorAndTarget,
} from "../command-options.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";
import { guarded } from "../version-guard.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;

  return executeCommand(
    commandName(context),
    // Argument parsing runs inside the handler so a usage error renders through the runner (exit
    // 64, `--json` envelope) instead of escaping the route as an uncaught rejection, and before
    // the version check so a typo never waits on (or restarts) the daemon.
    () => {
      const { selector, target, selectorOrTarget } = splitOptionalSelectorAndTarget(
        context.args,
        "tools [selector] [name]",
      );
      const limit = parsePositiveIntegerOption(options.limit, "--limit");
      const offset = parseNonNegativeIntegerOption(options.offset, "--offset");
      const filter = readTextOption(context.argv, options.filter, "--filter");
      const group = readTextOption(context.argv, options.group, "--group");

      // Checked here, not only by the daemon, so a malformed group is a usage error (exit 64)
      // that never waits on the daemon — the same rule the daemon's `tools.list` applies.
      if (group !== undefined && !isValidToolGroup(group)) {
        throw usageError(
          `"--group" must be a group name like "checkout" or "checkout/payment" (one or two "/"-separated segments of [a-zA-Z0-9_-], at most 64 characters each); got ${JSON.stringify(group)}.`,
        );
      }

      const groups = options.groups === undefined ? undefined : Boolean(options.groups);

      if (groups && options.full) {
        throw usageError('"--groups" lists groups only and cannot be combined with "--full".');
      }

      return guarded(context)(() =>
        handleToolsCommand(
          { selector: selector ?? selectorOrTarget, name: target, group, groups, filter, limit, offset },
          { stateDir },
        ),
      )();
    },
    context.env,
    { full: Boolean(options.full) },
  );
};
