import WebSocket from "ws";

import type { OpenDaemonSocket } from "./ports.js";

/** A `ws` client. It sends no `Origin`, which the daemon's web listener lets through. */
export const openNodeDaemonSocket: OpenDaemonSocket = (url, events) => {
  const socket = new WebSocket(url);
  socket.on("open", () => events.open());
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      socket.close(4008, "binary_frame_not_supported");
      return;
    }
    events.message(data.toString());
  });
  socket.on("error", () => undefined);
  socket.on("close", (code, reason) => events.close(code, reason.toString()));
  return { send: (text) => socket.send(text), close: (code, reason) => socket.close(code, reason) };
};
