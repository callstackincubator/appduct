/**
 * The pinned-TLS WebSocket listener and the plain-HTTP web listener (ARCHITECTURE.md §7). Both put
 * the same thin frame-level gate in front of
 * `SessionManager`: JSON/binary/size hygiene, the pre-claim timeout, and post-claim
 * type/session-id routing. All state-machine decisions (claim/resume/registry/close-code choice)
 * live in sessions.ts — this module never inspects session state itself.
 *
 * Every socket gets an `error` listener the instant it is accepted, and the server itself gets one
 * too: v1's fatal defect was an unhandled `'error'` event crashing the whole daemon. A socket
 * closing — for any reason — must never stop the listener or any other session.
 */

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type Server as NetServer } from "node:net";

import {
  isSessionClaimMessage,
  isSessionResumeMessage,
  isSessionBoundMessage,
  type LinkTransport,
} from "@appduct/shared";
import { WebSocketServer } from "ws";

import { isPostClaimMessageType, type SessionManager } from "./sessions.js";
import type { TlsManager, TlsMaterial } from "./tls.js";
import { systemTimers, type TimerFns } from "./timers.js";

const DEFAULT_PRE_CLAIM_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;
/** How many OS-assigned ports to try before giving up when each one is taken on `127.0.0.1`. */
const MAX_PORT_ATTEMPTS = 5;

export type ListenerOptions = {
  /** `0` asks the OS for a free port. */
  port: number;
  /** Also bind `127.0.0.1` on the same port (issue #249). macOS lets another program bind
   * `127.0.0.1:<port>` under a wildcard listener and then routes loopback clients to it; holding
   * that address ourselves stops it. Linux refuses that bind for everyone, us included, because
   * the wildcard listener already covers loopback there. */
  bindLoopback: boolean;
  tls: TlsManager;
  sessionManager: SessionManager;
  preClaimTimeoutMs?: number;
  timers?: TimerFns;
};

export type DaemonListener = {
  httpsServer: HttpsServer;
  wss: WebSocketServer;
  port: () => number | undefined;
  /** Applies freshly-minted cert/key material to already-accepted-connections' future TLS
   * handshakes (`tls.Server.setSecureContext`, ARCHITECTURE.md §4/§8: re-mint on advertised-IP
   * change). Existing connections are unaffected — only new handshakes see the new SAN. */
  applyTls: (material: Pick<TlsMaterial, "certPem" | "keyPem">) => void;
  close: () => Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

type FrameGateOptions = {
  sessionManager: SessionManager;
  /** The listener this gate sits on: a claim is only valid for links minted for it. */
  transport: LinkTransport;
  preClaimTimeoutMs: number;
  timers: TimerFns;
};

/** The frame-level gate both listeners share. Installed on the `WebSocketServer`, so it does not
 * care which server the sockets arrive through. */
const attachFrameGate = (wss: WebSocketServer, options: FrameGateOptions): void => {
  const { timers, preClaimTimeoutMs } = options;

  wss.on("connection", (socket) => {
    socket.on("error", () => {
      // The 'close' event still fires after 'error' and drives session suspend/cleanup.
    });

    let claimedSessionId: string | null = null;

    const preClaimTimer = timers.setTimeout(() => {
      if (!claimedSessionId) {
        socket.close(1008, "pre_claim_timeout");
      }
    }, preClaimTimeoutMs);

    socket.once("close", () => {
      timers.clearTimeout(preClaimTimer);
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "binary_frame_not_supported");
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        socket.close(1008, "invalid_json");
        return;
      }

      if (!isRecord(parsed)) {
        socket.close(1008, "invalid_json");
        return;
      }

      if (claimedSessionId === null) {
        if (isSessionClaimMessage(parsed)) {
          const result = options.sessionManager.handleClaim(socket, parsed, options.transport);

          if (result) {
            claimedSessionId = result;
            timers.clearTimeout(preClaimTimer);
          }

          return;
        }

        if (isSessionResumeMessage(parsed)) {
          const result = options.sessionManager.handleResume(socket, parsed, options.transport);

          if (result) {
            claimedSessionId = result;
            timers.clearTimeout(preClaimTimer);
          }

          return;
        }

        socket.close(1008, "expected_claim_or_resume");
        return;
      }

      if (!isPostClaimMessageType(parsed.type)) {
        socket.close(1008, "unknown_message_type");
        return;
      }

      if (!isSessionBoundMessage(parsed) || parsed.session_id !== claimedSessionId) {
        socket.close(1008, "session_mismatch");
        return;
      }

      options.sessionManager.handlePostClaimMessage(claimedSessionId, socket, parsed);
    });
  });
};

const listen = (server: NetServer, port: number, host?: string): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
};

