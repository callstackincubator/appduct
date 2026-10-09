import { decodeBootstrap, type BootstrapPayload } from "@appduct/shared";

import type { DaemonSocket, OpenDaemonSocket, PageChannel } from "./ports.js";

/** A link from `link({ target: "web", url })`: the page URL with `#appduct=<payload>`. */
export type RelayLink = { url: string };

/** The bootstrap payload in the link's fragment. */
export const linkPayload = (link: RelayLink): string => {
  const payload = new URLSearchParams(new URL(link.url).hash.slice(1)).get("appduct");
  if (payload === null) throw new Error("The link has no #appduct= payload: pass the result of link({ target: \"web\", url }).");
  return payload;
};

/** The bootstrap a link carries; throws when the link has no payload or the payload is not an Appduct link. */
export const parseLink = (link: RelayLink): BootstrapPayload => {
  const bootstrap = decodeBootstrap(linkPayload(link));
  if (!bootstrap) throw new Error("The link's #appduct= payload is not a valid Appduct link.");
  return bootstrap;
};

/** 1001: the page that held the socket is gone, as a browser closes its own on unload. */
const GOING_AWAY = 1001;

/**
 * Carries one page's session frames between the page's binding and the daemon's web listener. The
 * page asks for a daemon socket when its transport opens, and the relay closes it when the page's
 * document is destroyed, so the daemon suspends the session and the reloaded page resumes it.
 */
export const relayPage = (page: PageChannel, link: RelayLink, openDaemonSocket: OpenDaemonSocket): void => {
  const bootstrap = parseLink(link);
  const host = bootstrap.address.includes(":") ? `[${bootstrap.address}]` : bootstrap.address;
  const url = `ws://${host}:${bootstrap.port}`;

  let current: DaemonSocket | undefined;

  const tellPage = (message: Record<string, unknown>) => {
    // The document may be gone by now; the next one announces itself.
    page.evaluate(`window.__APPDUCT__.receive(${JSON.stringify(JSON.stringify(message))})`).catch(() => undefined);
  };

  const closeCurrent = (code: number, reason: string) => {
    const socket = current;
    current = undefined;
    socket?.close(code, reason);
  };

  page.onBindingCall((json) => {
    const message = JSON.parse(json) as { kind: string; text?: string; code?: number; reason?: string };
    if (message.kind === "open") {
      closeCurrent(GOING_AWAY, "superseded");
      const socket: DaemonSocket = openDaemonSocket(url, {
        open: () => current === socket && tellPage({ kind: "open" }),
        message: (text) => current === socket && tellPage({ kind: "message", text }),
        close: (code, reason) => {
          if (current !== socket) return;
          current = undefined;
          tellPage({ kind: "close", code, reason });
        },
      });
      current = socket;
    } else if (message.kind === "send") {
      current?.send(message.text ?? "");
    } else if (message.kind === "close") {
      closeCurrent(message.code ?? 1000, message.reason ?? "");
    }
  });

  page.onContextReset(() => closeCurrent(GOING_AWAY, "page_gone"));
};
