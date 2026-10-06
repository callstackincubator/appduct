/**
 * The daemon's web listener (issue #168, slice 1 of #164): a plain-HTTP WebSocket listener on
 * `127.0.0.1` that browsers can reach without pinning the daemon's self-signed certificate, and the
 * web links that can only be claimed there. Every case drives a real daemon over its control socket
 * and a Node `WebSocket` client, the stand-in for a page.
 */

import { connect as connectUds } from "node:net";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { decodeBootstrap } from "@appduct/shared";

import { link } from "../client/index.js";
import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { handleConnectTool } from "../mcp/connect-tool.js";
import { callDaemon } from "../rpc/client.js";
import { makeTempStateDir, removeStateDir, runCliWithCapture } from "./fixtures.js";

const LOCAL_ORIGIN = "http://localhost:5173";
const PAGE_URL = "http://localhost:5173/dashboard";

const runningDaemons: RunningDaemon[] = [];
const stateDirs: string[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (stateDirs.length > 0) {
    await removeStateDir(stateDirs.pop()!);
  }
});

const startTestDaemon = async (
  config: Record<string, unknown> = {},
): Promise<{ daemon: RunningDaemon; stateDir: string }> => {
  const stateDir = await makeTempStateDir(config, { prefix: "appduct-web-listener-" });
  stateDirs.push(stateDir);

  const daemon = await startDaemon({ stateDir });
  runningDaemons.push(daemon);

  return { daemon, stateDir };
};

const rpcCall = <T>(daemon: RunningDaemon, method: string, params: unknown = {}): Promise<T> => {
  return new Promise((resolve, reject) => {
    const socket = connectUds(daemon.paths.socketPath);
    let buffer = "";

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      if (!buffer.includes("\n")) {
        return;
      }

      socket.destroy();
      const parsed = JSON.parse(buffer.split("\n")[0]!) as { result?: T; error?: { message: string } };

      if (parsed.error) {
        reject(new Error(parsed.error.message));
        return;
      }

      resolve(parsed.result as T);
    });

    socket.once("error", reject);
  });
};

type MintedLink = { sessionId: string; token: string; address: string; port: number };

const mintLink = async (daemon: RunningDaemon, transport?: "web" | "native"): Promise<MintedLink> => {
  const result = await rpcCall<{ deepLinkPayload: string }>(daemon, "link.create", {
    ttlSeconds: 60,
    ...(transport === undefined ? {} : { transport }),
  });
  const decoded = decodeBootstrap(result.deepLinkPayload)!;

  return { sessionId: decoded.sessionId, token: decoded.token, address: decoded.address, port: decoded.port };
};

const webPortOf = async (daemon: RunningDaemon): Promise<number> => {
  const status = await rpcCall<{ webPort: number }>(daemon, "daemon.status");
  return status.webPort;
};

type Resume = { sessionId: string; resumeToken: string };

type Outcome =
  | { kind: "ack"; message: Record<string, unknown> }
  | { kind: "closed"; code: number; reason: string }
  | { kind: "refused"; statusCode: number };

/** Connects, optionally sends a claim, and reports how the daemon answered. */
const attempt = (
  url: string,
  options: { origin?: string; claim?: MintedLink; resume?: Resume; ca?: string },
): Promise<Outcome> => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    });

    socket.once("unexpected-response", (_request, response) => {
      resolve({ kind: "refused", statusCode: response.statusCode ?? 0 });
    });
    socket.once("error", (error) => {
      if (!/Unexpected server response/u.test(error.message)) {
        reject(error);
      }
    });
    socket.once("message", (data) => {
      resolve({ kind: "ack", message: JSON.parse(data.toString("utf8")) });
    });
    socket.once("close", (code, reason) => {
      resolve({ kind: "closed", code, reason: reason.toString("utf8") });
    });
    socket.once("open", () => {
      if (options.resume) {
        socket.send(
          JSON.stringify({
            type: "session_resume",
            protocol_version: 2,
            session_id: options.resume.sessionId,
            resume_token: options.resume.resumeToken,
          }),
        );
      }

      if (options.claim) {
        socket.send(
          JSON.stringify({
            type: "session_claim",
            protocol_version: 2,
            session_id: options.claim.sessionId,
            token: options.claim.token,
            device_model: "Chrome",
          }),
        );
      }
    });
  });
};

