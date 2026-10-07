/** What the core needs from outside the process. Each port has a memory fake beside it. */

/** Callbacks the transport invokes for one socket. A socket that fails reports `error` and then
 * `close` with no code, like a browser WebSocket. */
export type SocketEvents = {
  open(): void;
  /** One text frame. */
  message(text: string): void;
  close(code: number | undefined, reason: string | undefined): void;
  error(message: string): void;
};

export type Socket = {
  /** Throws unless the socket is open. */
  send(text: string): void;
  /** Only codes a browser `WebSocket.close` accepts: 1000, or 3000 to 4999. The core sends
   * 4008 for a protocol violation and 4011 for a failed send. */
  close(code: 1000 | 4008 | 4011, reason: string): void;
};

/** Opens a WebSocket to the daemon. */
export type Transport = {
  open(url: string, events: SocketEvents): Socket;
};

/** Keeps the one value a resume needs. The browser keeps it in `sessionStorage`. */
export type SessionStore = {
  read(): string | null;
  write(value: string): void;
  clear(): void;
};

/** Opaque handle returned by [Clock.setTimeout]. */
export type TimerHandle = unknown;

export type Clock = {
  /** Unix time in milliseconds. */
  now(): number;
  setTimeout(run: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

/** Sent on every `session_claim`. */
export type DeviceFields = {
  manufacturer: string;
  model: string;
  os: string;
};

/** How a session reaches the daemon: a page `WebSocket`, or the Playwright binding a relay outside
 * the page carries to the daemon. */
export type TransportKind = "websocket" | "devtools";

export type WebCorePorts = {
  transport: Transport;
  /** The binding transport, for a page a relay is attached to. */
  devtoolsTransport: Transport;
  sessionStore: SessionStore;
  clock: Clock;
  /** A number in [0, 1), used for reconnect jitter. */
  random: () => number;
  device: DeviceFields;
};
