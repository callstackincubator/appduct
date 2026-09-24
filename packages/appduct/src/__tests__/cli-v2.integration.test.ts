/**
 * The noun-verb command table of §10 (issue #96) works end-to-end against a real daemon in an
 * integration test (temp state dir): keygen -> daemon auto-spawn via `sessions ls` -> `sessions
 * link` -> fake app client claims -> `sessions ls` shows the alias ACTIVE -> `tools
 * ls`/`describe`/`call` round-trip -> `sessions revoke`. Every command here runs as a real CLI
 * subprocess (`bin.ts`) against a real daemon it auto-spawns, driven by a scripted fake app client
 * (`ws`) — the same harness pattern as `tool-invocation.integration.test.ts`, just through the CLI
 * instead of raw UDS RPC.
 */

import path from "node:path";
import { text } from "node:stream/consumers";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { decodeBootstrap } from "@appduct/shared";

import {
  makeTempStateDir as makeSharedStateDir,
  removeStateDir,
  spawnCliBinary,
  waitForExit,
} from "./fixtures.js";

// The fake app client below skips pinning (that is the app SDK's job, exercised in
// session-engine.integration.test.ts); the leaf-cert check is disabled process-wide for this
// file's throwaway self-signed daemon key.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const stateDirs: string[] = [];
const daemonPids: number[] = [];

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  while (daemonPids.length > 0) {
    const pid = daemonPids.pop()!;
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  while (stateDirs.length > 0) {
    await removeStateDir(stateDirs.pop()!);
  }
});

const makeTempStateDir = async (configOverrides: Record<string, unknown> = {}): Promise<string> => {
  const directory = await makeSharedStateDir(
    { scheme: "appduct-e2e", ...configOverrides },
    { prefix: "appduct-cli-v2-" },
  );

  stateDirs.push(directory);
  return directory;
};

type CliJsonResult = { ok: boolean; data?: unknown; error?: { type: string; message: string } };

/**
 * Runs the CLI as a subprocess and returns its parsed `--json` output. It uses an async process:
 * several flows below (`invoke`) need the daemon to round-trip through this
 * test's own fake app WebSocket client while the CLI subprocess is in flight — `spawnSync` blocks
 * this process's event loop for the subprocess's entire lifetime, which would starve that
 * WebSocket's `message` handler and deadlock the round-trip.
 */
const runCliJson = async (args: string[], stateDir: string): Promise<CliJsonResult> => {
  const proc = spawnCliBinary([...args, "--json"], { stateDir });

  const [stdout, stderr] = await Promise.all([
    text(proc.stdout),
    text(proc.stderr),
  ]);
  await waitForExit(proc);

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Failed to parse CLI JSON output for ${args.join(" ")}: ${(error as Error).message}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
};

/** Runs the CLI as a subprocess and returns its raw stdout/stderr, human-rendered (no `--json`) —
 * used only where a test asserts on the human text itself (`--filter`/`--limit`/`--offset`'s
 * "Showing" line, the per-tool signature line), everything else goes through {@link runCliJson}. */
const runCliHuman = async (args: string[], stateDir: string): Promise<{ stdout: string; stderr: string }> => {
  const proc = spawnCliBinary(args, { stateDir });

  const [stdout, stderr] = await Promise.all([text(proc.stdout), text(proc.stderr)]);
  await waitForExit(proc);

  return { stdout, stderr };
};

/** Headings are colored even when piped (the CLI's palette is not TTY-gated), so line-level
 * assertions compare the text without SGR sequences. */
const stripAnsi = (value: string): string => value.replace(/\[[0-9;]*m/gu, "");

const connectFakeApp = (port: number): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
};

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> => {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
};

