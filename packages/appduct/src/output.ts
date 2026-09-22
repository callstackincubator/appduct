import pc from "picocolors";
import {
  formatAgentWebSocketUrl,
  renderToolSignature,
  summarizeToolDescription,
  type EventNotification,
  type ListedToolDescriptor,
  type SessionSummary,
  type ToolGroupSummary,
  type ToolsListEntry,
} from "@appduct/shared";

import type {
  CliError,
  CliResult,
  CommandMeta,
  DaemonRunCommandData,
  DaemonStartCommandData,
  DaemonStatusCommandData,
  DaemonStopCommandData,
  DoctorCommandData,
  InitCommandData,
  InvokeCommandData,
  KeygenCommandData,
  LinkCommandData,
  LsCommandData,
  RevokeCommandData,
  ToolGroupsListing,
  ToolsCommandData,
  ToolsListing,
} from "./cli/result-types.js";
import { formatJson, type GlobalFlags } from "./cli/global-flags.js";
import { renderQrToTerminal } from "./qr-terminal.js";

type ColorPalette = ReturnType<typeof pc.createColors>;

export type RenderOptions = {
  command: string;
  flags: GlobalFlags;
  /** "Now", for the one renderer (`ls`'s Age column) that needs a reference time absent `meta`
   * (which is only attached under `--verbose`). Defaults to the wall clock when omitted, matching
   * the pre-`--verbose` fallback behavior for a caller that doesn't care (e.g. non-`ls` tests). */
  now?: Date;
  /** `link`-only: also render the deep link as terminal QR art (never affects `--json` output). */
  qr?: boolean;
  /** `tools`-only: render full schemas/annotations for every listed tool, not just name+description. */
  full?: boolean;
};

const renderMetaLines = (meta?: CommandMeta): string[] => {
  if (!meta) {
    return [];
  }

  return [
    "Meta",
    `  Command: ${meta.command}`,
    `  Timestamp: ${meta.timestamp}`,
    ...(typeof meta.duration_ms === "number" ? [`  Duration: ${meta.duration_ms} ms`] : []),
  ];
};

const formatScalar = (value: unknown, flags: GlobalFlags): string => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null || value === undefined) {
    return "null";
  }

  return formatJson(value, flags);
};

const renderFields = (
  title: string,
  fields: Array<[label: string, value: unknown]>,
  flags: GlobalFlags,
): string[] => {
  const visibleFields = fields.filter(([, value]) => value !== undefined);

  if (visibleFields.length === 0) {
    return [];
  }

  const width = Math.max(...visibleFields.map(([label]) => label.length));

  return [
    title,
    ...visibleFields.map(([label, value]) => `  ${label.padEnd(width)}  ${formatScalar(value, flags)}`),
  ];
};

/** Humanizes an elapsed duration for `ls`'s "age" column: seconds/minutes/hours/days, coarsest unit
 * that keeps at least one digit of precision. */
const formatAge = (fromIso: string, toIso: string): string => {
  const elapsedMs = Math.max(0, new Date(toIso).getTime() - new Date(fromIso).getTime());
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }

  return `${Math.floor(elapsedHours / 24)}d`;
};

const formatDevice = (device: SessionSummary["device"]): string => {
  const parts = [device.manufacturer, device.model].filter((part): part is string => Boolean(part));
  const label = parts.length > 0 ? parts.join(" ") : "unknown device";
  return device.os ? `${label} (${device.os})` : label;
};

const renderLsData = (colors: ColorPalette, data: LsCommandData, now: Date): string[] => {
  if (data.length === 0) {
    return [colors.dim("Sessions"), "  No Appduct sessions are registered."];
  }

  const nowIso = now.toISOString();
  const headers = ["Alias", "State", "Device", "Tools", "Age"] as const;
  const rows = data.map((session) => [
    session.alias,
    session.state,
    formatDevice(session.device),
    String(session.toolCount),
    formatAge(session.claimedAt ?? session.createdAt, nowIso),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );

  return [
    colors.green("Sessions"),
    `  ${headers.map((header, index) => header.padEnd(widths[index]!)).join("  ")}`,
    ...rows.map((row) => `  ${row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ")}`),
  ];
};

/** `renderToolsData` distinguishes the listing form of `ToolsCommandData` (`ToolsListing`, which
 * carries `tools`/`total`) from the bare single-tool detail form purely by shape — a single entry
 * never has a `tools` array of its own, so this never misclassifies either one. */
const isToolsListing = (data: ToolsCommandData): data is ToolsListing => {
  return typeof data === "object" && data !== null && Array.isArray((data as ToolsListing).tools);
};

/** `--groups`' form: a `groups` array and no `tools` array (a listing carries both). */
const isToolGroupsListing = (data: ToolsCommandData): data is ToolGroupsListing => {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as ToolGroupsListing).groups) &&
    !Array.isArray((data as ToolsListing).tools)
  );
};

