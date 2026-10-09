import { encodeBootstrap } from "@appduct/shared";
import { describe, expect, it } from "vitest";

import {
  createMemoryDaemonSockets,
  createMemoryPageChannel,
  relayPage,
  type MemoryDaemonSockets,
  type MemoryPageChannel,
} from "../devtools-relay/index.js";

const payload = encodeBootstrap({
  family: 4,
  address: "127.0.0.1",
  port: 49152,
  sessionId: "XzAERP54_Goh74hZ",
  token: "A".repeat(43),
  expiresAt: 2_000_000_000,
});
const link = { url: `https://staging.example/#appduct=${payload}` };

const setup = (): { page: MemoryPageChannel; daemon: MemoryDaemonSockets } => {
  const page = createMemoryPageChannel();
  const daemon = createMemoryDaemonSockets();
  relayPage(page, link, daemon.open);
  return { page, daemon };
};

describe("relayPage", () => {
  it("opens a daemon socket to the link's address when the page asks for one", () => {
    const { page, daemon } = setup();

    page.call({ kind: "open" });

    expect(daemon.sockets.map((socket) => socket.url)).toEqual(["ws://127.0.0.1:49152"]);
  });

  it("opens no daemon socket until the page asks", () => {
    const { daemon } = setup();

    expect(daemon.sockets).toEqual([]);
  });

  it("tells the page the daemon socket is open", () => {
    const { page, daemon } = setup();
    page.call({ kind: "open" });

    daemon.sockets[0]!.open();

    expect(page.received()).toEqual([{ kind: "open" }]);
  });

  it("passes frames from the page to the daemon and back", () => {
    const { page, daemon } = setup();
    page.call({ kind: "open" });
    daemon.sockets[0]!.open();

    page.call({ kind: "send", text: '{"type":"session_claim"}' });
    daemon.sockets[0]!.receive('{"type":"session_ack"}');

    expect(daemon.sockets[0]!.sent).toEqual(['{"type":"session_claim"}']);
    expect(page.received().at(-1)).toEqual({ kind: "message", text: '{"type":"session_ack"}' });
  });

  it("closes the daemon socket with the page's code when the page closes it", () => {
    const { page, daemon } = setup();
    page.call({ kind: "open" });
    daemon.sockets[0]!.open();

    page.call({ kind: "close", code: 4008, reason: "invalid_ack" });

    expect(daemon.sockets[0]!.closedByRelay).toEqual({ code: 4008, reason: "invalid_ack" });
  });

  it("tells the page when the daemon closes the socket", () => {
    const { page, daemon } = setup();
    page.call({ kind: "open" });
    daemon.sockets[0]!.open();

    daemon.sockets[0]!.closeFromDaemon(1008, "invalid_token");

    expect(page.received().at(-1)).toEqual({ kind: "close", code: 1008, reason: "invalid_token" });
  });

  it("closes the daemon socket as going away when the page context is destroyed", () => {
    const { page, daemon } = setup();
    page.call({ kind: "open" });
    daemon.sockets[0]!.open();

    page.resetContext();

    expect(daemon.sockets[0]!.closedByRelay?.code).toBe(1001);
  });

  it("opens a new daemon socket for the page that follows a reload", () => {
    const { page, daemon } = setup();
    page.call({ kind: "open" });
    daemon.sockets[0]!.open();
    page.resetContext();

    page.call({ kind: "open" });

    expect(daemon.sockets).toHaveLength(2);
    expect(daemon.sockets[1]!.closedByRelay).toBeUndefined();
  });

  it("tells the page nothing about a daemon socket it has already closed", () => {
    const { page, daemon } = setup();
    page.call({ kind: "open" });
    daemon.sockets[0]!.open();
    page.resetContext();

    daemon.sockets[0]!.closeFromDaemon(1001, "going_away");

    expect(page.received()).toEqual([{ kind: "open" }]);
  });
});
