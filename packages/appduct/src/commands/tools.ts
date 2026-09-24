/**
 * `appduct tools ls`/`appduct tools describe` (ARCHITECTURE.md §10, issue #96): `ls [selector]
 * [--full] [--group <name>] [--filter <text>] [--limit <n>] [--offset <n>]` lists tools for a
 * session; `ls [selector] --groups` lists only the session's groups with their tool counts;
 * `describe [selector] <name>` shows one tool's full schema/annotations.
 *
 * The two verbs (`cli/routes/tools/ls.ts` and `cli/routes/tools/describe.ts`) split `[selector]`
 * from `<name>` unambiguously before this handler ever runs — `describe`'s `<name>` is always the
 * last positional, required, never a candidate selector — so there is no probing here: a listing
 * request (`options.name === undefined`) always lists, a lookup (`options.name !== undefined`)
 * always looks up, on the given selector or the implicit session if none was given.
 *
 * `--group`/`--filter`/`--limit`/`--offset` only ever reach the daemon on a *listing* request: the
 * detail path always asks for the whole, unpaged registry, so a name lookup can never miss a tool
 * that paging would have left off a page.
 */

import { RPC_METHODS, type ToolsListEntry, type ToolsListResult } from "@appduct/shared";

import type { CliResult, ToolGroupsListing, ToolsCommandData, ToolsListing } from "../cli/result-types.js";
import { connectionError, usageError } from "../errors.js";
import { callDaemon, DaemonRpcError, type SpawnFn } from "../rpc/client.js";

export type ToolsCommandOptions = {
  selector?: string;
  name?: string;
  /** Only tools in this group (`checkout` includes `checkout/*`). Listing only. */
  group?: string;
  /** List the session's groups with tool counts instead of its tools. Listing only, and
   * exclusive with every other listing flag. */
  groups?: boolean;
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

type ListParams = { group?: string; filter?: string; limit?: number; offset?: number };

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

/** Over daemon *listing* entries, never registrations: an entry spells an ungrouped tool's group
 * `null`, which `ToolDescriptor` does not admit. */
const findTool = (tools: ToolsListEntry[], name: string): ToolsListEntry | undefined => {
  return tools.find((tool) => tool.name === name);
};

const hasPagingOptions = (options: ToolsCommandOptions): boolean => {
  return (
    options.group !== undefined ||
    options.filter !== undefined ||
    options.limit !== undefined ||
    options.offset !== undefined
  );
};

const hasListingOnlyOptions = (options: ToolsCommandOptions): boolean => {
  return hasPagingOptions(options) || options.groups === true;
};

/** Only the daemon-bound listing params — never `selector`/`name`/`groups`. */
const toListParams = (options: ToolsCommandOptions): ListParams => {
  return { group: options.group, filter: options.filter, limit: options.limit, offset: options.offset };
};

/** Echoes back only the paging/filter inputs actually given, alongside the daemon's result — the
 * human renderer's "Showing n of total" line and `--json` consumers both read this off `data`
 * rather than needing the CLI options threaded to them separately. */
const toListing = (result: ToolsListResult, params: ListParams): ToolsListing => {
  return {
    ...result,
    ...(params.group !== undefined ? { group: params.group } : {}),
    ...(params.filter !== undefined ? { filter: params.filter } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
  };
};

const listingOnlyError = () => {
  return usageError(
    '"--group", "--groups", "--filter", "--limit", and "--offset" only apply to a tools listing, not a single tool lookup.',
  );
};

/** `--groups` answers from the `groups` summary alone, which the daemon computes over the whole
 * registry: `limit: 1` keeps the tool page itself (which is discarded) down to one entry, and
 * `total` with no group/filter is the registry's size. */
const listGroups = async (
  selector: string | undefined,
  context: ToolsCommandContext,
): Promise<ToolGroupsListing> => {
  const result = await listTools(selector, context, { limit: 1 });
  return { groups: requireGroupSupport(result), total: result.total };
};

/**
 * A daemon that predates tool groups answers `tools.list` with no `groups` and ignores the
 * `group` param outright, so `--group cart` would print the whole registry as if it were the
 * group, and `--groups` would print nothing. The version guard normally restarts such a daemon
 * before it is asked; when it could not (a daemon with live sessions, run without
 * `--daemon-restart`), say so rather than render a wrong answer.
 */
const requireGroupSupport = (result: ToolsListResult) => {
  if (!Array.isArray(result.groups)) {
    throw connectionError(
      'The running Appduct daemon does not support tool groups ("--group"/"--groups"). Restart it with a newer version: `appduct daemon stop`, or pass `--daemon-restart`.',
    );
  }

  return result.groups;
};

const listOrGroups = async (
  selector: string | undefined,
  options: ToolsCommandOptions,
  context: ToolsCommandContext,
): Promise<ToolsCommandData> => {
  if (options.groups === true) {
    try {
      return await listGroups(selector, context);
    } catch (error) {
      // `--groups` takes no value, so `tools --groups checkout` reads `checkout` as a session
      // selector. When no such session exists, the likelier intent is `--group checkout`.
      if (
        selector !== undefined &&
        error instanceof DaemonRpcError &&
        error.data?.type === "unknown_session"
      ) {
        throw usageError(
          `No session matches "${selector}". "--groups" takes no value; to list one group's tools, use "--group ${selector}".`,
        );
      }

      throw error;
    }
  }

  const params = toListParams(options);
  const result = await listTools(selector, context, params);

  if (params.group !== undefined) {
    requireGroupSupport(result);
  }

  return toListing(result, params);
};

export const handleToolsCommand = async (
  options: ToolsCommandOptions,
  context: ToolsCommandContext,
): Promise<CliResult<ToolsCommandData>> => {
  if (options.groups === true && hasPagingOptions(options)) {
    throw usageError(
      '"--groups" lists every group in the session and cannot be combined with "--group", "--filter", "--limit", or "--offset".',
    );
  }

  if (options.name !== undefined && hasListingOnlyOptions(options)) {
    throw listingOnlyError();
  }

  if (options.name !== undefined) {
    const result = await listTools(options.selector, context);
    const tool = findTool(result.tools, options.name);

    if (!tool) {
      throw usageError(
        options.selector !== undefined
          ? `Tool "${options.name}" is not registered on session "${options.selector}".`
          : `Tool "${options.name}" is not registered.`,
        { available: result.tools.map((entry) => entry.name) },
      );
    }

    return { ok: true, data: tool };
  }

  return { ok: true, data: await listOrGroups(options.selector, options, context) };
};