const connectWeb = (daemon: RunningDaemon, claim: MintedLink, origin: string | undefined = LOCAL_ORIGIN) =>
  webPortOf(daemon).then((port) => attempt(`ws://127.0.0.1:${port}`, { origin, claim }));

describe("web links", () => {
  test("a web link encodes 127.0.0.1 and the web port, not the TLS port", async () => {
    const { daemon } = await startTestDaemon({ advertisedIp: "203.0.113.9" });

    const web = await mintLink(daemon, "web");

    expect(web.address).toBe("127.0.0.1");
    expect(web.port).toBe(await webPortOf(daemon));
    expect(web.port).not.toBe(daemon.listener.port());
  });

  test("daemon status reports the web port", async () => {
    const { daemon } = await startTestDaemon();

    expect(await webPortOf(daemon)).toBeGreaterThan(0);
  });

  test("appduct daemon status --json reports the web port", async () => {
    const { daemon, stateDir } = await startTestDaemon();

    const result = await runCliWithCapture(["daemon", "status", "--json", "--state-dir", stateDir]);

    const { data } = JSON.parse(result.stdout) as { data: { daemon: { web_port: number } } };
    expect(data.daemon.web_port).toBe(await webPortOf(daemon));
  });

  test("a native link still encodes the TLS port", async () => {
    const { daemon } = await startTestDaemon();

    expect((await mintLink(daemon)).port).toBe(daemon.listener.port());
    expect((await mintLink(daemon, "native")).port).toBe(daemon.listener.port());
  });
});

describe("web listener: claiming", () => {
  test("a Node WebSocket with a web link and a localhost Origin claims a session that sessions ls shows", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const minted = await mintLink(daemon, "web");

    const outcome = await connectWeb(daemon, minted);

    expect(outcome).toMatchObject({
      kind: "ack",
      message: { type: "session_ack", status: "ok", session_id: minted.sessionId },
    });

    const listed = await runCliWithCapture(["sessions", "ls", "--json", "--state-dir", stateDir]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(minted.sessionId);
  });

  test.each(["http://127.0.0.1:3000", "http://[::1]:8081", "https://localhost"])(
    "accepts the loopback Origin %s on any port",
    async (origin) => {
      const { daemon } = await startTestDaemon();

      const outcome = await connectWeb(daemon, await mintLink(daemon, "web"), origin);

      expect(outcome.kind).toBe("ack");
    },
  );

  test("accepts a connection that sends no Origin", async () => {
    const { daemon } = await startTestDaemon();
    const port = await webPortOf(daemon);

    const outcome = await attempt(`ws://127.0.0.1:${port}`, { claim: await mintLink(daemon, "web") });

    expect(outcome.kind).toBe("ack");
  });
});

describe("web listener: Origin check", () => {
  test.each(["https://evil.example", "http://localhost.evil.example", "http://127.0.0.1.evil.example", "null"])(
    "refuses the foreign Origin %s with 403",
    async (origin) => {
      const { daemon } = await startTestDaemon();
      const port = await webPortOf(daemon);

      const outcome = await attempt(`ws://127.0.0.1:${port}`, { origin });

      expect(outcome).toEqual({ kind: "refused", statusCode: 403 });
    },
  );

  test("a refused Origin does not use up the link", async () => {
    const { daemon } = await startTestDaemon();
    const minted = await mintLink(daemon, "web");
    const port = await webPortOf(daemon);

    await attempt(`ws://127.0.0.1:${port}`, { origin: "https://evil.example", claim: minted });

    expect((await connectWeb(daemon, minted)).kind).toBe("ack");
  });

  test("accepts an Origin listed in webOrigins", async () => {
    const { daemon } = await startTestDaemon({ webOrigins: ["https://app.example.test"] });

    const outcome = await connectWeb(daemon, await mintLink(daemon, "web"), "https://app.example.test");

    expect(outcome.kind).toBe("ack");
  });

  test("still refuses an Origin that only resembles one listed in webOrigins", async () => {
    const { daemon } = await startTestDaemon({ webOrigins: ["https://app.example.test"] });
    const port = await webPortOf(daemon);

    const outcome = await attempt(`ws://127.0.0.1:${port}`, { origin: "https://app.example.test.evil.example" });

    expect(outcome).toEqual({ kind: "refused", statusCode: 403 });
  });

  test("rejects a webOrigins that is not a list of strings", async () => {
    const stateDir = await makeTempStateDir({ webOrigins: "https://app.example.test" });
    stateDirs.push(stateDir);

    await expect(startDaemon({ stateDir })).rejects.toThrow(/webOrigins/u);
  });
});