const closeServer = (wss: WebSocketServer, server: HttpServer | HttpsServer): Promise<void> => {
  return new Promise<void>((resolve) => {
    for (const client of wss.clients) {
      client.terminate();
    }

    wss.close(() => {
      // `server.close()` alone only stops accepting new connections — it waits for existing
      // (including idle keep-alive) sockets to end, which could hang shutdown indefinitely.
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });
};

const boundPort = (server: HttpServer | HttpsServer): number | undefined => {
  const address = server.address();
  return address && typeof address !== "string" ? address.port : undefined;
};

const isAddressInUse = (error: unknown): boolean => {
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
};

const portInUseError = (port: number): Error => {
  return new Error(
    `Port ${port} is already in use by another program. Stop that program, or set a different wssPort in config.json.`,
  );
};

export const startListener = async (options: ListenerOptions): Promise<DaemonListener> => {
  const timers = options.timers ?? systemTimers;
  const preClaimTimeoutMs = options.preClaimTimeoutMs ?? DEFAULT_PRE_CLAIM_TIMEOUT_MS;
  const material = options.tls.current();

  const httpsServer = createHttpsServer({ key: material.keyPem, cert: material.certPem });

  httpsServer.on("error", () => {
    // A listener-level error (e.g. a transient accept failure) must never crash the daemon.
    // Startup failures are still surfaced via the one-shot listener below.
  });

  const wss = new WebSocketServer({ server: httpsServer, maxPayload: MAX_PAYLOAD_BYTES });

  wss.on("error", () => {
    // Same contract as the https server: never let a listener-level error take the daemon down.
  });

  attachFrameGate(wss, { sessionManager: options.sessionManager, transport: "native", preClaimTimeoutMs, timers });

  // The wildcard bind, plus with `bindLoopback` a plain TCP server on `127.0.0.1` at the same port
  // that hands each connection to `httpsServer`, so both addresses share one TLS context, one
  // `WebSocketServer` and one frame gate. A configured port taken on either address fails startup;
  // an OS-assigned port taken on `127.0.0.1` is given back and another one tried.
  let loopbackServer: NetServer | undefined;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await listen(httpsServer, options.port);
    } catch (error) {
      throw isAddressInUse(error) ? portInUseError(options.port) : error;
    }

    if (!options.bindLoopback) {
      break;
    }

    const port = boundPort(httpsServer)!;
    const candidate = createNetServer((socket) => httpsServer.emit("connection", socket));

    candidate.on("error", () => {
      // Same contract as the https server: never let a listener-level error take the daemon down.
    });

    try {
      await listen(candidate, port, "127.0.0.1");
      loopbackServer = candidate;
      break;
    } catch (error) {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));

      if (!isAddressInUse(error)) {
        throw error;
      }

      if (options.port !== 0) {
        throw portInUseError(port);
      }

      if (attempt === MAX_PORT_ATTEMPTS) {
        throw new Error(`Could not find a free port: ${MAX_PORT_ATTEMPTS} ports in a row were in use on 127.0.0.1.`);
      }
    }
  }

  return {
    httpsServer,
    wss,
    port: () => boundPort(httpsServer),
    applyTls: (nextMaterial) => {
      // Keep this guard for compatibility with runtimes whose `node:https` shim omits the method.
      const server = httpsServer as HttpsServer & {
        setSecureContext?: (context: { key: string; cert: string }) => void;
      };

      server.setSecureContext?.({ key: nextMaterial.keyPem, cert: nextMaterial.certPem });
    },
    close: () => {
      loopbackServer?.close();
      return closeServer(wss, httpsServer);
    },
  };
};

export type WebListenerOptions = {
  sessionManager: SessionManager;
  /** Origins allowed in addition to localhost, `127.0.0.1` and `[::1]` on any port. Compared
   * as exact strings against the `Origin` header (`config.json`'s `webOrigins`). */
  origins: readonly string[];
  preClaimTimeoutMs?: number;
  timers?: TimerFns;
};

export type WebListener = {
  port: () => number | undefined;
  close: () => Promise<void>;
};

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);

    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
};

/**
 * The plain-HTTP listener web pages connect to, bound to `127.0.0.1` on an OS-assigned port. A
 * browser cannot pin the daemon's self-signed certificate, so it cannot use the TLS listener.
 * Instead every upgrade is checked against its `Origin` header and refused with 403 unless that
 * is a loopback origin or listed in `origins`. A request with no `Origin` is let through: only a
 * local non-browser process sends none, and it could connect to the daemon anyway.
 */
export const startWebListener = async (options: WebListenerOptions): Promise<WebListener> => {
  const timers = options.timers ?? systemTimers;
  const preClaimTimeoutMs = options.preClaimTimeoutMs ?? DEFAULT_PRE_CLAIM_TIMEOUT_MS;
  const allowed = new Set(options.origins);

  const httpServer = createHttpServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("Appduct web listener: WebSocket upgrades only.");
  });

  httpServer.on("error", () => {
    // Same contract as the TLS listener: never let a listener-level error take the daemon down.
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: ({ origin }, callback) => {
      if (origin === undefined || isLoopbackOrigin(origin) || allowed.has(origin)) {
        callback(true);
      } else {
        callback(false, 403, "Forbidden");
      }
    },
  });

  wss.on("error", () => {});

  attachFrameGate(wss, { sessionManager: options.sessionManager, transport: "web", preClaimTimeoutMs, timers });

  await listen(httpServer, 0, "127.0.0.1");

  return {
    port: () => boundPort(httpServer),
    close: () => closeServer(wss, httpServer),
  };
};
