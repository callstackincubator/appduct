/** Route for `appduct link` — loaded by `cli/dispatch.ts`'s router only when it runs. */

import type { Route } from "../router.js";

import { handleLinkCommand } from "../../commands/link.js";
import { parsePositiveIntegerOption } from "../command-options.js";
import { commandName } from "../router.js";
import { executeCommand } from "../runner.js";

export const route: Route = async (context) => {
  const { options, stateDir } = context;

  return executeCommand(
    commandName(context),
    context.guarded(() =>
      handleLinkCommand(
        {
          ttlSeconds: parsePositiveIntegerOption(options.ttl, "--ttl"),
          scheme: typeof options.scheme === "string" ? options.scheme : undefined,
          open: typeof options.open === "string" ? options.open : undefined,
          device: typeof options.device === "string" ? options.device : undefined,
          // cac camelCases `--bundle-id`; the dashed spelling is kept as a fallback so a
          // parser change can't silently drop the flag.
          bundleId:
            typeof options.bundleId === "string"
              ? options.bundleId
              : typeof options["bundle-id"] === "string"
                ? options["bundle-id"]
                : undefined,
          // Left `undefined` when absent rather than coerced to `false`, so that
          // "--relaunch only applies with --open ios-device" fires on the flag actually being
          // passed and not on every `link` invocation.
          relaunch: options.relaunch === true ? true : undefined,
        },
        { stateDir },
      ),
    ),
    {
      ...context.io,
      qr: Boolean(options.qr),
    },
  );
};
