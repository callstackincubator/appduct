import { isSessionAckMessage, type SessionAckMessage } from "@appduct/shared";

import { newResumeLease, parseResumeLease, type ResumeLease } from "./lease.js";
import type { Socket, TransportKind, WebCorePorts } from "./ports.js";

const PROTOCOL_VERSION = 2;

/** The daemon closes the socket with 1009 on a larger frame (PROTOCOL.md section 3). */
const MAX_FRAME_BYTES = 262_144;

/** An outgoing frame over the daemon's limit; refused before it reaches the socket. */
export class FrameTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Appduct frame is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte limit.`);
  }
}

export type ConnectionOptions = {
  ip: string;
  port: number;
  sessionId: string;
  transport: TransportKind;
  /** Sends `session_claim`. */
  token?: string;
  /** Sends `session_resume` instead. */
  resumeToken?: string;
  deviceManufacturer?: string;
  deviceModel?: string;
  deviceOs?: string;
};

export type ConnectionHandlers = {
  /** The first frame after the first frame we sent: a valid `session_ack` for the session we asked for. */
  onAck(ack: SessionAckMessage): void;
  /** A frame after the ack, for the session this connection holds. */
  onMessage(message: Record<string, unknown>): void;
  /** The socket closed on its own. Not called for a close this side asked for. */
  onClose(info: {
    code: number | undefined;
    reason: string | undefined;
    error: string | undefined;
    /** Whether the socket reached open before it closed. */
    opened: boolean;
  }): void;
};

export type Connection = {
  /** Opens a socket; the first frame goes out once it is open. Throws if the transport cannot open. */
  open(options: ConnectionOptions): void;
  /** Throws unless active, or if the frame is for another session. */
  send(frame: { session_id: string } & Record<string, unknown>): void;
  /** Closes with 1000 and forgets the stored lease. Nothing is reported for it afterwards. */
  close(): void;
  /** Whether a socket is connecting or active. */
  isBusy(): boolean;
};

const formatUrl = (ip: string, port: number): string => `ws://${ip.includes(":") ? `[${ip}]` : ip}:${port}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Current = {
  options: ConnectionOptions;
  socket: Socket | undefined;
  phase: "connecting" | "active" | "failed";
  opened: boolean;
  lastError: string | undefined;
  /** Why this side closed the socket, reported from `onClose` in place of the echoed wire code. */
  closedByCore: { code: 1008 | 1011; reason: string } | undefined;
};

/**
 * One socket to the daemon: the first frame, the ack check, the lease the ack hands us, and the
 * session-id rule for every later frame (PROTOCOL.md sections 3 and 4). Port of
 * `AppductConnectionManager`, minus TLS, pinning and keepalive pings: the browser answers the
 * daemon's pings itself and offers no way to send them.
 */
