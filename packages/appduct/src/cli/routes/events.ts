/** Route for `appduct events` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { EventNotification } from "@appduct/shared";

import type { Route } from "../router.js";

import { handleEventsCommand } from "../../commands/events.js";
import { usageError } from "../../errors.js";
import { renderEventLine, renderEventsCursorLine } from "../../output.js";
import { parseNonNegativeIntegerOption, splitOptionalSelector } from "../command-options.js";
import { commandName } from "../router.js";
import { executeHostedCommand } from "../runner.js";
import { guarded } from "../version-guard.js";

export const route: Route = async (context) => {
  const { options, stateDir, env } = context;
  const follow = Boolean(options.follow);

  return executeHostedCommand(
    commandName(context),
    // All argument parsing happens inside the handler (not the route body) so
    // `executeHostedCommand`'s own try/catch renders a bad argument as a normal usage_error
    // instead of an uncaught rejection, and before the version check so a typo never waits on
    // the daemon.
    () => {
      const { selector } = splitOptionalSelector(context.args, "events [selector]");
      const since = parseNonNegativeIntegerOption(options.since, "--since");

      if (since !== undefined && follow) {
        throw usageError('"--since" is a one-shot pull and cannot be combined with "--follow".');
      }

      return guarded(context)(() =>
        handleEventsCommand(
          { selector, since },
          {
            stateDir,
            onEvent: (event: EventNotification) => {
              env.stdout.write(`${renderEventLine(event, env.flags)}\n`);
            },
            onCursor: (cursor) => {
              env.stdout.write(`${renderEventsCursorLine(cursor, env.flags)}\n`);
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