/** The heading for the ungrouped bucket, in both the grouped listing and `--groups`. */
const UNGROUPED_LABEL = "(ungrouped)";

/** How many top-level groups the truncation footer names before pointing at `--groups`. */
const MAX_FOOTER_GROUPS = 10;

/** Whether the registry (per the daemon's unfiltered `groups` summary) has any grouped tool. */
const hasAnyGroup = (groups: readonly ToolGroupSummary[] | undefined): boolean => {
  return (groups ?? []).some((entry) => entry.group !== null);
};

const topLevelGroups = (groups: readonly ToolGroupSummary[] | undefined): ToolGroupSummary[] => {
  return (groups ?? []).filter((entry) => entry.group !== null && !entry.group.includes("/"));
};

/** "No tools registered"/"No tools match" for an empty listing (compact or `--full` — both share
 * this line, only the header differs). */
const renderEmptyToolsLine = (data: ToolsListing): string => {
  if (data.total > 0) {
    // An empty page of a non-empty result: `--offset` ran past the end. Saying "No tools
    // registered" here would send an agent looking for a registry problem that is not there.
    return `  No tools at offset ${data.offset ?? 0}; ${data.total} matching tool${data.total === 1 ? "" : "s"} in total.`;
  }

  if (data.group !== undefined) {
    // Never "No tools registered" for an empty group: the registry may well have tools, just not
    // in this group (a typo, or the wrong case — matching is case-sensitive).
    const match = data.filter === undefined ? "" : ` match ${JSON.stringify(data.filter)}`;
    return `  No tools in group ${JSON.stringify(data.group)}${match}. Run \`appduct tools --groups\` to see the session's groups.`;
  }

  return data.filter === undefined ? "  No tools registered." : `  No tools match ${JSON.stringify(data.filter)}.`;
};

/** `--group <name> (groups: cart 12, checkout 8)` — the footer's pointer at the registry's
 * top-level groups, only for a listing that was not already narrowed to a group. Counts are the
 * daemon's whole-registry totals (a parent's includes its subgroups). */
const renderGroupHint = (data: ToolsListing): string | undefined => {
  if (data.group !== undefined || !hasAnyGroup(data.groups)) {
    return undefined;
  }

  const top = topLevelGroups(data.groups);
  const named = top.slice(0, MAX_FOOTER_GROUPS).map((entry) => `${entry.group} ${entry.total}`);
  const more = top.length > MAX_FOOTER_GROUPS ? `, ... ${top.length - MAX_FOOTER_GROUPS} more; see --groups` : "";

  return `--group <name> (groups: ${named.join(", ")}${more})`;
};

/** The `Showing n of total tools (offset o). Narrow with --filter <text> or page with --offset
 * <n>.` line — only when the page actually left tools out, so a listing that already shows
 * everything (including a filtered one with no more matches) stays quiet. On a registry with
 * groups (and no `--group` given) it names the top-level groups to narrow to first. */
const renderTruncationLine = (data: ToolsListing): string[] => {
  if (data.tools.length >= data.total) {
    return [];
  }

  const groupHint = renderGroupHint(data);
  const narrow =
    groupHint === undefined ? "--filter <text> or" : `${groupHint} or --filter <text>, or`;

  return [
    "",
    `Showing ${data.tools.length} of ${data.total} tools (offset ${data.offset ?? 0}). ` +
      `Narrow with ${narrow} page with --offset <n>.`,
  ];
};

/** One tool's two summary lines (signature + first description line), indented by `indent`. */
const renderToolSummaryLines = (tool: ToolsListEntry, indent: string): string[] => {
  const tag = tool.policy === "allow" ? "" : `  [${tool.policy}]`;
  return [`${indent}${renderToolSignature(tool)}${tag}`, `${indent}  ${summarizeToolDescription(tool.description)}`];
};