describe("links are bound to their transport", () => {
  test("a web link presented on the TLS listener is refused and stays claimable on the web listener", async () => {
    const { daemon } = await startTestDaemon();
    const minted = await mintLink(daemon, "web");

    const onTls = await attempt(`wss://127.0.0.1:${daemon.listener.port()!}`, {
      claim: minted,
      ca: daemon.tls.current().certPem,
    });

    expect(onTls).toMatchObject({ kind: "closed", code: 1008, reason: "wrong_transport" });
    expect((await connectWeb(daemon, minted)).kind).toBe("ack");
  });

  test("a native link presented on the web listener is refused and stays claimable over TLS", async () => {
    const { daemon } = await startTestDaemon();
    const minted = await mintLink(daemon, "native");

    const onWeb = await connectWeb(daemon, minted);

    expect(onWeb).toMatchObject({ kind: "closed", code: 1008, reason: "wrong_transport" });

    const onTls = await attempt(`wss://127.0.0.1:${daemon.listener.port()!}`, {
      claim: minted,
      ca: daemon.tls.current().certPem,
    });
    expect(onTls.kind).toBe("ack");
  });

  test("a web link that was already claimed is refused", async () => {
    const { daemon } = await startTestDaemon();
    const minted = await mintLink(daemon, "web");
    expect((await connectWeb(daemon, minted)).kind).toBe("ack");

    expect(await connectWeb(daemon, minted)).toMatchObject({ kind: "closed", code: 1008, reason: "already_claimed" });
  });

  test("an expired web link is refused", async () => {
    const { daemon } = await startTestDaemon();
    const result = await rpcCall<{ deepLinkPayload: string }>(daemon, "link.create", {
      ttlSeconds: 1,
      transport: "web",
    });
    const decoded = decodeBootstrap(result.deepLinkPayload)!;
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const outcome = await connectWeb(daemon, { ...decoded });

    expect(outcome).toMatchObject({ kind: "closed", code: 1008, reason: "link_expired" });
  });
});

const resumeOf = (minted: MintedLink, outcome: Outcome): Resume => {
  if (outcome.kind !== "ack") {
    throw new Error("expected an ack");
  }

  return { sessionId: minted.sessionId, resumeToken: outcome.message.resume_token as string };
};

describe("resume is bound to the transport the session was claimed on", () => {
  const onTls = (daemon: RunningDaemon, resume: Resume) =>
    attempt(`wss://127.0.0.1:${daemon.listener.port()!}`, { resume, ca: daemon.tls.current().certPem });
  const onWeb = (daemon: RunningDaemon, resume: Resume) =>
    webPortOf(daemon).then((port) => attempt(`ws://127.0.0.1:${port}`, { origin: LOCAL_ORIGIN, resume }));

  test("a session claimed on the web listener cannot be resumed over TLS", async () => {
    const { daemon } = await startTestDaemon();
    const minted = await mintLink(daemon, "web");
    const resume = resumeOf(minted, await connectWeb(daemon, minted));

    expect(await onTls(daemon, resume)).toMatchObject({ kind: "closed", code: 1008, reason: "wrong_transport" });
  });

  test("a session claimed over TLS cannot be resumed on the web listener", async () => {
    const { daemon } = await startTestDaemon();
    const minted = await mintLink(daemon, "native");
    const claimed = await attempt(`wss://127.0.0.1:${daemon.listener.port()!}`, {
      claim: minted,
      ca: daemon.tls.current().certPem,
    });
    const resume = resumeOf(minted, claimed);

    expect(await onWeb(daemon, resume)).toMatchObject({ kind: "closed", code: 1008, reason: "wrong_transport" });
  });

  test("a refused cross-listener resume leaves the resume token valid on the right listener", async () => {
    const { daemon } = await startTestDaemon();
    const minted = await mintLink(daemon, "web");
    const resume = resumeOf(minted, await connectWeb(daemon, minted));
    await onTls(daemon, resume);

    expect((await onWeb(daemon, resume)).kind).toBe("ack");
  });
});

