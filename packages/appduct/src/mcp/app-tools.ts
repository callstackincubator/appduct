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
  RPC_METHODS,
  renderToolSignature,
  type EffectivePolicyDecision,
  type SessionsDescribeResult,
  type ToolDescriptor,
  type ToolsListEntry,
  type ToolsListResult,
} from "@appduct/shared";

import { McpBuiltinToolError } from "./connect-tool.js";
import type { DaemonCall } from "./daemon-tools.js";

export const LIST_TOOLS_TOOL_NAME = "appduct_list_tools";
export const DESCRIBE_TOOL_TOOL_NAME = "appduct_describe_tool";
export const CALL_TOOL_TOOL_NAME = "appduct_call_tool";

const SELECTOR_PROPERTY = {
  type: "string",
  description: "Session alias or id. Omit to target the sole active/suspended session.",
} as const;

export const LIST_TOOLS_TOOL_DESCRIPTOR = {
  name: LIST_TOOLS_TOOL_NAME,
  description:
    "List the tools the connected app registered, as one-line signatures " +
    "(`name(param: type, optional?: type) -> result`) with the first line of each description " +
    "and the tool's effective policy. Start here: the app's tools are not MCP tools of their own. " +
    "filter is a case-insensitive substring match on name and description; limit/offset page the " +
    "name-sorted list, and total counts every match before paging. Use appduct_describe_tool for " +
    "one tool's full input/output schema, then appduct_call_tool to run it. A tool with policy " +
    '"prompt" asks the user to approve each call; one with policy "deny" cannot be called.',
  inputSchema: {
    type: "object",
    properties: {
      selector: SELECTOR_PROPERTY,
      filter: { type: "string" },
      limit: { type: "integer", exclusiveMinimum: 0 },
      offset: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
} as const;

export const DESCRIBE_TOOL_TOOL_DESCRIPTOR = {
  name: DESCRIBE_TOOL_TOOL_NAME,
  description:
    "Show one of the connected app's tools in full: description, input_schema (JSON Schema for " +
    "appduct_call_tool's args), output_schema, annotations, timeout and effective policy. Find " +
    "names with appduct_list_tools.",
  inputSchema: {
    type: "object",
    properties: {
      selector: SELECTOR_PROPERTY,
      name: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

export const CALL_TOOL_TOOL_DESCRIPTOR = {
  name: CALL_TOOL_TOOL_NAME,
  description:
    "Call one of the connected app's tools by name. args must match the tool's input_schema " +
    "(see appduct_describe_tool); omit it for a tool that takes no input. timeoutMs overrides the " +
    "tool's declared deadline. Returns the tool's result as JSON. A tool with policy \"prompt\" " +
    "asks the user to approve the call first, and fails if they decline or this client cannot ask.",
  inputSchema: {
    type: "object",
    properties: {
      selector: SELECTOR_PROPERTY,
      name: { type: "string" },
      args: { type: "object" },
      timeoutMs: { type: "number", exclusiveMinimum: 0 },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

/** One app tool resolved against a live session, with everything `appduct_call_tool` needs to
 * run it: the session alias the call and its progress subscription target, the descriptor (for its
 * name and declared deadline), and the effective policy (for whether to ask for consent). */
export type ResolvedAppTool = {
  selector: string;
  descriptor: ToolDescriptor;
  policy: EffectivePolicyDecision;
};

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

const asOptionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) {
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
  };
};

const firstLine = (description: string): string => {
  return description.split(/\r\n|[\n\r\u2028\u2029]/u)[0] ?? "";
};

/** Resolves `selector` to a concrete session alias first, so every result names the session it
 * came from and a call's progress subscription targets the same session as the call itself. The
 * daemon's own errors (`no_session`, `ambiguous_session`, `unknown_session`) pass through as-is. */
const resolveSessionAlias = async (call: DaemonCall, selector: string | undefined): Promise<string> => {
  const session = await call<SessionsDescribeResult>(RPC_METHODS.sessionsDescribe, { selector });
  return session.alias;
};

const findTool = async (call: DaemonCall, selector: string | undefined, name: string) => {
  const alias = await resolveSessionAlias(call, selector);
  // The whole registry, never a filtered page, so a name lookup cannot miss a tool that paging
  // would have left out.
  const { tools } = await call<ToolsListResult>(RPC_METHODS.toolsList, { selector: alias });
  const entry = tools.find((tool) => tool.name === name);

  if (!entry) {
    throw new McpBuiltinToolError(
      "tool_not_found",
      `Tool "${name}" is not registered on session "${alias}". Use ${LIST_TOOLS_TOOL_NAME} (optionally with filter) to find it.`,
    );
  }

  return { alias, entry };
};

export const handleListToolsTool = async (rawArgs: unknown, call: DaemonCall) => {
  const args = asRecord(rawArgs);
  const selector = asOptionalString(args.selector, "selector");
  const alias = await resolveSessionAlias(call, selector);

  // `filter`/`limit`/`offset` are validated by the daemon, which rejects a bad value with
  // `invalid_request` exactly as it does for the CLI.
  const params = {
    ...(args.filter !== undefined ? { filter: args.filter } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
  };
  const result = await call<ToolsListResult>(RPC_METHODS.toolsList, { selector: alias, ...params });

  return {
    session: alias,
    total: result.total,
    ...params,
    tools: result.tools.map((entry) => ({
      name: entry.name,
      signature: renderToolSignature(entry),
      summary: firstLine(entry.description),
      policy: entry.policy,
      ...(entry.annotations ? { annotations: entry.annotations } : {}),
    })),
  };
};

export const handleDescribeToolTool = async (rawArgs: unknown, call: DaemonCall) => {
  const args = asRecord(rawArgs);
  const selector = asOptionalString(args.selector, "selector");
  const name = asRequiredString(args.name, "name");
  const { alias, entry } = await findTool(call, selector, name);

  return {
    session: alias,
    signature: renderToolSignature(entry),
    policy: entry.policy,
    ...toDescriptor(entry),
  };
};

export const parseCallToolArgs = (rawArgs: unknown): CallToolArgs => {
  const args = asRecord(rawArgs);
  const selector = asOptionalString(args.selector, "selector");
  const name = asRequiredString(args.name, "name");
  const toolArgs = args.args ?? {};

  if (typeof toolArgs !== "object" || toolArgs === null || Array.isArray(toolArgs)) {
    throw new McpBuiltinToolError("invalid_request", '"args" must be an object.');
  }

  const timeoutMs = args.timeoutMs;

  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new McpBuiltinToolError("invalid_request", '"timeoutMs" must be a positive number.');
  }

  return {
    selector,
    name,
    args: toolArgs as Record<string, unknown>,
    timeoutMs: timeoutMs as number | undefined,
  };
};

export const resolveAppTool = async (
  call: DaemonCall,
  selector: string | undefined,
  name: string,
): Promise<ResolvedAppTool> => {
  const { alias, entry } = await findTool(call, selector, name);
  return { selector: alias, descriptor: toDescriptor(entry), policy: entry.policy };
};
