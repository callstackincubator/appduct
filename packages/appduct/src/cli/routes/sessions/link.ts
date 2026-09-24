/** Route for `appduct sessions link` — loaded by `routes/sessions/index.ts`'s router only when it
 * runs (issue #96; replaces the removed `appduct link`). */

import type { Route } from "../../router.js";

import { handleLinkCommand } from "../../../commands/link.js";
import { parsePositiveIntegerOption } from "../../command-options.js";
import { commandName } from "../../router.js";
import { executeCommand } from "../../runner.js";
import { guarded } from "../../version-guard.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;

  return executeCommand(
    commandName(context),
    guarded(context)(() =>
      handleLinkCommand(
        {
          ttlSeconds: parsePositiveIntegerOption(options.ttl, "--ttl"),
          scheme: typeof options.scheme === "string" ? options.scheme : undefined,
          open: typeof options.open === "string" ? options.open : undefined,
          device: typeof options.device === "string" ? options.device : undefined,
          // cac camelCases `--app-id`; the dashed spelling is kept as a fallback so a
          // parser change can't silently drop the flag.
          appId:
            typeof options.appId === "string"
              ? options.appId
              : typeof options["app-id"] === "string"
                ? options["app-id"]
                : undefined,
          // Left `undefined` when absent rather than coerced to `false`, so that
          // "--relaunch only applies with --open ios-device" fires on the flag actually being
          // passed and not on every `link` invocation.
          relaunch: options.relaunch === true ? true : undefined,
        },
        { stateDir },
      ),
    ),
    context.env,
    { qr: Boolean(options.qr) },
  );
};
