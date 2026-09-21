/**
 * `appduct tools` (ARCHITECTURE.md §10): `tools [selector] [--full] [--filter <text>] [--limit
 * <n>] [--offset <n>]` lists tools for a session; `tools [selector] <name>` shows one tool's full
 * schema/annotations.
 *
 * The command table gives both forms a leading optional `[selector]`, which makes a single
 * positional argument inherently ambiguous (is it the selector, or the tool name in `tools <name>`
 * with the selector omitted?). This resolves it the same way a human reading the table would:
 * first try the arg as a tool name in the implicit-selector session's registry; if no such tool
 * exists there (or the implicit selector doesn't resolve, e.g. `ambiguous_session`), fall back to
 * treating it as a selector and list that session's tools instead.
 *
 * `--filter`/`--limit`/`--offset` only ever reach the daemon on a *listing* request: the detail
 * path (an explicit `<name>`, or the ambiguous single-arg probe above) always asks for the whole,
 * unpaged registry, so a name lookup can never miss a tool that paging would have left off a page.
 */

import { RPC_METHODS, type ToolDescriptor, type ToolsListResult } from "@appduct/shared";

import type { CliResult, ToolsCommandData, ToolsListing } from "../cli/result-types.js";
import { usageError } from "../errors.js";
import { callDaemon, DaemonRpcError, type SpawnFn } from "../rpc/client.js";

export type ToolsCommandOptions = {
  selector?: string;
  name?: string;
  /** Case-insensitive substring match against name and description. Listing only. */
  filter?: string;
  /** Page size. Listing only. */
  limit?: number;
  /** Zero-based start index into the sorted, filtered list. Listing only. */
  offset?: number;
};

export type ToolsCommandContext = {
  stateDir: string;
  spawn?: SpawnFn;
};

type ListParams = { filter?: string; limit?: number; offset?: number };

const listTools = (
  selector: string | undefined,
  context: ToolsCommandContext,
  params: ListParams = {},
): Promise<ToolsListResult> => {
  return callDaemon<ToolsListResult>(
    RPC_METHODS.toolsList,
    { selector, ...params },
    { stateDir: context.stateDir, spawn: context.spawn },
  );
};

const findTool = (tools: ToolDescriptor[], name: string): ToolDescriptor | undefined => {
  return tools.find((tool) => tool.name === name);
};

const hasPagingOptions = (options: ToolsCommandOptions): boolean => {
  return options.filter !== undefined || options.limit !== undefined || options.offset !== undefined;
};

/** Echoes back only the paging/filter inputs actually given, alongside the daemon's result — the
 * human renderer's "Showing n of total" line and `--json` consumers both read this off `data`
 * rather than needing the CLI options threaded to them separately. */
const toListing = (result: ToolsListResult, params: ListParams): ToolsListing => {
  return {
    ...result,
    ...(params.filter !== undefined ? { filter: params.filter } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
  };
};

const listingOnlyError = () => {
  return usageError(
    '"--filter", "--limit", and "--offset" only apply to a tools listing, not a single tool lookup.',
  );
};

export const handleToolsCommand = async (
  options: ToolsCommandOptions,
  context: ToolsCommandContext,
): Promise<CliResult<ToolsCommandData>> => {
  if (options.name !== undefined && hasPagingOptions(options)) {
    throw listingOnlyError();
  }

  if (options.selector !== undefined && options.name !== undefined) {
    const result = await listTools(options.selector, context);
    const tool = findTool(result.tools, options.name);

    if (!tool) {
      throw usageError(
        `Tool "${options.name}" is not registered on session "${options.selector}".`,
        { available: result.tools.map((entry) => entry.name) },
      );
    }

    return { ok: true, data: tool };
  }

  if (options.selector !== undefined) {
    // A single positional arg: try it as the implicit session's tool name first.
    let implicitTools: ToolsListResult | undefined;

    try {
      implicitTools = await listTools(undefined, context);
    } catch (error) {
      if (!(error instanceof DaemonRpcError)) {
        throw error;
      }
    }

    if (implicitTools) {
      const tool = findTool(implicitTools.tools, options.selector);

      if (tool) {
        // The same rule as an explicit `<selector> <name>`: silently dropping the listing flags
        // here would make `tools <name> --limit 5` behave differently from `tools <sel> <name>`.
        if (hasPagingOptions(options)) {
          throw listingOnlyError();
        }

        return { ok: true, data: tool };
      }
    }

    // Not a tool name on the implicit session (or there is no implicit session): treat the arg as
    // a selector and list that session's tools instead.
    const result = await listTools(options.selector, context, options);
    return { ok: true, data: toListing(result, options) };
  }

  const result = await listTools(undefined, context, options);
  return { ok: true, data: toListing(result, options) };
};
