/** Route for `appduct mcp` — loaded by `cli/dispatch.ts`'s router only when it runs. This is the
 * one route whose module graph is large (the MCP SDK and its schema libraries); it is a
 * long-lived server, so that cost is paid once per session rather than per command. */

import type { Route } from "../router.js";

import { handleMcpCommand } from "../../commands/mcp.js";
import { commandName } from "../router.js";
import { executeHostedCommand } from "../runner.js";
import { versionCheckOptions } from "../version-guard.js";

export const route: Route = async (context) => {
  const { options, stateDir, env } = context;

  return executeHostedCommand(
    commandName(context),
    // Unlike every other command the check is threaded into the server itself, not run ahead
    // of it: the MCP server is long-lived and auto-spawns its own daemon, so the check belongs
    // on the startup stream that establishes the connection it keeps (ARCHITECTURE.md §9).
    // The notice always goes to stderr here, `--json` or not: stdout carries MCP protocol
    // frames, and stderr is this server's only log channel (ARCHITECTURE.md §9).
    async () =>
      handleMcpCommand({
        stateDir,
        scheme: typeof options.scheme === "string" ? options.scheme : undefined,
        checkVersion: await versionCheckOptions(context, (message) => void env.stderr.write(message)),
      }),
    env,
    {
      kind: "interactive",
      onEvent: () => {},
      dispose: () => {},
    },
  );
};