describe("appduct CLI v2: end-to-end command table", () => {
  test(
    "keygen -> sessions ls auto-spawns -> sessions link -> claim -> sessions ls ACTIVE -> tools ls/describe/call round-trip -> sessions revoke",
    async () => {
      const stateDir = await makeTempStateDir();

      // keygen: fully non-interactive, refuses to overwrite without --force.
      const keygenPath = path.join(stateDir, "operator-key.pem");
      const keygenResult = await runCliJson(["keygen", "--out", keygenPath], stateDir);
      expect(keygenResult.ok).toBe(true);
      expect((keygenResult.data as { pin: string }).pin).toMatch(/^sha256\//u);

      const keygenAgain = await runCliJson(["keygen", "--out", keygenPath], stateDir);
      expect(keygenAgain.ok).toBe(false);
      expect(keygenAgain.error?.type).toBe("usage_error");

      // ls: no sessions yet, and this is the call that auto-spawns the daemon.
      const firstLs = await runCliJson(["sessions", "ls"], stateDir);
      expect(firstLs.ok).toBe(true);
      expect(firstLs.data).toEqual([]);

      const status = await runCliJson(["daemon", "status"], stateDir);
      expect(status.ok).toBe(true);
      daemonPids.push((status.data as { daemon: { pid: number } }).daemon.pid);
      // The state dir asks for an OS-assigned wss port (`wssPort: 0`), so the number is only
      // knowable from the running daemon — which is also what a link must end up advertising.
      const port = (status.data as { daemon: { wss_port: number } }).daemon.wss_port;
      expect(port).toBeGreaterThan(0);

      // link: mint a pending session and decode its deep link.
      const linkResult = await runCliJson(["sessions", "link", "--ttl", "60"], stateDir);
      expect(linkResult.ok).toBe(true);
      const linkData = linkResult.data as { sessionId: string; deepLink: string; endpoint: { port: number } };
      expect(linkData.deepLink.startsWith("appduct-e2e:///?appduct=")).toBe(true);
      expect(linkData.endpoint.port).toBe(port);

      // The deep link now also carries a separate `&pin=...` query param after the bootstrap blob
      // (opt-in hardening dev-mode); only the `appduct=` value up to the next `&` decodes.
      const payload = linkData.deepLink
        .slice(linkData.deepLink.indexOf("appduct=") + "appduct=".length)
        .split("&")[0]!;
      const decoded = decodeBootstrap(payload);
      expect(decoded).not.toBeNull();

      // fake app client claims the link.
      const appSocket = await connectFakeApp(port);
      appSocket.send(
        JSON.stringify({
          type: "session_claim",
          protocol_version: 2,
          session_id: decoded!.sessionId,
          token: decoded!.token,
          device_model: "Pixel 8",
          device_os: "Android 14",
        }),
      );
      const ack = await nextMessage(appSocket);
      expect(ack.status).toBe("ok");
      const alias = ack.alias as string;

      appSocket.send(
        JSON.stringify({
          type: "tool_registry_snapshot",
          session_id: decoded!.sessionId,
          tools: [
            {
              name: "echo",
              description: "Echoes its input.",
              input_schema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        }),
      );
      // Give the snapshot a moment to land before the next CLI subprocess reads it.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // ls: the claimed session shows up ACTIVE with its device metadata and tool count.
      const secondLs = await runCliJson(["sessions", "ls"], stateDir);
      expect(secondLs.ok).toBe(true);
      const sessions = secondLs.data as Array<{ alias: string; state: string; toolCount: number }>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.alias).toBe(alias);
      expect(sessions[0]!.state).toBe("active");
      expect(sessions[0]!.toolCount).toBe(1);

      // tools: list, then detail by name.
      const toolsList = await runCliJson(["tools", "ls", alias], stateDir);
      expect(toolsList.ok).toBe(true);
      const toolsListData = toolsList.data as { tools: Array<{ name: string }>; total: number };
      expect(toolsListData.tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(toolsListData.total).toBe(1);

      const toolsDetail = await runCliJson(["tools", "describe", alias, "echo"], stateDir);
      expect(toolsDetail.ok).toBe(true);
      expect((toolsDetail.data as { name: string; input_schema?: unknown }).input_schema).toEqual({
        type: "object",
        properties: { text: { type: "string" } },
      });

      // `describe` with no selector resolves against the one active session (issue #96: no more
      // probing a single positional as "selector or name" — the verb says which it is).
      const toolsDetailImplicit = await runCliJson(["tools", "describe", "echo"], stateDir);
      expect(toolsDetailImplicit.ok).toBe(true);
      expect((toolsDetailImplicit.data as { name: string }).name).toBe("echo");

      // A name that matches nothing is a clean "not registered" error, not "unknown session" —
      // there is no selector here for the daemon to have misread the name as.
      const toolsDetailMissing = await runCliJson(["tools", "describe", "does-not-exist"], stateDir);
      expect(toolsDetailMissing.ok).toBe(false);
      expect(toolsDetailMissing.error?.type).toBe("usage_error");
      expect(toolsDetailMissing.error?.message).toBe('Tool "does-not-exist" is not registered.');

      // invoke: round-trip through the fake app.
      appSocket.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "tool_call") {
          appSocket.send(
            JSON.stringify({
              type: "tool_result",
              session_id: decoded!.sessionId,
              id: msg.id,
              result: { echoed: (msg.args as Record<string, unknown>).text },
            }),
          );
        }
      });

      const invokeResult = await runCliJson(
        ["tools", "call", alias, "echo", "--input", JSON.stringify({ text: "hello" })],
        stateDir,
      );
      expect(invokeResult.ok).toBe(true);
      expect(invokeResult.data).toEqual({ echoed: "hello" });

      // invoke a nonexistent tool: the wire error type is preserved verbatim.
      const invokeMissing = await runCliJson(["tools", "call", alias, "does-not-exist", "--input", "{}"], stateDir);
      expect(invokeMissing.ok).toBe(false);
      expect(invokeMissing.error?.type).toBe("tool_not_found");

      // revoke: the session disappears from ls.
      const revokeResult = await runCliJson(["sessions", "revoke", alias], stateDir);
      expect(revokeResult.ok).toBe(true);
      expect(revokeResult.data).toEqual({ ok: true });

      const finalLs = await runCliJson(["sessions", "ls"], stateDir);
      expect(finalLs.ok).toBe(true);
      expect(finalLs.data).toEqual([]);

      appSocket.close();

      const stopResult = await runCliJson(["daemon", "stop"], stateDir);
      expect(stopResult.ok).toBe(true);
    },
    20_000,
  );

  test(
    "ambiguous_session lists the live aliases so the user can retry with a selector",
    async () => {
      const stateDir = await makeTempStateDir();

      const status = await runCliJson(["daemon", "status"], stateDir);
      expect(status.ok).toBe(true);
      daemonPids.push((status.data as { daemon: { pid: number } }).daemon.pid);

      const port = (status.data as { daemon: { wss_port: number } }).daemon.wss_port;
      expect(port).toBeGreaterThan(0);

      const claimOne = async (deviceModel: string): Promise<{ socket: WebSocket; alias: string }> => {
        const linkResult = await runCliJson(["sessions", "link", "--ttl", "60"], stateDir);
        const linkData = linkResult.data as { deepLink: string };
        const linkPayload = linkData.deepLink
          .slice(linkData.deepLink.indexOf("appduct=") + "appduct=".length)
          .split("&")[0]!;
        const decoded = decodeBootstrap(linkPayload)!;

        const socket = await connectFakeApp(port);
        socket.send(
          JSON.stringify({
            type: "session_claim",
            protocol_version: 2,
            session_id: decoded.sessionId,
            token: decoded.token,
            device_model: deviceModel,
          }),
        );
        const ack = await nextMessage(socket);
        return { socket, alias: ack.alias as string };
      };

      const first = await claimOne("Pixel 8");
      const second = await claimOne("Pixel 8");

      const toolsResult = await runCliJson(["tools", "ls"], stateDir);
      expect(toolsResult.ok).toBe(false);
      expect(toolsResult.error?.type).toBe("ambiguous_session");
      expect(toolsResult.error?.message).toContain(first.alias);
      expect(toolsResult.error?.message).toContain(second.alias);

      first.socket.close();
      second.socket.close();

      const stopResult = await runCliJson(["daemon", "stop"], stateDir);
      expect(stopResult.ok).toBe(true);
    },
    15_000,
  );

  test(
    "tools --filter/--limit/--offset page a large registry, a name lookup still resolves under paging, and human output is a signature listing",
    async () => {
      const stateDir = await makeTempStateDir();

      const status = await runCliJson(["daemon", "status"], stateDir);
      expect(status.ok).toBe(true);
      daemonPids.push((status.data as { daemon: { pid: number } }).daemon.pid);
      // `wssPort: 0` in the state dir, so the bound port is only known from the daemon itself.
      const port = (status.data as { daemon: { wss_port: number } }).daemon.wss_port;
      expect(port).toBeGreaterThan(0);

      const linkResult = await runCliJson(["sessions", "link", "--ttl", "60"], stateDir);
      const linkData = linkResult.data as { deepLink: string };
      const linkPayload = linkData.deepLink
        .slice(linkData.deepLink.indexOf("appduct=") + "appduct=".length)
        .split("&")[0]!;
      const decoded = decodeBootstrap(linkPayload)!;

      const socket = await connectFakeApp(port);
      socket.send(
        JSON.stringify({
          type: "session_claim",
          protocol_version: 2,
          session_id: decoded.sessionId,
          token: decoded.token,
          device_model: "Pixel 8",
        }),
      );
      const ack = await nextMessage(socket);
      const alias = ack.alias as string;

      // ~30 tools, `tool_00`..`tool_29`, already sorted so the ordering assertions below double as
      // a smoke check that the daemon's own sort doesn't re-scramble an already-sorted registry.
      const toolNames = Array.from({ length: 30 }, (_, index) => `tool_${String(index).padStart(2, "0")}`);
      socket.send(
        JSON.stringify({
          type: "tool_registry_snapshot",
          session_id: decoded.sessionId,
          tools: toolNames.map((name) => ({
            name,
            description: `Does something with ${name}.`,
            input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          })),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Unpaged: `{ tools, total }`, total tools registered.
      const unpaged = await runCliJson(["tools", "ls", alias], stateDir);
      expect(unpaged.ok).toBe(true);
      const unpagedData = unpaged.data as { tools: Array<{ name: string }>; total: number };
      expect(unpagedData.tools).toHaveLength(30);
      expect(unpagedData.total).toBe(30);

      // --filter narrows both the page and `total`.
      const filtered = await runCliJson(["tools", "ls", alias, "--filter", "tool_1"], stateDir);
      expect(filtered.ok).toBe(true);
      const filteredData = filtered.data as { tools: Array<{ name: string }>; total: number };
      // tool_10..tool_19 (substring match on the name), still name-sorted.
      expect(filteredData.total).toBe(10);
      expect(filteredData.tools.map((tool) => tool.name)).toEqual(toolNames.slice(10, 20));

      // --limit/--offset returns the right slice of the sorted, unfiltered registry.
      const paged = await runCliJson(["tools", "ls", alias, "--limit", "5", "--offset", "5"], stateDir);
      expect(paged.ok).toBe(true);
      const pagedData = paged.data as { tools: Array<{ name: string }>; total: number };
      expect(pagedData.tools.map((tool) => tool.name)).toEqual(toolNames.slice(5, 10));
      expect(pagedData.total).toBe(30);

      // A name lookup still resolves even though it would fall outside a small page.
      const detailUnderPaging = await runCliJson(["tools", "describe", alias, "tool_29", "--limit", "1"], stateDir);
      expect(detailUnderPaging.ok).toBe(false);
      expect(detailUnderPaging.error?.type).toBe("usage_error");

      const detail = await runCliJson(["tools", "describe", alias, "tool_29"], stateDir);
      expect(detail.ok).toBe(true);
      expect((detail.data as { name: string }).name).toBe("tool_29");

      // `describe`'s listing flags are rejected next to a `<name>` the same as an explicit `<sel> <name>`.
      const describeWithLimit = await runCliJson(["tools", "describe", "tool_29", "--limit", "1"], stateDir);
      expect(describeWithLimit.ok).toBe(false);
      expect(describeWithLimit.error?.type).toBe("usage_error");

      // A numeric-looking filter is matched as text, verbatim (cac alone would turn "07" into 7).
      const numericFilter = await runCliJson(["tools", "ls", alias, "--filter", "07"], stateDir);
      expect(numericFilter.ok).toBe(true);
      const numericFilterData = numericFilter.data as { tools: Array<{ name: string }>; total: number; filter: string };
      expect(numericFilterData.tools.map((tool) => tool.name)).toEqual(["tool_07"]);
      expect(numericFilterData.filter).toBe("07");

      // An offset past the end is an empty page of a non-empty registry, not "No tools registered".
      const pastEnd = await runCliHuman(["tools", "ls", alias, "--offset", "100"], stateDir);
      expect(pastEnd.stdout).toContain("No tools at offset 100; 30 matching tools in total.");
      expect(pastEnd.stdout).not.toContain("No tools registered");

      // Human output: a signature line per tool, and the "Showing" line once the page truncates.
      const human = await runCliHuman(["tools", "ls", alias, "--limit", "5"], stateDir);
      expect(human.stdout).toContain("tool_00(value: string)");
      expect(human.stdout).toContain("Showing 5 of 30 tools (offset 0).");
      expect(human.stdout).toContain("Run `appduct tools describe <name>` for a tool's full schema.");

      socket.close();

      const stopResult = await runCliJson(["daemon", "stop"], stateDir);
      expect(stopResult.ok).toBe(true);
    },
    20_000,
  );

  test(
    "tools on a grouped registry: headings, the group-aware footer, --group (parent and subgroup), --groups, and usage errors",
    async () => {
      const stateDir = await makeTempStateDir();

      const status = await runCliJson(["daemon", "status"], stateDir);
      expect(status.ok).toBe(true);
      daemonPids.push((status.data as { daemon: { pid: number } }).daemon.pid);
      const port = (status.data as { daemon: { wss_port: number } }).daemon.wss_port;

      const linkResult = await runCliJson(["sessions", "link", "--ttl", "60"], stateDir);
      const linkData = linkResult.data as { deepLink: string };
      const linkPayload = linkData.deepLink
        .slice(linkData.deepLink.indexOf("appduct=") + "appduct=".length)
        .split("&")[0]!;
      const decoded = decodeBootstrap(linkPayload)!;

      const socket = await connectFakeApp(port);
      socket.send(
        JSON.stringify({
          type: "session_claim",
          protocol_version: 2,
          session_id: decoded.sessionId,
          token: decoded.token,
          device_model: "Pixel 8",
        }),
      );
      const ack = await nextMessage(socket);
      const alias = ack.alias as string;

      // The #67 large-registry shape, split into three groups — `checkout` with a `payment`
      // subgroup — plus ungrouped tools: 12 cart, 5 checkout + 3 checkout/payment, 6 flags, 4 none.
      const tool = (name: string, group?: string) => ({
        name,
        description: `Does something with ${name}.`,
        ...(group !== undefined ? { group } : {}),
      });
      const tools = [
        ...Array.from({ length: 12 }, (_, index) => tool(`cart_${String(index).padStart(2, "0")}`, "cart")),
        ...Array.from({ length: 5 }, (_, index) => tool(`checkout_${index}`, "checkout")),
        ...Array.from({ length: 3 }, (_, index) => tool(`payment_${index}`, "checkout/payment")),
        ...Array.from({ length: 6 }, (_, index) => tool(`flag_${index}`, "flags")),
        ...Array.from({ length: 4 }, (_, index) => tool(`misc_${index}`)),
      ];
      socket.send(JSON.stringify({ type: "tool_registry_snapshot", session_id: decoded.sessionId, tools }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // --json: `group` on each entry, `groups` on the listing (whole registry, parent first).
      const json = await runCliJson(["tools", "ls", alias], stateDir);
      expect(json.ok).toBe(true);
      const jsonData = json.data as {
        tools: Array<{ name: string; group?: string }>;
        total: number;
        groups: Array<{ group: string | null; total: number }>;
      };
      expect(jsonData.total).toBe(30);
      expect(jsonData.tools.find((entry) => entry.name === "payment_0")?.group).toBe("checkout/payment");
      expect(jsonData.groups).toEqual([
        { group: "cart", total: 12 },
        { group: "checkout", total: 8 },
        { group: "checkout/payment", total: 3 },
        { group: "flags", total: 6 },
        { group: null, total: 4 },
      ]);

      // Human listing: group headings, a subgroup as an indented sub-heading, ungrouped last.
      const human = await runCliHuman(["tools", "ls", alias], stateDir);
      const lines = stripAnsi(human.stdout).split("\n");
      const indexOfLine = (line: string) => lines.indexOf(line);
      expect(indexOfLine("  cart")).toBeGreaterThan(-1);
      expect(indexOfLine("    cart_00()")).toBe(indexOfLine("  cart") + 1);
      expect(indexOfLine("  checkout")).toBeGreaterThan(indexOfLine("  cart"));
      expect(indexOfLine("    checkout/payment")).toBeGreaterThan(indexOfLine("  checkout"));
      expect(indexOfLine("      payment_0()")).toBe(indexOfLine("    checkout/payment") + 1);
      expect(indexOfLine("  flags")).toBeGreaterThan(indexOfLine("    checkout/payment"));
      expect(indexOfLine("  (ungrouped)")).toBeGreaterThan(indexOfLine("  flags"));
      expect(indexOfLine("    misc_0()")).toBe(indexOfLine("  (ungrouped)") + 1);
      // Nothing was left out, so no footer.
      expect(human.stdout).not.toContain("Showing");

      // Truncated: the footer names the top-level groups (never subgroups) to narrow to.
      const truncated = await runCliHuman(["tools", "ls", alias, "--limit", "5"], stateDir);
      expect(truncated.stdout).toContain(
        "Showing 5 of 30 tools (offset 0). Narrow with --group <name> (groups: cart 12, checkout 8, flags 6) " +
          "or --filter <text>, or page with --offset <n>.",
      );

      // --group <parent>: includes the subgroup; `total` is the group's size.
      const parent = await runCliJson(["tools", "ls", alias, "--group", "checkout"], stateDir);
      const parentData = parent.data as { tools: Array<{ name: string }>; total: number; group: string };
      expect(parentData.total).toBe(8);
      expect(parentData.group).toBe("checkout");
      expect(parentData.tools.map((entry) => entry.name)).toEqual([
        "checkout_0",
        "checkout_1",
        "checkout_2",
        "checkout_3",
        "checkout_4",
        "payment_0",
        "payment_1",
        "payment_2",
      ]);

      // --group <parent>/<sub>: exactly the subgroup, flat (no headings), under its own title.
      const sub = await runCliHuman(["tools", "ls", alias, "--group", "checkout/payment"], stateDir);
      expect(stripAnsi(sub.stdout)).toContain("Tools in group checkout/payment");
      expect(sub.stdout).toContain("  payment_0()");
      expect(sub.stdout).not.toContain("checkout_0");
      expect(sub.stdout).not.toContain("(ungrouped)");

      // An empty group (matching is case-sensitive) is not an empty registry.
      const unknownGroup = await runCliHuman(["tools", "ls", alias, "--group", "Cart"], stateDir);
      expect(stripAnsi(unknownGroup.stdout)).toContain(
        'Tools in group Cart\n  No tools in group "Cart". Run `appduct tools ls --groups` to see the session\'s groups.',
      );

      // --group combines with --filter and paging; the footer drops the group hint once narrowed.
      const combined = await runCliHuman(["tools", "ls", alias, "--group", "cart", "--filter", "cart_1", "--limit", "1"], stateDir);
      expect(combined.stdout).toContain("Showing 1 of 2 tools (offset 0). Narrow with --filter <text> or page with --offset <n>.");

      // --groups: groups and counts only, subgroups indented under their parent.
      const groupsHuman = await runCliHuman(["tools", "ls", alias, "--groups"], stateDir);
      expect(stripAnsi(groupsHuman.stdout)).toContain("Groups\n  cart                12\n  checkout             8\n    checkout/payment   3\n  flags                6\n  (ungrouped)          4\n");
      expect(groupsHuman.stdout).not.toContain("cart_00");

      const groupsJson = await runCliJson(["tools", "ls", alias, "--groups"], stateDir);
      expect(groupsJson.data).toEqual({ groups: jsonData.groups, total: 30 });

      // Usage errors: a listing flag with a tool name, --groups with a narrowing flag, a bad group.
      for (const args of [
        ["tools", "describe", alias, "cart_00", "--group", "cart"],
        ["tools", "describe", "cart_00", "--group", "cart"],
        ["tools", "describe", alias, "cart_00", "--groups"],
        ["tools", "ls", alias, "--groups", "--group", "cart"],
        ["tools", "ls", alias, "--groups", "--filter", "x"],
        ["tools", "ls", alias, "--groups", "--full"],
        ["tools", "ls", alias, "--groups", "--limit", "2"],
        ["tools", "ls", alias, "--groups", "--offset", "1"],
        // `describe cart_00 --groups`: a listing flag on a lookup, unambiguous now.
        ["tools", "describe", "cart_00", "--groups"],
        ["tools", "ls", alias, "--group", "a/b/c"],
        ["tools", "ls", alias, "--group", "checkout/"],
      ]) {
        const result = await runCliJson(args, stateDir);
        expect(result.ok, args.join(" ")).toBe(false);
        expect(result.error?.type, args.join(" ")).toBe("usage_error");
      }

      // `--groups checkout` (a value on a boolean flag) points at `--group` instead of failing as
      // an unknown session.
      const groupsWithValue = await runCliJson(["tools", "ls", "--groups", "checkout"], stateDir);
      expect(groupsWithValue.ok).toBe(false);
      expect(groupsWithValue.error?.type).toBe("usage_error");
      expect(groupsWithValue.error?.message).toContain('use "--group checkout"');

      socket.close();

      const stopResult = await runCliJson(["daemon", "stop"], stateDir);
      expect(stopResult.ok).toBe(true);
    },
    30_000,
  );
});
