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

    expect(sent).toEqual([{ kind: "open" }]);
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

    expect(sent.at(-1)).toEqual({ kind: "send", text: '{"type":"x"}' });
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

    expect(sent.at(-1)).toEqual({ kind: "close", code: 4008, reason: "invalid_ack" });
  });

  it("reports a daemon close as a close with its code", () => {
    const { devtools, events } = setup();
    devtools.receive(JSON.stringify({ kind: "open" }));

    devtools.receive(JSON.stringify({ kind: "close", code: 1008, reason: "invalid_token" }));

    expect(events.at(-1)).toBe("close:1008:invalid_token");
  });
});
