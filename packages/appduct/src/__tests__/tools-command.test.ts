/**
 * `commands/tools.ts` against a daemon that predates tool groups: its `tools.list` result has no
 * `groups` and it ignores the `group` param. The version guard normally restarts such a daemon;
 * when it could not, `--group`/`--groups` must fail loudly rather than render the whole registry
 * as one group, or "No tools registered." for a registry that has tools.
 */

import { describe, expect, test, vi } from "vitest";

const callDaemon = vi.fn();

vi.mock("../rpc/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rpc/client.js")>();
  return { ...actual, callDaemon: (...args: unknown[]) => callDaemon(...args) };
});

const { handleToolsCommand } = await import("../commands/tools.js");

const oldDaemonResult = {
  tools: [{ name: "add_item", description: "Adds.", group: "cart", policy: "allow" }],
  total: 1,
};

describe("tools command against a daemon without group support", () => {
  test("--groups and --group report the unsupported daemon instead of a wrong listing", async () => {
    callDaemon.mockResolvedValue(oldDaemonResult);

    await expect(handleToolsCommand({ groups: true }, { stateDir: "/unused" })).rejects.toMatchObject({
      type: "connection_error",
    });
    await expect(handleToolsCommand({ group: "cart" }, { stateDir: "/unused" })).rejects.toMatchObject({
      type: "connection_error",
    });
  });

  test("a plain listing still works", async () => {
    callDaemon.mockResolvedValue(oldDaemonResult);

    const result = await handleToolsCommand({ filter: "add" }, { stateDir: "/unused" });
    expect(result.ok).toBe(true);
  });
});