/**
 * The page's tools under group headings: top-level groups as headings, subgroups as indented
 * sub-headings under their parent, ungrouped tools last under `(ungrouped)`. Headings follow the
 * daemon's `groups` order (a parent right before its subgroups); tools keep the daemon's name
 * order within each heading. Only headings that have a tool on this page are printed, plus the
 * parent heading of any subgroup that does.
 */
const renderGroupedToolLines = (colors: ColorPalette, tools: readonly ToolsListEntry[]): string[] => {
  const byGroup = new Map<string | null, ToolsListEntry[]>();

  for (const tool of tools) {
    const key = tool.group ?? null;
    const bucket = byGroup.get(key);

    if (bucket) {
      bucket.push(tool);
    } else {
      byGroup.set(key, [tool]);
    }
  }

  // The same order the daemon's `groups` summary uses (parent before its subgroups, code-point
  // order, never locale-dependent), derived from the page itself so it holds even for a page
  // whose headings the summary would order the same way anyway.
  const tops = new Map<string, string[]>();

  for (const key of byGroup.keys()) {
    if (key === null) {
      continue;
    }

    const slash = key.indexOf("/");
    const top = slash === -1 ? key : key.slice(0, slash);
    const subs = tops.get(top) ?? [];

    if (slash !== -1) {
      subs.push(key);
    }

    tops.set(top, subs);
  }

  const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const lines: string[] = [];

  for (const top of [...tops.keys()].sort(byCodePoint)) {
    lines.push(`  ${colors.cyan(top)}`);
    lines.push(...(byGroup.get(top) ?? []).flatMap((tool) => renderToolSummaryLines(tool, "    ")));

    for (const sub of tops.get(top)!.sort(byCodePoint)) {
      lines.push(`    ${colors.cyan(sub)}`);
      lines.push(...byGroup.get(sub)!.flatMap((tool) => renderToolSummaryLines(tool, "      ")));
    }
  }

  const ungrouped = byGroup.get(null);

  if (ungrouped) {
    lines.push(`  ${colors.cyan(UNGROUPED_LABEL)}`);
    lines.push(...ungrouped.flatMap((tool) => renderToolSummaryLines(tool, "    ")));
  }

  return lines;
};

/** The listing's title line: `Tools`, or `Tools in group <name>` under `--group`. */
const renderToolsTitle = (colors: ColorPalette, data: ToolsListing): string => {
  return colors.green(data.group === undefined ? "Tools" : `Tools in group ${data.group}`);
};

const renderToolSummaryTable = (colors: ColorPalette, data: ToolsListing): string[] => {
  if (data.tools.length === 0) {
    return [renderToolsTitle(colors, data), renderEmptyToolsLine(data)];
  }

  // Headings only when the registry has groups and the listing was not already narrowed to one —
  // under `--group` every tool is in the requested group, so a heading would say nothing new.
  const grouped = data.group === undefined && hasAnyGroup(data.groups);

  return [
    renderToolsTitle(colors, data),
    ...(grouped
      ? renderGroupedToolLines(colors, data.tools)
      : data.tools.flatMap((tool) => renderToolSummaryLines(tool, "  "))),
    ...renderTruncationLine(data),
    "",
    "Run `appduct tools <name>` for a tool's full schema.",
  ];
};

const renderToolDetail = (
  colors: ColorPalette,
  tool: ListedToolDescriptor,
  flags: GlobalFlags,
): string[] => {
  return renderFields(
    colors.green(`Tool: ${tool.name}`),
    [
      ["Signature", renderToolSignature(tool)],
      ["Description", tool.description],
      ["Input schema", tool.input_schema],
      ["Output schema", tool.output_schema],
      // `?? undefined` keeps an ungrouped tool's row hidden rather than printing a bare "null":
      // `renderFields` drops undefined rows, and the machine form's `null` is for consumers, not
      // for a human scanning one tool's schema.
      ["Group", tool.group ?? undefined],
      ["Annotations", tool.annotations],
      // Only rendered for a tool that declares one; `renderFields` drops undefined rows, so a
      // tool on the daemon's default deadline shows no line at all rather than a misleading
      // "10000".
      ["Timeout (ms)", tool.timeout_ms],
    ],
    flags,
  );
};

