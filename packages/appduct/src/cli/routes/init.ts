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
          // cac camelCases `--ios-app-id`/`--android-app-id`; the dashed spellings are kept as a
          // fallback so a parser change can't silently drop the flag.
          iosAppId:
            typeof options.iosAppId === "string"
              ? options.iosAppId
              : typeof options["ios-app-id"] === "string"
                ? options["ios-app-id"]
                : undefined,
          androidAppId:
            typeof options.androidAppId === "string"
              ? options.androidAppId
              : typeof options["android-app-id"] === "string"
                ? options["android-app-id"]
                : undefined,
        },
        // `init` never reads the state dir, but it must know which directory it is so it can
        // refuse to write a "safe to commit" project config into the daemon's own state.
        { stateDir },
      ),
    context.env,
  );
};
