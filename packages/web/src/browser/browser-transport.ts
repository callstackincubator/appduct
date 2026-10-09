import type { Transport } from "../core/index.js";

/** Opens browser `WebSocket`s. A failed socket reports `error`, then `close` with code 1006, which
 * the core reads as "no code". */
export const createBrowserTransport = (): Transport => ({
  open(url, events) {
    const socket = new WebSocket(url);
    socket.onopen = () => events.open();
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") {
        socket.close(4008, "binary_frame_not_supported");
        return;
      }
      events.message(event.data);
    };
    socket.onerror = () => events.error("WebSocket error");
    socket.onclose = (event) => events.close(event.code === 1006 ? undefined : event.code, event.reason || undefined);

    return {
      send(text) {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("socket is not open");
        socket.send(text);
      },
      close: (code, reason) => socket.close(code, reason),
    };
  },
});