const renderToolsFullListing = (colors: ColorPalette, data: ToolsListing, flags: GlobalFlags): string[] => {
  if (data.tools.length === 0) {
    return [renderToolsTitle(colors, data), renderEmptyToolsLine(data)];
  }

  return [
    ...data.tools.flatMap((tool, index) => [
      ...(index > 0 ? [""] : []),
      ...renderToolDetail(colors, tool, flags),
    ]),
    ...renderTruncationLine(data),
  ];
};

/** `appduct tools --groups`: every group with its tool count, subgroups indented under their
 * parent, ungrouped last — in the daemon's `groups` order, which already puts a parent right
 * before its subgroups. */
const renderToolGroups = (colors: ColorPalette, data: ToolGroupsListing): string[] => {
  if (data.groups.length === 0) {
    return [colors.green("Groups"), "  No tools registered."];
  }

  const label = (entry: ToolGroupSummary): string => {
    if (entry.group === null) {
      return UNGROUPED_LABEL;
    }

    return entry.group.includes("/") ? `  ${entry.group}` : entry.group;
  };

  const width = Math.max(...data.groups.map((entry) => label(entry).length));
  const countWidth = Math.max(...data.groups.map((entry) => String(entry.total).length));

  return [
    colors.green("Groups"),
    ...data.groups.map((entry) => `  ${label(entry).padEnd(width)}  ${String(entry.total).padStart(countWidth)}`),
    "",
    `${data.total} tool${data.total === 1 ? "" : "s"} in total. ` +
      (hasAnyGroup(data.groups) ? "Run `appduct tools --group <name>` to list one group's tools." : "No tool declares a group."),
  ];
};

const renderToolsData = (
  colors: ColorPalette,
  data: ToolsCommandData,
  flags: GlobalFlags,
  full?: boolean,
): string[] => {
  if (isToolGroupsListing(data)) {
    return renderToolGroups(colors, data);
  }

  if (!isToolsListing(data)) {
    return renderToolDetail(colors, data, flags);
  }

  return full ? renderToolsFullListing(colors, data, flags) : renderToolSummaryTable(colors, data);
};

const renderInvokeData = (colors: ColorPalette, data: InvokeCommandData, flags: GlobalFlags): string[] => {
  return [colors.green("Result"), formatScalar(data, flags)];
};

const renderLinkData = (
  colors: ColorPalette,
  data: LinkCommandData,
  flags: GlobalFlags,
  qr?: boolean,
): string[] => {
  const lines = [
    colors.green("Link Created"),
    ...renderFields(
      "Link",
      [
        ["Session", data.sessionId],
        ["Deep link", data.deepLink],
        ["Endpoint", formatAgentWebSocketUrl(data.endpoint)],
        ["Pin", data.pin],
        ["Expires", new Date(data.expiresAt * 1000).toISOString()],
        ["Delivered", data.delivered ? `yes (${data.target})` : undefined],
      ],
      flags,
    ),
  ];

  if (qr) {
    lines.push("", "QR", renderQrToTerminal(data.deepLink));
  }

  return lines;
};

const renderRevokeData = (colors: ColorPalette, _data: RevokeCommandData): string[] => {
  return [colors.green("Session Revoked")];
};

const renderKeygenData = (colors: ColorPalette, data: KeygenCommandData, flags: GlobalFlags): string[] => {
  return [
    colors.green("Key Ready"),
    ...renderFields(
      "Key",
      [
        ["Path", data.path],
        ["Fingerprint", data.pin],
      ],
      flags,
    ),
  ];
};

const renderInitData = (colors: ColorPalette, data: InitCommandData, flags: GlobalFlags): string[] => {
  // The pasteable MCP snippet is always shown indented, regardless of `--pretty` — it is meant to
  // be copied straight into a JSON config file, not machine-parsed output.
  const snippet = JSON.stringify(
    { mcpServers: { appduct: data.mcpServerEntry } },
    null,
    2,
  );

  return [
    colors.green(data.changed ? "Project Initialized" : "Project Already Initialized"),
    ...renderFields(
      "Config",
      [
        ["Path", data.path],
        ["Scheme", data.scheme],
        ["Source", data.source],
        // Only present for a scheme discovery read off a static project file (app.json, or one of
        // the native Android/iOS probes) — names the exact file/key, not just which platform.
        ["Read from", data.origin],
        ["Written", data.changed ? (data.created ? "created" : "updated") : "unchanged"],
      ],
      flags,
    ),
    ...(data.note === undefined ? [] : ["", colors.yellow(`Note: ${data.note}`)]),
    "",
    "MCP server entry",
    ...snippet.split("\n").map((line) => `  ${line}`),
    "",
    "Next",
    ...data.nextSteps.map((step, index) => `  ${index + 1}. ${step}`),
  ];
};

