/** Route for `appduct invoke` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleInvokeCommand } from "../../commands/invoke.js";
import {
  parseJsonInputOption,
  parsePositiveIntegerOption,
  splitSelectorAndRequiredTarget,
} from "../command-options.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;
  const { selector, target: tool } = splitSelectorAndRequiredTarget(
    context.args,
    "invoke [selector] <tool> --input '<json>'",
  );

  // SIGINT cancels the in-flight tools.call rather than leaving it running unowned in the app
  // (issue #9) — the listener is torn down once the command settles either way.
  const cancelController = new AbortController();
  const onSigint = (): void => cancelController.abort();
  process.once("SIGINT", onSigint);

  try {
    return await executeCommand(
      commandName(context),
      context.guarded(() =>
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
      ),
      context.io,
    );
  } finally {
    process.off("SIGINT", onSigint);
  }
};
