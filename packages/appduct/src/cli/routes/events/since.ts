/** Route for `appduct events since` — loaded by `routes/events/index.ts`'s router only when it
 * runs (issue #96; replaces the removed `appduct events --since <cursor>` one-shot form). The
 * cursor is now a required positional rather than a flag, split out via
 * `splitSelectorAndRequiredTarget` exactly like `tools describe`/`tools call`. */

import type { EventNotification } from "@appduct/shared";

import type { Route } from "../../router.js";

import { handleEventsCommand } from "../../../commands/events.js";
import { renderEventLine, renderEventsCursorLine } from "../../../output.js";
import { parseNonNegativeIntegerOption, splitSelectorAndRequiredTarget } from "../../command-options.js";
import { commandName } from "../../router.js";
import { executeHostedCommand } from "../../runner.js";
import { guarded } from "../../version-guard.js";

export const route: Route = async (context) => {
  const { stateDir, env } = context;

  return executeHostedCommand(
    commandName(context),
    // Argument parsing runs inside the handler (not the route body) so `executeHostedCommand`'s
    // own try/catch renders a bad argument as a normal usage_error instead of an uncaught
    // rejection, and before the version check so a typo never waits on the daemon.
    () => {
      const { selector, target: cursorArg } = splitSelectorAndRequiredTarget(
        context.args,
        "events since [selector] <cursor>",
      );
      const since = parseNonNegativeIntegerOption(cursorArg, "<cursor>");

      return guarded(context)(() =>
        handleEventsCommand(
          { selector, since },
          {
            stateDir,
            onEvent: (event: EventNotification) => {
              env.stdout.write(`${renderEventLine(event, env.flags)}\n`);
            },
            onCursor: (cursor) => {
              env.stdout.write(`${renderEventsCursorLine(cursor, env.flags, selector)}\n`);
            },
          },
        ),
      )();
    },
    env,
    {
      kind: "interactive",
      onEvent: () => {},
      dispose: () => {},
    },
  );
};
