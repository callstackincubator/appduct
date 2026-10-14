import { describe, expect, it } from "vitest";

import { createDevtoolsBindingTransport } from "../browser/index.js";

const setup = () => {
  const sent: Record<string, unknown>[] = [];
  const events: string[] = [];
  const devtools = createDevtoolsBindingTransport((json) => sent.push(JSON.parse(json) as Record<string, unknown>));
  const socket = devtools.transport.open("ws://127.0.0.1:49152", {
    open: () => events.push("open"),
    message: (text) => events.push(`message:${text}`),
    close: (code, reason) => events.push(`close:${code}:${reason}`),
    error: (message) => events.push(`error:${message}`),
  });
  return { devtools, socket, sent, events };
};

describe("the devtools binding transport", () => {
  it("asks the relay for a daemon socket when opened", () => {
    const { sent } = setup();

    expect(sent).toEqual([{ kind: "open", id: expect.any(String) }]);
  });

  it("reports the socket open once the relay says the daemon socket is", () => {
    const { devtools, events } = setup();

    devtools.receive(JSON.stringify({ kind: "open" }));

    expect(events).toEqual(["open"]);
  });

  it("passes frames both ways through the binding", () => {
    const { devtools, socket, sent, events } = setup();
    devtools.receive(JSON.stringify({ kind: "open" }));

    socket.send('{"type":"x"}');
    devtools.receive(JSON.stringify({ kind: "message", text: '{"type":"y"}' }));

    expect(sent.at(-1)).toMatchObject({ kind: "send", text: '{"type":"x"}' });
    expect(events.at(-1)).toBe('message:{"type":"y"}');
  });

  it("refuses to send before the daemon socket is open", () => {
    const { socket } = setup();

    expect(() => socket.send("{}")).toThrow(/not open/u);
  });

  it("tells the relay to close the daemon socket when the core closes", () => {
    const { devtools, socket, sent } = setup();
    devtools.receive(JSON.stringify({ kind: "open" }));

    socket.close(4008, "invalid_ack");

    expect(sent.at(-1)).toMatchObject({ kind: "close", code: 4008, reason: "invalid_ack" });
  });

  it("reports a daemon close as a close with its code", () => {
    const { devtools, events } = setup();
    devtools.receive(JSON.stringify({ kind: "open" }));

    devtools.receive(JSON.stringify({ kind: "close", code: 1008, reason: "invalid_token" }));

    expect(events.at(-1)).toBe("close:1008:invalid_token");
  });

  it("puts the same id on every message it sends for one socket", () => {
    const { devtools, socket, sent } = setup();
    devtools.receive(JSON.stringify({ kind: "open", id: sent[0]!.id }));

    socket.send("{}");
    socket.close(1000, "done");

    expect(typeof sent[0]!.id).toBe("string");
    expect(sent.map((message) => message.id)).toEqual([sent[0]!.id, sent[0]!.id, sent[0]!.id]);
  });

  it("gives each socket it opens its own id", () => {
    const { devtools, sent } = setup();

    devtools.transport.open("ws://127.0.0.1:49152", { open() {}, message() {}, close() {}, error() {} });

    expect(sent[1]!.id).not.toBe(sent[0]!.id);
  });

  it("drops a message the relay tagged for an earlier socket", () => {
    const { devtools, sent, events } = setup();
    const first = sent[0]!.id;
    const second: string[] = [];
    devtools.transport.open("ws://127.0.0.1:49152", {
      open: () => second.push("open"),
      message: (text) => second.push(`message:${text}`),
      close: (code, reason) => second.push(`close:${code}:${reason}`),
      error: () => undefined,
    });

    devtools.receive(JSON.stringify({ kind: "open", id: first }));
    devtools.receive(JSON.stringify({ kind: "message", id: first, text: '{"type":"session_ack"}' }));
    devtools.receive(JSON.stringify({ kind: "close", id: first, code: 1006, reason: "" }));

    expect(second).toEqual([]);
    expect(events).toEqual([]);
  });

  it("delivers a message the relay tagged for the active socket", () => {
    const { devtools, sent, events } = setup();

    devtools.receive(JSON.stringify({ kind: "open", id: sent[0]!.id }));

    expect(events).toEqual(["open"]);
  });

  it("delivers a message without an id to the active socket", () => {
    const { devtools, events } = setup();

    devtools.receive(JSON.stringify({ kind: "open" }));
    devtools.receive(JSON.stringify({ kind: "message", text: '{"type":"y"}' }));

    expect(events).toEqual(["open", 'message:{"type":"y"}']);
  });

  it("still delivers what the relay tags for the new socket after dropping the old one's", () => {
    const { devtools, socket, sent } = setup();
    const first = sent[0]!.id;
    socket.close(1000, "superseded");
    const events: string[] = [];
    devtools.transport.open("ws://127.0.0.1:49152", {
      open: () => events.push("open"),
      message: (text) => events.push(`message:${text}`),
      close: (code, reason) => events.push(`close:${code}:${reason}`),
      error: (message) => events.push(`error:${message}`),
    });
    const second = sent.filter((message) => message.kind === "open")[1]!.id;

    devtools.receive(JSON.stringify({ kind: "open", id: first }));
    devtools.receive(JSON.stringify({ kind: "close", id: first, code: 1006, reason: "" }));
    devtools.receive(JSON.stringify({ kind: "open", id: second }));

    expect(events).toEqual(["open"]);
  });
});
