import { describe, expect, test } from "vitest";

import { makeAppClient } from "../client/app-client.js";
import type { DaemonStream } from "../rpc/client.js";

const toolEntry = {
  name: "ping",
  description: "Ping.",
  input_schema: { type: "object" },
  policy: "allow",
};

const streamAnswering = (result: unknown): DaemonStream => {
  return {
    call: async <T>() => result as T,
    onNotification: () => () => {},
    onClose: () => () => {},
    close: () => {},
  };
};

describe("AppClient.tools()", () => {
  test("unwraps the `{ tools, total }` tools.list result", async () => {
    const listed = { ...toolEntry, group: "diagnostics" };
    const client = makeAppClient(streamAnswering({ tools: [listed], total: 1 }), "s1");
    expect(await client.tools()).toEqual([listed]);
  });

  test("still accepts a bare array from a daemon that predates `{ tools, total }`", async () => {
    const client = makeAppClient(streamAnswering([toolEntry]), "s1");
    // That daemon predates tool groups too and sends no `group` key. Every entry carries one, so
    // `tool.group === null` answers "ungrouped" here as it does anywhere else.
    expect(await client.tools()).toEqual([{ ...toolEntry, group: null }]);
  });
});
