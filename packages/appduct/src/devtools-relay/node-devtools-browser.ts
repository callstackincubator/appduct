import WebSocket from "ws";

import type { ConnectDevtoolsBrowser, DevtoolsBrowser, DevtoolsPage, DevtoolsTarget } from "./ports.js";

const BINDING = "__appductBinding";

type ListedTarget = { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string };

type CdpMessage = {
  id?: number;
  method?: string;
  params?: { name?: string; payload?: string };
  result?: { exceptionDetails?: { text: string; exception?: { description?: string } } };
  error?: { message: string };
};

const listTargets = async (browserUrl: string): Promise<ListedTarget[]> => {
  let listed: ListedTarget[];
  try {
    listed = (await (await fetch(new URL("/json/list", browserUrl))).json()) as ListedTarget[];
  } catch (error) {
    throw new Error(`Could not reach a browser at ${browserUrl}: ${(error as Error).message}. Launch Chrome with --remote-debugging-port and its own --user-data-dir.`);
  }
  return listed.filter((target) => target.type === "page");
};

/** Speaks raw CDP to one tab over its own WebSocket: no Playwright, no browser-wide session. */
const openTab = async (target: ListedTarget): Promise<DevtoolsPage> => {
  const socket = new WebSocket(target.webSocketDebuggerUrl!);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const pending = new Map<number, { resolve(result: CdpMessage["result"]): void; reject(error: Error): void }>();
  const bindingHandlers: ((json: string) => void)[] = [];
  const resetHandlers: (() => void)[] = [];
  let nextId = 0;

  const send = (method: string, params: Record<string, unknown>): Promise<CdpMessage["result"]> =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });

  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as CdpMessage;
    if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message));
      else call?.resolve(message.result);
    } else if (message.method === "Runtime.bindingCalled" && message.params?.name === BINDING) {
      bindingHandlers.forEach((handler) => handler(message.params!.payload!));
    } else if (message.method === "Runtime.executionContextsCleared") {
      resetHandlers.forEach((handler) => handler());
    }
  });
  socket.on("error", () => undefined);
  socket.on("close", () => {
    pending.forEach((call) => call.reject(new Error("The tab's debugging connection closed.")));
    pending.clear();
    resetHandlers.forEach((handler) => handler());
  });

  await send("Runtime.enable", {});
  await send("Runtime.addBinding", { name: BINDING });

  return {
    onBindingCall: (handler) => void bindingHandlers.push(handler),
    onContextReset: (handler) => void resetHandlers.push(handler),
    evaluate: async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      const failure = result?.exceptionDetails;
      if (failure) throw new Error(failure.exception?.description ?? failure.text);
    },
    close: () => socket.close(),
  };
};

/** A browser reached over its HTTP debugging endpoint, one raw-CDP WebSocket per relayed tab. */
export const connectNodeDevtoolsBrowser: ConnectDevtoolsBrowser = (browserUrl): DevtoolsBrowser => {
  const open = new Map<string, DevtoolsPage>();

  return {
    targets: async (): Promise<DevtoolsTarget[]> =>
      (await listTargets(browserUrl)).map(({ id, url, title }) => ({ id, url, title })),
    openPage: async (targetId) => {
      const target = (await listTargets(browserUrl)).find((candidate) => candidate.id === targetId);
      if (!target?.webSocketDebuggerUrl) throw new Error(`The browser at ${browserUrl} has no tab ${targetId}.`);
      open.get(targetId)?.close();
      const page = await openTab(target);
      open.set(targetId, page);
      return page;
    },
    close: () => {
      open.forEach((page) => page.close());
      open.clear();
    },
  };
};
