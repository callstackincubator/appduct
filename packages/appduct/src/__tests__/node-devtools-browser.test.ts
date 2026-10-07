import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { connectNodeDevtoolsBrowser } from "../devtools-relay/index.js";

const servers: Server[] = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
});

/** A loopback endpoint whose tab list names `debuggerUrl` for tab T1, and a socket server on the same port. */
const listen = async (debuggerUrl: (port: number) => string): Promise<{ browserUrl: string; paths: string[] }> => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    const { port } = server.address() as AddressInfo;
    expect(request.url).toBe("/json/list");
    response.end(JSON.stringify([{ id: "T1", type: "page", url: "https://staging.example/", title: "Shop", webSocketDebuggerUrl: debuggerUrl(port) }]));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    paths.push(request.url!);
    socket.on("message", (data) => socket.send(JSON.stringify({ id: (JSON.parse(data.toString()) as { id: number }).id, result: {} })));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { browserUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
};

describe("connectNodeDevtoolsBrowser", () => {
  it("opens the tab's socket on the browserUrl's host even when the listing names another host", async () => {
    const { browserUrl, paths } = await listen(() => "ws://evil.invalid:1/devtools/page/T1");
    const browser = connectNodeDevtoolsBrowser(browserUrl);

    const page = await browser.openPage("T1");

    expect(paths).toEqual(["/devtools/page/T1"]);
    page.close();
  });
});
