/**
 * The built-in `appduct_list_tools` / `appduct_describe_tool` / `appduct_call_tool` MCP tools
 * (ARCHITECTURE.md §9). The app's own tools are never listed as MCP tools. An agent reaches them
 * the way the CLI does: compact signatures first (`appduct tools`), one full schema on demand
 * (`appduct tools <name>`), then a call by name (`appduct invoke`). A registry of hundreds of tools
 * therefore costs a client three fixed tool definitions, and `tools/list` never changes while an
 * agent works.
 *
 * Every lookup goes to the daemon live, with no caching: the session and its registry can change
 * between any two calls, and the daemon is the single source of truth for both.
 */

import {
  MAX_TOOLS_FILTER_LENGTH,
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
  RPC_METHODS,
  renderToolSignature,
  summarizeToolDescription,
  TOOL_GROUP_PATTERN,
  type EffectivePolicyDecision,
  type SessionsDescribeResult,
  type ToolDescriptor,
  type ToolsListEntry,
  type ToolsListResult,
} from "@appduct/shared";

import { clampTimeout } from "../daemon/calls.js";
import { McpBuiltinToolError } from "./connect-tool.js";
import type { DaemonCall } from "./daemon-tools.js";

export const LIST_TOOLS_TOOL_NAME = "appduct_list_tools";
export const DESCRIBE_TOOL_TOOL_NAME = "appduct_describe_tool";
export const CALL_TOOL_TOOL_NAME = "appduct_call_tool";

/** Applied when `appduct_list_tools` gets no `limit`, so the first call on a large app returns a
 * page, not the whole registry; `total` tells the agent how much it left out. */
export const DEFAULT_LIST_TOOLS_LIMIT = 50;

const SELECTOR_PROPERTY = {
  type: "string",
  minLength: 1,
  description: "Session alias or id. Omit to target the sole active/suspended session.",
} as const;

const NAME_PROPERTY = { type: "string", minLength: 1 } as const;

