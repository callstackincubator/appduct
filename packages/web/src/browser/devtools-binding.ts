import type { SocketEvents, Transport } from "../core/index.js";

/**
 * The transport for a page a relay outside it (`attachPage`) carries to the daemon. The page sends
 * `{ kind }` messages through `window.__appductBinding(json)`; the relay answers by calling
 * `__APPDUCT__.receive(json)`:
 *
 * - page to relay: `open` (with `socket`), `send` (with `text`), `close` (with `code` and `reason`)
 * - relay to page: `open`, `message` (with `text`), `close` (with `code` and `reason`), each with
 *   the `socket` of the `open` it answers
 *
 * `socket` numbers the page's sockets, so a message the relay sent for one the page has since
 * replaced is dropped instead of reaching the new socket's handshake. A message without one (an
 * older relay, or `attachPage` closing the page's socket) goes to the open socket.
 */
export const createDevtoolsBindingTransport = (
  sendToRelay: (json: string) => void,
): { transport: Transport; receive(json: string): void } => {
  let active: { id: number; events: SocketEvents; isOpen: boolean } | undefined;
  let lastId = 0;

  return {
    transport: {
      open(_url, events) {
        lastId += 1;
        const entry = { id: lastId, events, isOpen: false };
        sendToRelay(JSON.stringify({ kind: "open", socket: entry.id }));
        active = entry;
        return {
          send(text) {
            if (!entry.isOpen) throw new Error("socket is not open");
            sendToRelay(JSON.stringify({ kind: "send", text }));
          },
          close(code, reason) {
            sendToRelay(JSON.stringify({ kind: "close", code, reason }));
            entry.isOpen = false;
            if (active === entry) active = undefined;
            // The relay does not report the close it was asked for, so the page reports it, as a
            // browser WebSocket does.
            queueMicrotask(() => events.close(code, reason));
          },
        };
      },
    },
    receive(json) {
      const entry = active;
      if (!entry) return;
      const message = JSON.parse(json) as { kind: string; socket?: number; text?: string; code?: number; reason?: string };
      if (message.socket !== undefined && message.socket !== entry.id) return;
      if (message.kind === "open") {
        entry.isOpen = true;
        entry.events.open();
      } else if (message.kind === "message") {
        entry.events.message(message.text ?? "");
      } else {
        entry.isOpen = false;
        active = undefined;
        entry.events.close(message.code, message.reason);
      }
    },
  };
};