const renderDaemonRunData = (
  colors: ColorPalette,
  data: DaemonRunCommandData,
  flags: GlobalFlags,
): string[] => {
  return [
    colors.green("Daemon Running"),
    ...renderFields(
      "Daemon",
      [
        ["PID", data.daemon.pid],
        ["State dir", data.daemon.state_dir],
        ["Socket", data.daemon.socket_path],
      ],
      flags,
    ),
  ];
};

const renderDaemonStartData = (
  colors: ColorPalette,
  data: DaemonStartCommandData,
  flags: GlobalFlags,
): string[] => {
  return [
    colors.green("Daemon Started"),
    ...renderFields(
      "Daemon",
      [
        ["PID", data.daemon.pid],
        ["WSS port", data.daemon.wss_port],
        ["Started at", data.daemon.started_at],
      ],
      flags,
    ),
  ];
};

const renderDaemonStopData = (
  colors: ColorPalette,
  data: DaemonStopCommandData,
  flags: GlobalFlags,
): string[] => {
  return [
    colors.green("Daemon Stopped"),
    ...renderFields("Daemon", [["Method", data.daemon.method]], flags),
  ];
};

/** Human column for a byte count (the machine-readable `bytes` stays exact in `--json`). Binary
 * units, one decimal above KiB, so a growing `audit/` reads at a glance. */
const formatByteSize = (bytes: number): string => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];

  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

const renderDaemonStatusData = (
  colors: ColorPalette,
  data: DaemonStatusCommandData,
  flags: GlobalFlags,
): string[] => {
  return [
    colors.green("Daemon Status"),
    ...renderFields(
      "Daemon",
      [
        ["Version", data.daemon.version],
        ["PID", data.daemon.pid],
        ["Started at", data.daemon.started_at],
        ["WSS port", data.daemon.wss_port],
        ["Pinned keys", data.daemon.pinned_keys.length],
        ["Sessions", data.daemon.session_count],
      ],
      flags,
    ),
    "",
    ...renderFields(
      "Policy",
      [
        ["Default", data.policy.default],
        ["Destructive", data.policy.destructive],
        ["Overrides", data.policy.tools ? Object.keys(data.policy.tools).length : 0],
      ],
      flags,
    ),
    "",
    // The retention rows drop out entirely against a daemon that predates them (`renderFields`
    // skips `undefined`), rather than printing "undefined" or an invented zero.
    ...renderFields(
      "Audit",
      [
        ["Path", data.audit.path],
        ["Retention", data.audit.retention_days === undefined ? undefined : `${data.audit.retention_days} days`],
        ["Files", data.audit.files],
        ["Size", data.audit.bytes === undefined ? undefined : formatByteSize(data.audit.bytes)],
        ["Failed writes", data.audit.failed_writes],
        ["Failed prunes", data.audit.failed_prunes],
      ],
      flags,
    ),
    // Version drift (issue #30) is the one thing here an operator has to act on, so it goes last
    // — the line still on screen after the block scrolls — and in yellow, not a quiet field row.
    ...(data.warning ? ["", colors.yellow(`Warning: ${data.warning}`)] : []),
  ];
};

const renderDoctorData = (colors: ColorPalette, data: DoctorCommandData, flags: GlobalFlags): string[] => {
  return [
    data.present ? colors.green("Appduct Present") : colors.yellow("Appduct Absent"),
    ...renderFields(
      "Artifact",
      [
        ["Path", data.artifact],
        ["Platform", data.platform],
        ["Format", data.format],
        ["Present", data.present],
        ["Signals", data.signals.length > 0 ? data.signals.join(", ") : "none"],
        ["Assertion", data.assertion ? `${data.assertion.expected} (holds)` : undefined],
      ],
      flags,
    ),
  ];
};

