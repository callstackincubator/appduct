/** Draft 2020-12 JSON Schema object; internals are never validated, only that it is a JSON object. */
export type ToolSchemaDescriptor = Record<string, unknown>;

/** `[a-zA-Z0-9_-]{1,64}` (ARCHITECTURE.md §7). */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export const MAX_TOOL_DESCRIPTION_LENGTH = 4096;

/**
 * A tool group (PROTOCOL.md §5): one or two `/`-separated segments, each matching
 * {@link TOOL_NAME_PATTERN} — a top-level group (`checkout`) or a subgroup (`checkout/payment`),
 * nothing deeper. Written as one anchored pattern so the Swift and Kotlin ports can use the exact
 * same expression (and the conformance fixtures pin all three to it).
 */
export const TOOL_GROUP_PATTERN = /^[a-zA-Z0-9_-]{1,64}(?:\/[a-zA-Z0-9_-]{1,64})?$/;

/** Whether `value` is a valid tool group string (see {@link TOOL_GROUP_PATTERN}). */
export const isValidToolGroup = (value: unknown): value is string => {
  return typeof value === "string" && TOOL_GROUP_PATTERN.test(value);
};

/**
 * Segment match of a tool's `group` against a selected group (`tools.list`'s `group` param):
 * `checkout` selects `checkout` itself and every `checkout/*` subgroup, `checkout/payment` selects
 * exactly that subgroup, and `checkout` never selects `checkoutx`. Case-sensitive. An ungrouped
 * tool (`toolGroup` undefined) matches nothing.
 */
export const toolGroupMatches = (toolGroup: string | undefined, selected: string): boolean => {
  if (toolGroup === undefined) {
    return false;
  }

  return toolGroup === selected || toolGroup.startsWith(`${selected}/`);
};

/** One `tools.list` `groups` entry: a top-level group (its `total` includes its subgroups), a
 * subgroup (`parent/child`), or `null` for the ungrouped bucket. */
export type ToolGroupSummary = { group: string | null; total: number };

/** Orders group paths by segment — a parent sorts before its own subgroups, and a plain code-point
 * comparison of the whole path (which would put `checkout-x` between `checkout` and
 * `checkout/payment`, since `-` < `/`) never splits a parent from its subgroups. */
const compareGroupPaths = (a: string, b: string): number => {
  const [aTop = "", aSub] = a.split("/");
  const [bTop = "", bSub] = b.split("/");

  if (aTop !== bTop) {
    return aTop < bTop ? -1 : 1;
  }

  if (aSub === bSub) {
    return 0;
  }

  if (aSub === undefined) {
    return -1;
  }

  if (bSub === undefined) {
    return 1;
  }

  return aSub < bSub ? -1 : 1;
};

/**
 * `tools.list`'s `groups` summary over a registry: one entry per top-level group (counting its
 * subgroups' tools too), one per subgroup, and one `null` entry for ungrouped tools (only when
 * there are any). Sorted by group path (a parent right before its subgroups), `null` last. Group
 * names compare by code point, never `localeCompare`, so the order does not depend on the
 * daemon's locale.
 */
export const summarizeToolGroups = (tools: ReadonlyArray<{ group?: string }>): ToolGroupSummary[] => {
  const totals = new Map<string, number>();
  let ungrouped = 0;

  for (const tool of tools) {
    if (tool.group === undefined) {
      ungrouped += 1;
      continue;
    }

    const slash = tool.group.indexOf("/");
    const top = slash === -1 ? tool.group : tool.group.slice(0, slash);
    totals.set(top, (totals.get(top) ?? 0) + 1);

    if (slash !== -1) {
      totals.set(tool.group, (totals.get(tool.group) ?? 0) + 1);
    }
  }

  const summaries: ToolGroupSummary[] = [...totals.keys()]
    .sort(compareGroupPaths)
    .map((group) => ({ group, total: totals.get(group)! }));

  if (ungrouped > 0) {
    summaries.push({ group: null, total: ungrouped });
  }

  return summaries;
};

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
};

const TOOL_ANNOTATION_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint"] as const;

