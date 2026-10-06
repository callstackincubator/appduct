import type { SocketEvents, Transport } from "./ports.js";

/** One socket the core opened, driven by the test. */
export type MemoryConnection = {
  readonly url: string;
  /** Text frames the core sent, in order. */
  readonly sent: string[];
  /** Frames the core sent, parsed. */
  frames(): Record<string, unknown>[];
  /** How the core closed the socket, once it did. */
  readonly closedByCore: { code: number; reason: string } | undefined;
  /** The socket opens; the core sends its first frame. */
  open(): void;
  /** The daemon sends a frame; an object is sent as JSON. */
  receive(frame: unknown): void;
  /** The daemon closes the socket. */
  closeFromDaemon(code?: number, reason?: string): void;
  /** The connection drops: an error, then a close with no code. */
  drop(message?: string): void;
};

export type MemoryTransport = Transport & {
  readonly connections: MemoryConnection[];
  /** The next `open` throws this. */
  failNextOpen(error: Error): void;
};

export const createMemoryTransport = (): MemoryTransport => {
  const connections: MemoryConnection[] = [];
  let nextOpenError: Error | undefined;

  return {
    connections,
    failNextOpen: (error) => {
      nextOpenError = error;
    },
    open(url, events: SocketEvents) {
      if (nextOpenError) {
        const error = nextOpenError;
        nextOpenError = undefined;
        throw error;
      }

      let isOpen = false;
      let closed = false;
      const sent: string[] = [];
      let closedByCore: { code: number; reason: string } | undefined;

      const deliverClose = (code: number | undefined, reason: string | undefined) => {
        if (closed) return;
        closed = true;
        isOpen = false;
        events.close(code, reason);
      };

      const connection: MemoryConnection = {
        url,
        sent,
        frames: () => sent.map((text) => JSON.parse(text) as Record<string, unknown>),
        get closedByCore() {
          return closedByCore;
        },
        open() {
          isOpen = true;
          events.open();
        },
        receive(frame) {
          events.message(typeof frame === "string" ? frame : JSON.stringify(frame));
        },
        closeFromDaemon: (code, reason) => deliverClose(code, reason),
        drop(message = "connection dropped") {
          if (closed) return;
          events.error(message);
          deliverClose(undefined, undefined);
        },
      };
      connections.push(connection);

      return {
        send(text) {
          if (!isOpen) throw new Error("socket is not open");
          sent.push(text);
        },
        close(code, reason) {
          // A browser WebSocket throws InvalidAccessError for any other code.
          if (code !== 1000 && !(code >= 3000 && code <= 4999)) {
            throw new Error(`InvalidAccessError: close code ${code} is not 1000 or 3000-4999`);
          }
          if (closed || closedByCore) return;
          closedByCore = { code, reason };
          // A real socket reports the close after the call returns.
          queueMicrotask(() => deliverClose(code, reason));
        },
      };
    },
  };
};