export const LIST_TOOLS_TOOL_DESCRIPTOR = {
  name: LIST_TOOLS_TOOL_NAME,
  description:
    "List the tools the connected app registered, as one-line signatures " +
    "(`name(param: type, optional?: type) -> result`) with the first line of each description, " +
    "the tool's group and its effective policy. Start here: the app's tools are not MCP tools of " +
    "their own. Every result also carries groups: the app's tool groups with counts, over all its " +
    "tools. On a large app, list one area with group, copying the exact name from groups, parent " +
    "path included (\"diagnostics/progress\", not \"progress\"); \"checkout\" includes " +
    "\"checkout/payment\". filter is a case-insensitive substring match on name and description " +
    "only, never on group names; limit (default " +
    `${DEFAULT_LIST_TOOLS_LIMIT}) and offset page the name-sorted list, and total counts every ` +
    "match before paging, so page on with offset when total is larger. Use appduct_describe_tool for " +
    "one tool's full input/output schema, then appduct_call_tool to run it. A tool with policy " +
    '"prompt" asks the user to approve each call; one with policy "deny" cannot be called.',
  inputSchema: {
    type: "object",
    properties: {
      selector: SELECTOR_PROPERTY,
      group: { type: "string", pattern: TOOL_GROUP_PATTERN.source },
      filter: { type: "string", maxLength: MAX_TOOLS_FILTER_LENGTH },
      limit: { type: "integer", exclusiveMinimum: 0 },
      offset: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
} as const;

export const DESCRIBE_TOOL_TOOL_DESCRIPTOR = {
  name: DESCRIBE_TOOL_TOOL_NAME,
  description:
    "Show one of the connected app's tools in full: description, group, input_schema (JSON Schema " +
    "for appduct_call_tool's args), output_schema, annotations, timeout and effective policy. Find " +
    "names with appduct_list_tools.",
  inputSchema: {
    type: "object",
    properties: {
      selector: SELECTOR_PROPERTY,
      name: NAME_PROPERTY,
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

export const CALL_TOOL_TOOL_DESCRIPTOR = {
  name: CALL_TOOL_TOOL_NAME,
  description:
    "Call one of the connected app's tools by name. args must match the tool's input_schema " +
    "(see appduct_describe_tool); omit it for a tool that takes no input. The call runs under the " +
    "tool's own deadline (timeout_ms in appduct_describe_tool, 10000 ms if it declares none); " +
    "timeoutMs can only shorten it, since the app stops the tool at its own deadline. Returns " +
    'the tool\'s result as JSON. A tool with policy "prompt" ' +
    "asks the user to approve the call first, and fails if they decline or this client cannot ask.",
  inputSchema: {
    type: "object",
    properties: {
      selector: SELECTOR_PROPERTY,
      name: NAME_PROPERTY,
      args: { type: "object" },
      timeoutMs: { type: "integer", minimum: MIN_TOOL_TIMEOUT_MS, maximum: MAX_TOOL_TIMEOUT_MS },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

/** One app tool resolved against a live session, with everything `appduct_call_tool` needs to
 * run it: the session id the call, its progress subscription and any cancel are routed by, the
 * alias shown to people, the descriptor (for its name and declared deadline), and the effective
 * policy (for whether to ask for consent). */
export type ResolvedAppTool = {
  sessionId: string;
  alias: string;
  descriptor: ToolDescriptor;
  policy: EffectivePolicyDecision;
};

type ResolvedSession = { sessionId: string; alias: string };

export type CallToolArgs = {
  selector?: string;
  name: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

/** Every key an agent sends must be one the tool declares. A misspelled key (`arguments` for
 * `args`, `timeout_ms` for `timeoutMs`) would otherwise be dropped silently, and the tool would run
 * without what the agent meant to pass. */
const rejectUnknownKeys = (args: Record<string, unknown>, tool: string, allowed: readonly string[]): void => {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));

  if (unknown.length > 0) {
    throw new McpBuiltinToolError(
      "invalid_request",
      `${tool} does not take ${unknown.map((key) => `"${key}"`).join(", ")}. It takes: ${allowed.join(", ")}.`,
    );
  }
};

/** `null` counts as absent for every optional field: some clients fill unset optional
 * parameters with `null` rather than leaving them out. */
const asOptionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" must be a non-empty string.`);
  }

  return value;
};

const asRequiredString = (value: unknown, field: string): string => {
  const parsed = asOptionalString(value, field);

  if (parsed === undefined) {
    throw new McpBuiltinToolError("invalid_request", `"${field}" is required.`);
  }

  return parsed;
};

/** Explicit pick, so a non-descriptor field on `ToolsListEntry` (today `policy`) is reported once,
 * on its own key, rather than twice. */
const toDescriptor = (entry: ToolsListEntry): ToolDescriptor => {
  return {
    name: entry.name,
    description: entry.description,
    input_schema: entry.input_schema,
    output_schema: entry.output_schema,
    annotations: entry.annotations,
    timeout_ms: entry.timeout_ms,
    // Normalised the same way the listing normalises it, so `appduct_describe_tool` and
    // `appduct_call_tool` never disagree with `appduct_list_tools` about whether a tool has a
    // group. The `?? null` also covers a daemon that predates groups and omits the key entirely.
    group: entry.group ?? null,
  };
};

/** Resolves `selector` (an alias, a session id, or nothing) to one concrete session first, with
 * the daemon's own rules and errors (`no_session`, `ambiguous_session`, `unknown_session`).
 * Everything after that is routed by the **session id**, never the alias: the daemon frees an
 * alias when a session ends and gives it to the next device of the same model, so routing by alias
 * could land a call — one the user may already have approved — on a different device. If the
 * session goes away mid-call, the next daemon call fails with `unknown_session` instead. */
const resolveSession = async (call: DaemonCall, selector: string | undefined): Promise<ResolvedSession> => {
  const session = await call<SessionsDescribeResult>(RPC_METHODS.sessionsDescribe, { selector });
  return { sessionId: session.sessionId, alias: session.alias };
};

const findTool = async (call: DaemonCall, selector: string | undefined, name: string) => {
  const session = await resolveSession(call, selector);
  // The whole registry, never a filtered page, so a name lookup cannot miss a tool that paging
  // would have left out.
  const { tools } = await call<ToolsListResult>(RPC_METHODS.toolsList, { selector: session.sessionId });
  const entry = tools.find((tool) => tool.name === name);

  if (!entry) {
    throw new McpBuiltinToolError(
      "tool_not_found",
      `Tool "${name}" is not registered on session "${session.alias}". Use ${LIST_TOOLS_TOOL_NAME} (optionally with filter) to find it.`,
    );
  }

  return { session, entry };
};

export const handleListToolsTool = async (rawArgs: unknown, call: DaemonCall) => {
  const args = asRecord(rawArgs);
  rejectUnknownKeys(args, LIST_TOOLS_TOOL_NAME, ["selector", "group", "filter", "limit", "offset"]);
  const selector = asOptionalString(args.selector, "selector");
  const session = await resolveSession(call, selector);

  // `group`/`filter`/`limit`/`offset` are validated by the daemon, which rejects a bad value with
  // `invalid_request` exactly as it does for the CLI.
  const params = {
    ...(args.group !== undefined && args.group !== null ? { group: args.group } : {}),
    ...(args.filter !== undefined && args.filter !== null ? { filter: args.filter } : {}),
    limit: args.limit ?? DEFAULT_LIST_TOOLS_LIMIT,
    ...(args.offset !== undefined && args.offset !== null ? { offset: args.offset } : {}),
  };
  const result = await call<ToolsListResult>(RPC_METHODS.toolsList, { selector: session.sessionId, ...params });

  // A daemon that predates tool groups returns no `groups` and ignores `group`, so the page it sent
  // back is the whole registry, not the group. The version check normally restarts such a daemon
  // first; when it could not, say so rather than hand the agent a wrong listing.
  if (!Array.isArray(result.groups) && "group" in params) {
    throw new McpBuiltinToolError(
      "connection_error",
      "The running Appduct daemon does not support tool groups. Restart it with a newer version (`appduct daemon stop`), then restart this MCP server.",
    );
  }

  return {
    session: session.alias,
    total: result.total,
    ...params,
    tools: result.tools.map((entry) => ({
      name: entry.name,
      signature: renderToolSignature(entry),
      summary: summarizeToolDescription(entry.description),
      // Always present: `null` for an ungrouped tool, mirroring `groups`. The `?? null` also covers
      // a daemon that predates groups and omits the key from its entries entirely.
      group: entry.group ?? null,
      policy: entry.policy,
      ...(entry.annotations ? { annotations: entry.annotations } : {}),
    })),
    ...(Array.isArray(result.groups) ? { groups: result.groups } : {}),
  };
};

export const handleDescribeToolTool = async (rawArgs: unknown, call: DaemonCall) => {
  const args = asRecord(rawArgs);
  rejectUnknownKeys(args, DESCRIBE_TOOL_TOOL_NAME, ["selector", "name"]);
  const selector = asOptionalString(args.selector, "selector");
  const name = asRequiredString(args.name, "name");
  const { session, entry } = await findTool(call, selector, name);

  return {
    session: session.alias,
    signature: renderToolSignature(entry),
    policy: entry.policy,
    ...toDescriptor(entry),
  };
};

export const parseCallToolArgs = (rawArgs: unknown): CallToolArgs => {
  const args = asRecord(rawArgs);
  rejectUnknownKeys(args, CALL_TOOL_TOOL_NAME, ["selector", "name", "args", "timeoutMs"]);
  const selector = asOptionalString(args.selector, "selector");
  const name = asRequiredString(args.name, "name");
  const toolArgs = args.args ?? {};

  if (typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
    throw new McpBuiltinToolError("invalid_request", '"args" must be an object.');
  }

  const timeoutMs = args.timeoutMs ?? undefined;

  // Rejected rather than clamped: the daemon would silently clamp an out-of-range deadline, and
  // an agent that asked for an hour should learn it gets ten minutes before the call starts.
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_TOOL_TIMEOUT_MS ||
      timeoutMs > MAX_TOOL_TIMEOUT_MS)
  ) {
    throw new McpBuiltinToolError(
      "invalid_request",
      `"timeoutMs" must be an integer number of milliseconds from ${MIN_TOOL_TIMEOUT_MS} to ${MAX_TOOL_TIMEOUT_MS}.`,
    );
  }

  return {
    selector,
    name,
    args: toolArgs as Record<string, unknown>,
    timeoutMs: timeoutMs as number | undefined,
  };
};

/**
 * The deadline a call runs under: the tool's own (`clampTimeout` folds in the 10 s default for a
 * tool that declares none), or a shorter one the caller asked for. Never longer: the `tool_call`
 * frame carries no deadline, so the app stops the handler at the tool's own deadline whatever the
 * daemon waits for (docs/PROTOCOL.md), and a longer caller deadline would only turn a clear
 * `tool_timeout` into the same timeout after a retry that ran the tool again.
 */
export const resolveCallDeadline = (tool: ResolvedAppTool, requestedTimeoutMs: number | undefined): number => {
  const toolDeadline = clampTimeout(tool.descriptor.timeout_ms);

  if (requestedTimeoutMs !== undefined && requestedTimeoutMs > toolDeadline) {
    throw new McpBuiltinToolError(
      "invalid_request",
      `"timeoutMs" can only shorten "${tool.descriptor.name}"'s own deadline of ${toolDeadline} ms: the app stops the tool at that deadline. Raising it takes a larger timeoutMs in the tool's registration.`,
    );
  }

  return requestedTimeoutMs ?? toolDeadline;
};

export const resolveAppTool = async (
  call: DaemonCall,
  selector: string | undefined,
  name: string,
): Promise<ResolvedAppTool> => {
  const { session, entry } = await findTool(call, selector, name);
  return { ...session, descriptor: toDescriptor(entry), policy: entry.policy };
};
