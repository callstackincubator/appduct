import type { DaemonSocketEvents, OpenDaemonSocket } from "./ports.js";

/** One daemon socket the relay opened, driven by the test. */
export type MemoryDaemonSocket = {
  readonly url: string;
  /** Text frames the relay sent, in order. */
  readonly sent: string[];
  /** How the relay closed the socket, once it did. */
  readonly closedByRelay: { code: number; reason: string } | undefined;
  open(): void;
  receive(text: string): void;
  closeFromDaemon(code: number, reason: string): void;
};

export type MemoryDaemonSockets = {
  open: OpenDaemonSocket;
  readonly sockets: MemoryDaemonSocket[];
};

export const createMemoryDaemonSockets = (): MemoryDaemonSockets => {
  const sockets: MemoryDaemonSocket[] = [];

  return {
    sockets,
    open(url, events: DaemonSocketEvents) {
      const sent: string[] = [];
      let closedByRelay: { code: number; reason: string } | undefined;
      sockets.push({
        url,
        sent,
        get closedByRelay() {
          return closedByRelay;
        },
        open: () => events.open(),
        receive: (text) => events.message(text),
        closeFromDaemon: (code, reason) => events.close(code, reason),
      });
      return {
        send: (text) => void sent.push(text),
        close: (code, reason) => {
          closedByRelay ??= { code, reason };
        },
      };
    },
  };
};
