import { encodeBootstrap } from "@appduct/shared";
import { describe, expect, it } from "vitest";

import { attachPage, type AttachablePage } from "../client/index.js";

const payload = encodeBootstrap({
  family: 4,
  address: "127.0.0.1",
  port: 49152,
  sessionId: "XzAERP54_Goh74hZ",
  token: "A".repeat(43),
  expiresAt: 2_000_000_000,
});
const link = { url: `https://staging.example/#appduct=${payload}` };

/** A page that records what the relay runs in it; `connectFails` makes the page's `connect` reject. */
const fakePage = () => {
  const frame = {};
  const evaluated: string[] = [];
  let failConnect = false;
  const page: AttachablePage = {
    exposeBinding: async () => undefined,
    addInitScript: async () => undefined,
    evaluate: async (expression) => {
      evaluated.push(expression);
      if (failConnect && expression.includes(".connect(")) throw new Error("connect failed");
    },
    waitForFunction: async () => undefined,
    mainFrame: () => frame,
    on: () => undefined,
  };
  return { page, evaluated, failNextConnect: () => (failConnect = true) };
};

const closes = (evaluated: string[]) => evaluated.filter((expression) => expression.includes(".receive(") && expression.includes("close"));

describe("attachPage", () => {
  it("rejects a re-attach with an invalid link before touching the first link's socket", async () => {
    const { page, evaluated } = fakePage();
    await attachPage(page, { link });

    await expect(attachPage(page, { link: { url: "https://staging.example/" } })).rejects.toThrow(/#appduct=/);
    await expect(attachPage(page, { link: { url: "https://staging.example/#appduct=garbage" } })).rejects.toThrow(/not a valid Appduct link/);

    expect(closes(evaluated)).toEqual([]);
  });

  it("tells the page its transport closed when a re-attach drops the old socket and then fails", async () => {
    const { page, evaluated, failNextConnect } = fakePage();
    await attachPage(page, { link });

    failNextConnect();
    await expect(attachPage(page, { link })).rejects.toThrow();

    expect(closes(evaluated)).toHaveLength(1);
  });
});
