import { describe, expect, test } from "vitest";

import type { GlobalFlags } from "../cli/global-flags.js";
import type { DaemonStatusCommandData } from "../cli/result-types.js";
import { renderEventLine, renderEventsCursorLine, renderResult } from "../output.js";
import { FIXED_NOW } from "./fixtures.js";

/** `GlobalFlags` with sensible test defaults (no color, no --json/--pretty/--verbose), overridable
 * per call so each test states only the flags it cares about. */
const flags = (overrides: Partial<GlobalFlags> = {}): GlobalFlags => ({
  json: false,
  pretty: false,
  verbose: false,
  color: false,
  ...overrides,
});

describe("output rendering", () => {
  test("tools list output stays structured", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          tools: [
            {
              name: "echo",
              description: "Echo a payload on the connected device.",
              input_schema: {},
              output_schema: { echoed: "unknown" },
              policy: "allow",
            },
          ],
          total: 1,
        },
      },
      {
        command: "tools ls",
        flags: flags(),
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("tools list output shows a signature per tool, a policy tag for non-allow tools, and the trailing hint", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          tools: [
            {
              name: "seed_cart",
              description: "Fill the cart with test items for the current user.\nSecond line ignored.",
              input_schema: {
                type: "object",
                properties: {
                  items: { type: "integer" },
                  sku: { type: "string" },
                  clear: { type: "boolean", default: true },
                },
                required: ["items"],
              },
              output_schema: {
                type: "object",
                properties: { added: { type: "integer" }, cartId: { type: "string" } },
                required: ["added", "cartId"],
              },
              policy: "allow",
            },
            {
              name: "set_flag",
              description: "Toggle a feature flag.",
              input_schema: {
                type: "object",
                properties: {
                  name: { enum: ["dark_mode", "new_checkout"] },
                  enabled: { type: "boolean" },
                },
                required: ["name", "enabled"],
              },
              policy: "prompt",
            },
          ],
          total: 2,
        },
      },
      { command: "tools ls", flags: flags() },
    );

    expect(rendered.stdout).toBe(
      [
        "Tools",
        "  seed_cart(items: int, sku?: string, clear?: bool = true) -> { added: int, cartId: string }",
        "    Fill the cart with test items for the current user.",
        '  set_flag(name: "dark_mode" | "new_checkout", enabled: bool)  [prompt]',
        "    Toggle a feature flag.",
        "",
        "Run `appduct tools describe <name>` for a tool's full schema.",
        "",
      ].join("\n"),
    );
  });

  test("tools list output truncated by paging shows the Showing line with the given offset", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          tools: [{ name: "echo", description: "Echoes input.", policy: "allow" }],
          total: 5,
          offset: 2,
          limit: 1,
        },
      },
      { command: "tools ls", flags: flags() },
    ).stdout ?? "";

    expect(rendered).toContain(
      "Showing 1 of 5 tools (offset 2). Narrow with --filter <text> or page with --offset <n>.",
    );
  });

  test("the truncation footer names at most 10 top-level groups (no subgroups), then points at --groups", () => {
    const topLevel = Array.from({ length: 12 }, (_, index) => ({
      group: `g${String(index).padStart(2, "0")}`,
      total: 2,
    }));
    const rendered = renderResult(
      {
        ok: true,
        data: {
          tools: [{ name: "echo", description: "Echoes input.", policy: "allow", group: "g00" }],
          total: 24,
          limit: 1,
          groups: [topLevel[0], { group: "g00/sub", total: 1 }, ...topLevel.slice(1)],
        },
      },
      { command: "tools ls", flags: flags() },
    ).stdout ?? "";

    expect(rendered).toContain(
      "Showing 1 of 24 tools (offset 0). Narrow with --group <name> (groups: g00 2, g01 2, g02 2, g03 2, " +
        "g04 2, g05 2, g06 2, g07 2, g08 2, g09 2, ... 2 more; see --groups) or --filter <text>, or page with --offset <n>.",
    );
    expect(rendered).not.toContain("g00/sub 1");
  });

  test("tools list output with a filter and no matches says so", () => {
    const rendered = renderResult(
      { ok: true, data: { tools: [], total: 0, filter: "nope" } },
      { command: "tools ls", flags: flags() },
    ).stdout ?? "";

    expect(rendered).toContain('No tools match "nope".');
  });

  test("tools list output with no tools and no filter keeps the original message", () => {
    const rendered = renderResult(
      { ok: true, data: { tools: [], total: 0 } },
      { command: "tools ls", flags: flags() },
    ).stdout ?? "";

    expect(rendered).toContain("No tools registered.");
    expect(rendered).not.toContain("Run `appduct tools describe <name>`");
  });

  test("a description longer than 120 characters is cut with a trailing ellipsis", () => {
    const longDescription = `A. ${"x".repeat(130)}`;
    const rendered =
      renderResult(
        {
          ok: true,
          data: { tools: [{ name: "verbose", description: longDescription, policy: "allow" }], total: 1 },
        },
        { command: "tools ls", flags: flags() },
      ).stdout ?? "";

    const descriptionLine = rendered.split("\n").find((line) => line.startsWith("    A."));
    expect(descriptionLine).toBeDefined();
    expect(descriptionLine!.length).toBe(4 + 120 + 1); // 4-space indent + 120 chars + "…"
    expect(descriptionLine!.endsWith("…")).toBe(true);
  });

  test("a tool with no input/output schema at all renders as a no-argument call", () => {
    const rendered =
      renderResult(
        { ok: true, data: { tools: [{ name: "ping", description: "Health check.", policy: "allow" }], total: 1 } },
        { command: "tools ls", flags: flags() },
      ).stdout ?? "";

    expect(rendered).toContain("  ping()");
  });

  test("--full listing renders full detail blocks and still shows the Showing line, with no trailing hint", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          tools: [
            {
              name: "echo",
              description: "Echoes its input.",
              input_schema: { type: "object", properties: { text: { type: "string" } } },
              policy: "allow",
            },
          ],
          total: 3,
          offset: 0,
        },
      },
      { command: "tools ls", flags: flags(), full: true },
    ).stdout ?? "";

    expect(rendered).toContain("Tool: echo");
    expect(rendered).toMatch(/Signature\s+echo\(text\?: string\)/);
    expect(rendered).toContain("Showing 1 of 3 tools (offset 0).");
    expect(rendered).not.toContain("Run `appduct tools describe <name>`");
  });

  test("tools detail shows a declared timeout_ms, and no timeout line when the tool declares none", () => {
    const renderDetail = (timeoutMs?: number): string | undefined =>
      renderResult(
        {
          ok: true,
          data: {
            name: "login",
            description: "Signs a test user in.",
            ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
          },
        },
        { command: "tools describe", flags: flags() },
      ).stdout;

    expect(renderDetail(60_000)).toContain("Timeout (ms)  60000");
    // A tool on the daemon's default must not render a number it never declared.
    expect(renderDetail()).not.toContain("Timeout (ms)");
  });

  test("tools detail renders a Group row for a grouped tool and none for one whose group is null", () => {
    // A `tools.list` entry reports an ungrouped tool as `group: null`, not as an absent key, so the
    // human detail view must normalise that away rather than print a bare "Group  null" row.
    const renderDetail = (group: string | null): string | undefined =>
      renderResult(
        {
          ok: true,
          data: {
            name: "pay_card",
            description: "Pays for the cart.",
            group,
          },
        },
        { command: "tools describe", flags: flags() },
      ).stdout;

    expect(renderDetail("checkout/payment")).toMatch(/Group\s+checkout\/payment/);
    expect(renderDetail(null)).not.toMatch(/Group\s/);
    expect(renderDetail(null)).not.toContain("null");
  });

  test("tools detail output renders full schema/annotations", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          name: "echo",
          description: "Echo a payload on the connected device.",
          input_schema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      },
      {
        command: "tools describe",
        flags: flags(),
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("link human output includes the deep link and expiry", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          sessionId: "LinkOutputTestSess1",
          deepLink: "playground:///?appduct=abc123&pin=sha256%2Fexample",
          endpoint: { family: 4, address: "192.168.1.10", port: 8443 },
          expiresAt: Math.floor(FIXED_NOW.getTime() / 1000) + 30,
          pin: "sha256/example",
        },
      },
      {
        command: "sessions link",
        flags: flags(),
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("link json output only includes the trimmed link payload (no QR, no meta)", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          sessionId: "LinkOutputTestSess1",
          deepLink: "playground:///?appduct=abc123&pin=sha256%2Fexample",
          endpoint: { family: 4, address: "192.168.1.10", port: 8443 },
          expiresAt: Math.floor(FIXED_NOW.getTime() / 1000) + 30,
          pin: "sha256/example",
        },
      },
      {
        command: "sessions link",
        flags: flags({ json: true }),
        qr: true,
      },
    );

    expect(JSON.parse(rendered.stdout ?? "")).toEqual({
      ok: true,
      data: {
        sessionId: "LinkOutputTestSess1",
        deepLink: "playground:///?appduct=abc123&pin=sha256%2Fexample",
        endpoint: { family: 4, address: "192.168.1.10", port: 8443 },
        expiresAt: Math.floor(FIXED_NOW.getTime() / 1000) + 30,
        pin: "sha256/example",
      },
    });
  });

  test("ls human output includes alias, state, device, tools, and age", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: [
          {
            sessionId: "LsOutputTestSess001",
            alias: "pixel-8",
            state: "active",
            device: { manufacturer: "Google", model: "Pixel 8", os: "Android 14" },
            createdAt: new Date(FIXED_NOW.getTime() - 65_000).toISOString(),
            claimedAt: new Date(FIXED_NOW.getTime() - 65_000).toISOString(),
            toolCount: 3,
          },
        ],
      },
      {
        command: "sessions ls",
        flags: flags(),
        now: FIXED_NOW,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("ls human output handles an empty session list", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: [],
      },
      {
        command: "sessions ls",
        flags: flags(),
        now: FIXED_NOW,
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("keygen success output includes the key path and fingerprint", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: {
          path: "/tmp/appduct-key.pem",
          pin: "sha256/example",
        },
      },
      {
        command: "keygen",
        flags: flags(),
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("tools call human output prints the raw tool result", () => {
    const rendered = renderResult(
      {
        ok: true,
        data: { echoed: "hello" },
      },
      {
        command: "tools call",
        flags: flags(),
      },
    );

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("human tools call output embeds compact JSON by default, and indented JSON under --pretty", () => {
    const result = {
      ok: true as const,
      data: { echoed: { nested: { value: true } } },
    };

    const compact = renderResult(result, { command: "tools call", flags: flags() }).stdout ?? "";
    expect(compact).toContain('{"nested":{"value":true}}');
    expect(compact).toBe("Result\n{\"echoed\":{\"nested\":{\"value\":true}}}\n");

    const pretty = renderResult(result, { command: "tools call", flags: flags({ pretty: true }) }).stdout ?? "";
    expect(pretty).toContain('"nested": {');
    expect(pretty).toContain('"value": true');
  });

  test("human errors render on stderr", () => {
    const rendered = renderResult(
      {
        ok: false,
        error: {
          type: "tool_execution_error",
          message: "The tool handler threw.",
          details: {
            hint: "test",
          },
        },
      },
      {
        command: "tools call",
        flags: flags(),
      },
    );

    expect(rendered.stderr).toMatchSnapshot();
  });

  test("json errors preserve the wire error type verbatim, with no meta by default", () => {
    const rendered = renderResult(
      {
        ok: false,
        error: {
          type: "tool_execution_error",
          message: "The tool handler threw.",
        },
      },
      {
        command: "tools call",
        flags: flags({ json: true }),
      },
    );

    const parsed = JSON.parse(rendered.stdout ?? "");
    expect(parsed.error.type).toBe("tool_execution_error");
    expect(parsed).not.toHaveProperty("meta");
  });

  test("the Meta block renders (human and --json) exactly when the result carries meta", () => {
    const meta = { command: "tools call", timestamp: FIXED_NOW.toISOString(), duration_ms: 4 };

    const human = renderResult(
      { ok: true, data: { echoed: "hi" }, meta },
      { command: "tools call", flags: flags() },
    ).stdout;
    expect(human).toContain("Meta");
    expect(human).toContain(`Command: ${meta.command}`);
    expect(human).toContain(`Timestamp: ${meta.timestamp}`);
    expect(human).toContain(`Duration: ${meta.duration_ms} ms`);

    const humanNoMeta = renderResult(
      { ok: true, data: { echoed: "hi" } },
      { command: "tools call", flags: flags() },
    ).stdout;
    expect(humanNoMeta).not.toContain("Meta");

    const json = renderResult(
      { ok: true, data: { echoed: "hi" }, meta },
      { command: "tools call", flags: flags({ json: true }) },
    ).stdout ?? "";
    expect(JSON.parse(json).meta).toEqual(meta);
  });

  /** `appduct init`'s whole point is what it prints, so the human rendering is pinned. */
  const initResult = (changed: boolean) =>
    ({
      ok: true as const,
      data: {
        path: "/apps/demo/.appduct/config.json",
        scheme: "myapp",
        source: "app.json" as const,
        created: changed,
        changed,
        mcpServerEntry: { command: "appduct", args: ["mcp", "--scheme", "myapp"] },
        nextSteps: ['Add `import "@appduct/react-native/auto";` to your app entry.'],
      },
    });

  test("init output shows the config, the pasteable MCP entry and the next steps", () => {
    const rendered = renderResult(initResult(true), { command: "init", flags: flags() });

    expect(rendered.stdout).toMatchSnapshot();
  });

  test("init output distinguishes an idempotent re-run from a write", () => {
    const rendered = renderResult(initResult(false), { command: "init", flags: flags() });

    expect(rendered.stdout).toContain("Project Already Initialized");
    expect(rendered.stdout).toContain("unchanged");
  });

  test("init output surfaces the app.json divergence note when there is one", () => {
    const base = initResult(false);
    const rendered = renderResult(
      { ...base, data: { ...base.data, note: 'app.json declares "renamed"' } },
      { command: "init", flags: flags() },
    );

    expect(rendered.stdout).toContain('Note: app.json declares "renamed"');
  });

  test("init --json exposes the MCP entry structurally rather than as a pre-rendered string", () => {
    const rendered = renderResult(initResult(true), { command: "init", flags: flags({ json: true }) });

    expect(JSON.parse(rendered.stdout ?? "").data.mcpServerEntry).toEqual({
      command: "appduct",
      args: ["mcp", "--scheme", "myapp"],
    });
  });

  test("--json output is a single line by default, and indented under --pretty", () => {
    const result = { ok: true as const, data: { a: 1, b: { c: 2 } } };

    const compact = renderResult(result, { command: "tools call", flags: flags({ json: true }) }).stdout ?? "";
    expect(compact.replace(/\n$/u, "").split("\n")).toHaveLength(1);
    expect(JSON.parse(compact)).toEqual(result);

    const pretty = renderResult(result, { command: "tools call", flags: flags({ json: true, pretty: true }) }).stdout ?? "";
    expect(pretty.split("\n").length).toBeGreaterThan(1);
    expect(JSON.parse(pretty)).toEqual(result);
  });
});

describe("renderEventLine", () => {
  test("NDJSON mode emits parseable, verbatim JSON", () => {
    const event = { kind: "session_claimed" as const, sessionId: "s1", alias: "pixel-8", ts: 1_700_000_000_000, data: {}, seq: 1 };
    const line = renderEventLine(event, flags({ json: true }));

    expect(JSON.parse(line)).toEqual(event);
  });

  test("NDJSON stays a single line even under --pretty", () => {
    const event = {
      kind: "tools_changed" as const,
      sessionId: "s1",
      alias: "pixel-8",
      ts: 1_700_000_000_000,
      data: { toolCount: 2, nested: { a: 1 } },
      seq: 1,
    };
    const line = renderEventLine(event, flags({ json: true, pretty: true }));

    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toEqual(event);
  });

  test("human mode includes the kind and alias", () => {
    const line = renderEventLine(
      { kind: "tools_changed", sessionId: "s1", alias: "pixel-8", ts: 1_700_000_000_000, data: { toolCount: 2 }, seq: 1 },
      flags(),
    );

    expect(line).toContain("tools_changed");
    expect(line).toContain("pixel-8");
  });
});

describe("renderEventsCursorLine", () => {
  test("NDJSON mode emits a parseable { cursor, dropped, remaining } object (issue #115)", () => {
    const line = renderEventsCursorLine({ cursor: 42, dropped: 0, remaining: 0 }, flags({ json: true }));
    expect(JSON.parse(line)).toEqual({ cursor: 42, dropped: 0, remaining: 0 });
  });

  test("NDJSON stays a single line even under --pretty", () => {
    const line = renderEventsCursorLine({ cursor: 42, dropped: 0, remaining: 0 }, flags({ json: true, pretty: true }));
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({ cursor: 42, dropped: 0, remaining: 0 });
  });

  test("NDJSON mode carries non-zero dropped and remaining through unchanged (issue #115)", () => {
    const line = renderEventsCursorLine({ cursor: 12, dropped: 3, remaining: 40 }, flags({ json: true }));
    expect(JSON.parse(line)).toEqual({ cursor: 12, dropped: 3, remaining: 40 });
  });

  test("human mode includes the cursor, dropped and remaining values and the resume command (issue #115)", () => {
    const line = renderEventsCursorLine({ cursor: 12, dropped: 0, remaining: 40 }, flags());
    expect(line).toContain("cursor: 12");
    expect(line).toContain("dropped: 0");
    expect(line).toContain("remaining: 40");
    expect(line).toContain('appduct events since 12');
  });

  test("human mode includes the selector in the resume command when one was given", () => {
    const line = renderEventsCursorLine({ cursor: 3, dropped: 0, remaining: 0 }, flags(), "pixel-8");
    expect(line).toContain('appduct events since pixel-8 3');
  });

  test("NDJSON mode does not change when a selector was given", () => {
    const line = renderEventsCursorLine({ cursor: 3, dropped: 0, remaining: 0 }, flags({ json: true }), "pixel-8");
    expect(JSON.parse(line)).toEqual({ cursor: 3, dropped: 0, remaining: 0 });
  });
});

describe("daemon status rendering", () => {
  const renderStatus = (audit: DaemonStatusCommandData["audit"]): string => {
    return renderResult(
      {
        ok: true,
        data: {
          daemon: {
            version: "0.7.0",
            pid: 4242,
            started_at: FIXED_NOW.toISOString(),
            wss_port: 8443,
            pinned_keys: ["sha256/abc"],
            session_count: 1,
          },
          policy: { default: "allow", destructive: "deny" },
          audit,
        } satisfies DaemonStatusCommandData,
      },
      { command: "daemon status", flags: flags() },
    ).stdout ?? "";
  };

  test("renders the audit footprint with a human-readable size", () => {
    const stdout = renderStatus({
      path: "/tmp/state/audit",
      failed_writes: 0,
      failed_prunes: 2,
      retention_days: 30,
      files: 12,
      bytes: 1_572_864,
    });

    expect(stdout).toContain("Retention      30 days");
    expect(stdout).toContain("Files          12");
    expect(stdout).toContain("Size           1.5 MiB");
    expect(stdout).toContain("Failed prunes  2");
    expect(stdout).toMatchSnapshot();
  });

  test("scales byte sizes through the binary units, and leaves raw bytes undecorated", () => {
    // Matched loosely on the gap: `renderFields` pads labels to the widest *visible* one, which
    // changes with the rows this particular status happens to carry.
    const sizeRow = (bytes: number): string => {
      return /^ {2}Size +(.+)$/mu.exec(renderStatus({ path: "/a", failed_writes: 0, bytes, files: 1 }))?.[1] ?? "";
    };

    expect(sizeRow(0)).toBe("0 B");
    expect(sizeRow(512)).toBe("512 B");
    expect(sizeRow(1023)).toBe("1023 B");
    expect(sizeRow(1024)).toBe("1.0 KiB");
    expect(sizeRow(1536)).toBe("1.5 KiB");
    expect(sizeRow(10 * 1024 ** 3)).toBe("10.0 GiB");
    // Saturates at the largest unit rather than inventing one past TiB.
    expect(sizeRow(5 * 1024 ** 5)).toBe("5120.0 TiB");
  });

  test("omits the retention rows entirely for a daemon that predates them", () => {
    const populated = renderStatus({
      path: "/tmp/state/audit",
      failed_writes: 3,
      failed_prunes: 0,
      retention_days: 30,
      files: 1,
      bytes: 10,
    });
    const legacy = renderStatus({ path: "/tmp/state/audit", failed_writes: 3 });

    // Never "undefined", and never an invented zero — the labels simply are not there.
    expect(legacy).not.toContain("undefined");
    for (const label of ["Retention", "Files", "Size", "Failed prunes"]) {
      expect(legacy).not.toContain(label);
      expect(populated).toContain(label);
    }

    // The two must actually render differently: an implementation that printed the retention rows
    // unconditionally, or dropped them from both, would satisfy either check alone.
    expect(legacy).not.toBe(populated);
    expect(legacy.split("\n").length).toBeLessThan(populated.split("\n").length);

    expect(legacy).toContain("Failed writes  3");
    expect(legacy).toMatchSnapshot();
  });
});
