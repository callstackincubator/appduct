/** Route for `appduct tools call` — loaded by `routes/tools/index.ts`'s router only when it runs
 * (issue #96; replaces the removed `appduct invoke`). */

import type { Route } from "../../router.js";

import { handleInvokeCommand } from "../../../commands/invoke.js";
import {
  parseJsonInputOption,
  parsePositiveIntegerOption,
  splitSelectorAndRequiredTarget,
} from "../../command-options.js";
import { commandName } from "../../router.js";
import { executeCommand } from "../../runner.js";
import { guarded } from "../../version-guard.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;

  // SIGINT cancels the in-flight tools.call rather than leaving it running unowned in the app
  // (issue #9) — the listener is torn down once the command settles either way.
  const cancelController = new AbortController();
  const onSigint = (): void => cancelController.abort();
  process.once("SIGINT", onSigint);

  try {
    return await executeCommand(
      commandName(context),
      // Positionals are split inside the handler so a missing `<name>` renders through the runner
      // as a usage error instead of escaping the route as an uncaught rejection.
      () => {
        const { selector, target: tool } = splitSelectorAndRequiredTarget(
          context.args,
          "tools call [selector] <name> --input '<json>'",
        );

        return guarded(context)(() =>
          handleInvokeCommand(
            {
              selector,
              tool,
              args: parseJsonInputOption(typeof options.input === "string" ? options.input : undefined),
              timeoutMs: parsePositiveIntegerOption(options.timeout, "--timeout"),
            },
            { stateDir },
            cancelController.signal,
          ),
        )();
      },
      context.env,
    );
  } finally {
    process.off("SIGINT", onSigint);
  }
};