describe("web target surfaces", () => {
  const payloadOf = (url: string): string => url.split("#appduct=")[1]!;

  test("appduct sessions link --open web <url> returns the URL with the fragment and the connect script", async () => {
    const { daemon, stateDir } = await startTestDaemon();

    const result = await runCliWithCapture([
      "sessions",
      "link",
      "--open",
      "web",
      PAGE_URL,
      "--json",
      "--state-dir",
      stateDir,
    ]);

    expect(result.exitCode).toBe(0);
    const { data } = JSON.parse(result.stdout) as { data: { url: string; script: string } };
    const payload = payloadOf(data.url);
    expect(data.url).toBe(`${PAGE_URL}#appduct=${payload}`);
    expect(data.script).toBe(`window.__APPDUCT__.connect("${payload}")`);
    expect(decodeBootstrap(payload)).toMatchObject({ address: "127.0.0.1", port: await webPortOf(daemon) });
  });

  test("appduct sessions link --open web without a URL is a usage error", async () => {
    const { stateDir } = await startTestDaemon();

    const result = await runCliWithCapture(["sessions", "link", "--open", "web", "--json", "--state-dir", stateDir]);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/url/iu);
  });

  test("appduct sessions link --open web replaces a fragment already on the URL", async () => {
    const { stateDir } = await startTestDaemon();

    const result = await runCliWithCapture([
      "sessions",
      "link",
      "--open",
      "web",
      `${PAGE_URL}#old`,
      "--json",
      "--state-dir",
      stateDir,
    ]);

    expect(result.exitCode).toBe(0);
    const { data } = JSON.parse(result.stdout) as { data: { url: string } };
    expect(data.url).toMatch(/^http:\/\/localhost:5173\/dashboard#appduct=[\w-]+$/u);
  });

  test("appduct_connect with target web returns the URL and the script, with no scheme configured", async () => {
    const { daemon, stateDir } = await startTestDaemon();

    const result = (await handleConnectTool(
      { target: "web", url: PAGE_URL },
      { call: (method, params) => callDaemon(method, params, { stateDir }) },
    )) as unknown as { url: string; script: string };

    const payload = payloadOf(result.url);
    expect(result.url).toBe(`${PAGE_URL}#appduct=${payload}`);
    expect(result.script).toBe(`window.__APPDUCT__.connect("${payload}")`);
    expect(decodeBootstrap(payload)).toMatchObject({ port: await webPortOf(daemon) });
  });

  test("appduct_connect with target web and no url is invalid", async () => {
    const { stateDir } = await startTestDaemon();

    await expect(
      handleConnectTool({ target: "web" }, { call: (method, params) => callDaemon(method, params, { stateDir }) }),
    ).rejects.toThrow(/url/iu);
  });

  test("appduct/client link() with target web returns the URL and the script", async () => {
    const { daemon, stateDir } = await startTestDaemon();

    const result = (await link({ stateDir, target: "web", url: PAGE_URL })) as unknown as {
      url: string;
      script: string;
    };

    const payload = payloadOf(result.url);
    expect(result.url).toBe(`${PAGE_URL}#appduct=${payload}`);
    expect(result.script).toBe(`window.__APPDUCT__.connect("${payload}")`);
    expect(decodeBootstrap(payload)).toMatchObject({ port: await webPortOf(daemon) });
  });

  test("a link minted for the web target is claimed on the web listener", async () => {
    const { daemon, stateDir } = await startTestDaemon();
    const result = (await link({ stateDir, target: "web", url: PAGE_URL })) as unknown as { url: string };
    const decoded = decodeBootstrap(payloadOf(result.url))!;

    const outcome = await connectWeb(daemon, decoded);

    expect(outcome.kind).toBe("ack");
  });
});