export const createConnection = (ports: WebCorePorts, handlers: ConnectionHandlers): Connection => {
  const { sessionStore, clock, device } = ports;
  let current: Current | undefined;

  const markDisconnected = (sessionId: string) => {
    const lease = parseResumeLease(sessionStore.read());
    if (!lease || lease.sessionId !== sessionId || lease.disconnectedAtMs !== null) return;
    const next: ResumeLease = { ...lease, disconnectedAtMs: clock.now() };
    sessionStore.write(JSON.stringify(next));
  };

  // The browser cannot send 1008 or 1011, so the wire carries 4008 and 4011. `onClose` reports the
  // 1008 or 1011 we meant, as the Swift and Kotlin cores do for their own closes.
  const fail = (entry: Current, message: string, code: 1008 | 1011, reason: string) => {
    entry.phase = "failed";
    entry.lastError = message;
    entry.closedByCore = { code, reason };
    entry.socket?.close(code === 1008 ? 4008 : 4011, reason);
  };

  const firstFrame = (options: ConnectionOptions) =>
    options.resumeToken !== undefined
      ? {
          type: "session_resume",
          protocol_version: PROTOCOL_VERSION,
          session_id: options.sessionId,
          resume_token: options.resumeToken,
        }
      : {
          type: "session_claim",
          protocol_version: PROTOCOL_VERSION,
          session_id: options.sessionId,
          token: options.token,
          device_manufacturer: options.deviceManufacturer ?? device.manufacturer,
          device_model: options.deviceModel ?? device.model,
          device_os: options.deviceOs ?? device.os,
        };

  const isAcceptableAck = (message: Record<string, unknown>, options: ConnectionOptions): message is SessionAckMessage =>
    isSessionAckMessage(message) &&
    message.session_id === options.sessionId &&
    message.alias.length > 0 &&
    message.resume_token.length > 0 &&
    message.keepalive_interval_s > 0 &&
    message.grace_s > 0;

  const handleMessage = (entry: Current, text: string) => {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      message = undefined;
    }
    if (!isRecord(message)) {
      fail(entry, "Incoming Appduct message must be a JSON object.", 1008, "invalid_message");
      return;
    }

    if (entry.phase === "connecting") {
      if (!isAcceptableAck(message, entry.options)) {
        fail(entry, "Appduct session acknowledgement was invalid.", 1008, "invalid_ack");
        return;
      }
      // Stored before anyone hears of the ack, so a reload right after still has the rotated token.
      sessionStore.write(
        JSON.stringify(
          newResumeLease({
            sessionId: message.session_id,
            resumeToken: message.resume_token,
            alias: message.alias,
            endpoint: { ip: entry.options.ip, port: entry.options.port },
            transport: entry.options.transport,
            keepaliveIntervalS: message.keepalive_interval_s,
            graceS: message.grace_s,
          }),
        ),
      );
      entry.phase = "active";
      handlers.onAck(message);
      return;
    }

    if (message.session_id !== entry.options.sessionId) {
      fail(entry, "Incoming Appduct message does not match the active session.", 1008, "session_mismatch");
      return;
    }
    handlers.onMessage(message);
  };

  return {
    open(options) {
      const entry: Current = { options, socket: undefined, phase: "connecting", opened: false, lastError: undefined, closedByCore: undefined };
      current = entry;
      try {
        entry.socket = (options.transport === "devtools" ? ports.devtoolsTransport : ports.transport).open(formatUrl(options.ip, options.port), {
          open() {
            if (current !== entry || !entry.socket) return;
            entry.opened = true;
            try {
              entry.socket.send(JSON.stringify(firstFrame(options)));
            } catch {
              fail(entry, "Appduct session claim could not be sent because the socket is closing.", 1011, "send_failed");
            }
          },
          message(text) {
            if (current === entry) handleMessage(entry, text);
          },
          error(message) {
            if (current === entry) entry.lastError = message;
          },
          close(code, reason) {
            if (current !== entry) return;
            current = undefined;
            if (entry.closedByCore) ({ code, reason } = entry.closedByCore);
            if (code === 1000) sessionStore.clear();
            else markDisconnected(options.sessionId);
            handlers.onClose({ code, reason: reason || undefined, error: entry.lastError, opened: entry.opened });
          },
        });
      } catch (error) {
        current = undefined;
        throw error;
      }
    },

    send(frame) {
      const entry = current;
      if (!entry || entry.phase !== "active" || !entry.socket) throw new Error("Appduct session is not active.");
      if (frame.session_id !== entry.options.sessionId) {
        throw new Error("Outgoing Appduct message session_id does not match the active session.");
      }
      const text = JSON.stringify(frame);
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > MAX_FRAME_BYTES) throw new FrameTooLargeError(bytes);
      try {
        entry.socket.send(text);
      } catch {
        const message = "Appduct message could not be sent because the socket is closing.";
        fail(entry, message, 1011, "send_failed");
        throw new Error(message);
      }
    },

    close() {
      sessionStore.clear();
      const entry = current;
      current = undefined;
      entry?.socket?.close(1000, "client_close");
    },

    isBusy: () => current !== undefined && current.phase !== "failed",
  };
};