/**
 * The bounds the daemon enforces on any `tools.call` deadline (`docs/ARCHITECTURE.md` §5), and the
 * deadline it applies when neither the caller nor the tool declares one.
 *
 * These live here, in the shared wire vocabulary, rather than in the daemon: a tool's declared
 * {@link ToolDescriptor.timeout_ms} now crosses the wire, so the app's own abort timer and the
 * daemon's timer must be derived from the same numbers. Two copies would silently drift into a
 * disagreement where one side gives up while the other is still waiting.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
export const MIN_TOOL_TIMEOUT_MS = 1_000;
export const MAX_TOOL_TIMEOUT_MS = 600_000;

/**
 * Normalizes a declared or caller-supplied timeout to a whole number of milliseconds inside
 * [{@link MIN_TOOL_TIMEOUT_MS}, {@link MAX_TOOL_TIMEOUT_MS}]. Callers must reject non-finite input
 * before calling this — `Math.trunc(NaN)` is `NaN`, which no comparison would clamp.
 */
export const clampToolTimeoutMs = (timeoutMs: number): number => {
  return Math.min(Math.max(Math.trunc(timeoutMs), MIN_TOOL_TIMEOUT_MS), MAX_TOOL_TIMEOUT_MS);
};

export type ToolDescriptor = {
  /** Required, unique per session, `[a-zA-Z0-9_-]{1,64}`. */
  name: string;
  description: string;
  input_schema?: ToolSchemaDescriptor;
  output_schema?: ToolSchemaDescriptor;
  annotations?: ToolAnnotations;
  /**
   * The app-declared per-call deadline for this tool, in milliseconds (a positive integer). The
   * daemon uses it as the default `tools.call` timeout when the caller passes none; an explicit
   * caller `timeoutMs` still wins. Optional — older apps omit it and keep the daemon's default.
   *
   * snake_case like every other protocol-defined field on this descriptor; the camelCase
   * `timeoutMs` spelling belongs to the RN `registerTool` option and the `tools.call` RPC param,
   * which are camelCase layers. A camelCase key arriving here is not a timeout and is ignored.
   */
  timeout_ms?: number;
  /**
   * The group this tool belongs to (PROTOCOL.md §5): a top-level group (`checkout`) or a subgroup
   * (`checkout/payment`), see {@link TOOL_GROUP_PATTERN}. Optional — an ungrouped tool omits it.
   * Used by `tools.list`'s `group` filter and `groups` summary; never part of the MCP `Tool`.
   */
  group?: string;
};

const isJsonObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isValidOptionalSchema = (value: unknown): boolean => {
  return value === undefined || isJsonObject(value);
};

const isValidAnnotations = (value: unknown): value is ToolAnnotations | undefined => {
  if (value === undefined) {
    return true;
  }

  if (!isJsonObject(value)) {
    return false;
  }

  for (const key of Object.keys(value)) {
    if (!(TOOL_ANNOTATION_KEYS as readonly string[]).includes(key)) {
      return false;
    }
  }

  return TOOL_ANNOTATION_KEYS.every((key) => value[key] === undefined || typeof value[key] === "boolean");
};

/**
 * Strict `ToolDescriptor` guard. Every element of a `tool_registry_snapshot`/`tool_registry_delta`
 * must pass this before any field access — an invalid element (including `null`) must never be
 * indexed into.
 */
export const isToolDescriptor = (value: unknown): value is ToolDescriptor => {
  if (!isJsonObject(value)) {
    return false;
  }

  if (typeof value.name !== "string" || !TOOL_NAME_PATTERN.test(value.name)) {
    return false;
  }

  if (typeof value.description !== "string" || value.description.length === 0) {
    return false;
  }

  if (value.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
    return false;
  }

  if (!isValidOptionalSchema(value.input_schema)) {
    return false;
  }

  if (!isValidOptionalSchema(value.output_schema)) {
    return false;
  }

  if (!isValidAnnotations(value.annotations)) {
    return false;
  }

  if (
    value.timeout_ms !== undefined &&
    (!Number.isInteger(value.timeout_ms) || (value.timeout_ms as number) <= 0)
  ) {
    return false;
  }

  if (value.group !== undefined && !isValidToolGroup(value.group)) {
    return false;
  }

  return true;
};
