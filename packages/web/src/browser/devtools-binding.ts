import type { SocketEvents, Transport } from "../core/index.js";

/**
 * The transport for a page a relay outside it (`attachPage`) carries to the daemon. The page sends
 * `{ kind }` messages through `window.__appductBinding(json)`; the relay answers by calling
 * `__APPDUCT__.receive(json)`:
 *
 * - page to relay: `open`, `send` (with `text`), `close` (with `code` and `reason`)
 * - relay to page: `open`, `message` (with `text`), `close` (with `code` and `reason`)
 *
 * Every message carries the `id` of the socket it is about, chosen by the page on `open`. The
 * relay echoes it, so a message queued for a socket the page has since replaced is dropped
 * instead of reaching the new one. A message without an `id` (an older relay, or `attachPage`
 * closing the page's socket) goes to the active socket.
 */
export const createDevtoolsBindingTransport = (
  sendToRelay: (json: string) => void,
): { transport: Transport; receive(json: string): void } => {
  let active: { id: string; events: SocketEvents; isOpen: boolean } | undefined;
  let counter = 0;

  return {
    transport: {
      open(_url, events) {
        const entry = { id: `s${++counter}`, events, isOpen: false };
        sendToRelay(JSON.stringify({ kind: "open", id: entry.id }));
        active = entry;
        return {
          send(text) {
            if (!entry.isOpen) throw new Error("socket is not open");
            sendToRelay(JSON.stringify({ kind: "send", id: entry.id, text }));
          },
          close(code, reason) {
            sendToRelay(JSON.stringify({ kind: "close", id: entry.id, code, reason }));
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
      const message = JSON.parse(json) as { kind: string; id?: string; text?: string; code?: number; reason?: string };
      if (message.id !== undefined && message.id !== entry.id) return;
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
