/** Route for `appduct events tail` — loaded by `routes/events/index.ts`'s router only when it
 * runs (issue #96; replaces the removed `appduct events` streaming form). `--follow` is accepted
 * (declared at the `events` noun level in `create-cli.ts`) but never read here: the default
 * behavior already follows, so the flag exists only for script readability. */

import type { EventNotification } from "@appduct/shared";

import type { Route } from "../../router.js";

import { handleEventsCommand } from "../../../commands/events.js";
import { renderEventLine } from "../../../output.js";
import { splitOptionalSelector } from "../../command-options.js";
import { commandName } from "../../router.js";
import { executeHostedCommand } from "../../runner.js";
import { guarded } from "../../version-guard.js";
import { parseEventsFilterFlags } from "./shared-options.js";

export const route: Route = async (context) => {
  const { stateDir, env } = context;

  return executeHostedCommand(
    commandName(context),
    // Argument parsing runs inside the handler (not the route body) so `executeHostedCommand`'s
    // own try/catch renders a bad argument as a normal usage_error instead of an uncaught
    // rejection, and before the version check so a typo never waits on the daemon.
    () => {
      const { selector } = splitOptionalSelector(context.args, "events tail [selector]");
      const { name, payloadMaxBytes } = parseEventsFilterFlags(context);

      return guarded(context)(() =>
        handleEventsCommand(
          { selector, name, payloadMaxBytes },
          {
            stateDir,
            onEvent: (event: EventNotification) => {
              env.stdout.write(`${renderEventLine(event, env.flags)}\n`);
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