const renderSuccessData = (colors: ColorPalette, command: string, data: unknown, options: RenderOptions): string[] => {
  const flags = options.flags;

  switch (command) {
    case "init":
      return renderInitData(colors, data as InitCommandData, flags);
    case "keygen":
      return renderKeygenData(colors, data as KeygenCommandData, flags);
    case "link":
      return renderLinkData(colors, data as LinkCommandData, flags, options.qr);
    case "ls":
      return renderLsData(colors, data as LsCommandData, options.now ?? new Date());
    case "tools":
      return renderToolsData(colors, data as ToolsCommandData, flags, options.full);
    case "invoke":
      return renderInvokeData(colors, data as InvokeCommandData, flags);
    case "revoke":
      return renderRevokeData(colors, data as RevokeCommandData);
    case "daemon run":
      return renderDaemonRunData(colors, data as DaemonRunCommandData, flags);
    case "daemon start":
      return renderDaemonStartData(colors, data as DaemonStartCommandData, flags);
    case "daemon stop":
      return renderDaemonStopData(colors, data as DaemonStopCommandData, flags);
    case "daemon status":
      return renderDaemonStatusData(colors, data as DaemonStatusCommandData, flags);
    case "doctor":
      return renderDoctorData(colors, data as DoctorCommandData, flags);
    default:
      return [colors.green("Command Complete"), formatJson(data, flags)];
  }
};

const renderHumanError = (colors: ColorPalette, error: CliError, flags: GlobalFlags, meta?: CommandMeta): string => {
  return [
    colors.red("Command Failed"),
    ...renderFields(
      "Error",
      [
        ["Type", error.type],
        ["Message", error.message],
        ["Details", error.details],
      ],
      flags,
    ),
    ...(meta ? ["", ...renderMetaLines(meta)] : []),
  ].join("\n");
};

export const renderResult = (
  result: CliResult<unknown>,
  options: RenderOptions,
): {
  stdout?: string;
  stderr?: string;
} => {
  if (options.flags.json) {
    return {
      stdout: `${formatJson(result, options.flags)}\n`,
    };
  }

  const colors = pc.createColors(options.flags.color);

  if (!result.ok) {
    return {
      stderr: `${renderHumanError(colors, result.error, options.flags, result.meta)}\n`,
    };
  }

  // `result.meta` is only present under `--verbose` (`cli/envelope.ts`'s `finalizeResult`), so
  // rendering it here keys purely off presence — no separate verbose check needed.
  const lines = [
    ...renderSuccessData(colors, options.command, result.data, options),
    "",
    ...renderMetaLines(result.meta),
  ].filter((line, index, collection) => {
    if (line !== "") {
      return true;
    }

    return index > 0 && collection[index - 1] !== "" && index < collection.length - 1;
  });

  return {
    stdout: `${lines.join("\n")}\n`,
  };
};

/** Renders one `appduct events` line: NDJSON under `--json`, a compact human line otherwise. */
export const renderEventLine = (event: EventNotification, flags: GlobalFlags): string => {
  if (flags.json) {
    // NDJSON is one object per line by contract (a streaming consumer reads it line-by-line, and
    // the cursor resume logic depends on that) — always compact, `--pretty` never applies here.
    return JSON.stringify(event);
  }

  const colors = pc.createColors(flags.color);
  const timestamp = new Date(event.ts).toISOString();
  const target = event.alias ?? event.sessionId;
  const dataSuffix = event.data === undefined ? "" : ` ${formatJson(event.data, flags)}`;

  return `${colors.dim(timestamp)} ${colors.green(event.kind)}${target ? ` ${target}` : ""}${dataSuffix}`;
};

/** Renders the trailing cursor line for `appduct events --since` (issue #6): NDJSON under
 * `--json` so a scripted caller can parse the resume point without maxing `seq` over the printed
 * events (impossible when the response is empty), a human note otherwise. */
export const renderEventsCursorLine = (cursor: number, flags: GlobalFlags): string => {
  if (flags.json) {
    // Same NDJSON rule as renderEventLine above: always one compact line, never `--pretty`.
    return JSON.stringify({ cursor });
  }

  const colors = pc.createColors(flags.color);
  return colors.dim(`cursor: ${cursor} (pass --since ${cursor} to resume from here)`);
};
