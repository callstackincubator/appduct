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
  const { options, stateDir, io } = context;
  const { selector } = splitOptionalSelector(context.args, "events [selector]");
  const since = parseNonNegativeIntegerOption(options.since, "--since");
  const follow = Boolean(options.follow);
  const render = { json: io.json, color: io.color };

  return executeHostedCommand(
    commandName(context),
    guarded(context)(() => {
      // Deferred into the wrapped handler (rather than thrown directly in the route body,
      // matching the codebase's existing lax convention for that) so `executeHostedCommand`'s
      // own try/catch renders it as a normal usage_error instead of an uncaught rejection.
      if (since !== undefined && follow) {
        throw usageError('"--since" is a one-shot pull and cannot be combined with "--follow".');
      }

      return handleEventsCommand(
        { selector, since },
        {
          stateDir,
          onEvent: (event: EventNotification) => {
            io.stdout.write(`${renderEventLine(event, render)}\n`);
          },
          onCursor: (cursor) => {
            io.stdout.write(`${renderEventsCursorLine(cursor, render)}\n`);
          },
        },
      );
    }),
    {
      ...io,
      reporter: {
        kind: "interactive",
        onEvent: () => {},
        dispose: () => {},
      },
    },
  );
};
