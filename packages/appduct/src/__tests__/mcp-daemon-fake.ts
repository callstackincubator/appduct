/**
 * An in-memory stand-in for the daemon's control-socket connection, for the MCP server tests that
 * are about the MCP server and nothing else.
 *
 * `createMcpServer` talks to the daemon only through `DaemonStream` (`rpc/client.ts`), which is
 * four functions: `call`, `onNotification`, `onClose`, `close`. Name mapping, output-schema
 * degradation, `<alias>__<name>` namespacing and `list_changed` are decided entirely from what
 * comes back over those four — a real daemon adds a pidfile, a self-signed certificate, a wss
 * listener and a scripted app on a WebSocket, none of which any of those behaviours depends on,
 * and all of which can fail on their own. The cases that genuinely exercise the real transport
 * (progress correlation over a second stream, cancellation, real policy denial) still run against
 * a real daemon in `mcp-server.integration.test.ts`.
 *
 * This fake answers the four methods the server actually calls — `sessions.list`, `tools.list`,
 * `tools.call`, `events.subscribe` — and can push `event` notifications, which is how
 * `list_changed` is driven. Anything else throws, loudly, rather than returning a plausible
 * nothing: a silently-answered method the server did not expect would make a test pass for the
 * wrong reason.
 */

import {
  RPC_METHODS,
  type ErrorType,
  type EventNotification,
  type SessionSummary,
  type ToolDescriptor,
  type ToolsListEntry,
} from "@appduct/shared";

import { DaemonRpcError } from "../rpc/client.js";
import type { DaemonStream } from "../rpc/client.js";

/** What a fake tool does when called. Return a value for `tool_result`; throw
 * {@link toolError} for a `tool_error` the daemon would have forwarded verbatim. */
export type FakeToolHandler = (args: Record<string, unknown>) => unknown;

export type FakeSessionOptions = {
  alias: string;
  sessionId?: string;
  deviceModel?: string;
};

/** The daemon's `tools.list` entry shape: a full descriptor plus the resolved effective policy. */
type FakeToolEntry = ToolsListEntry;

export type FakeSession = {
  readonly alias: string;
  readonly sessionId: string;
  /** Replaces this session's registry, exactly as a `tool_registry_snapshot` frame would, and
   * pushes the `tools_changed` event the daemon would have emitted. */
  setTools: (tools: Array<Partial<ToolDescriptor> & { name: string; policy?: FakeToolEntry["policy"] }>) => void;
  /** Registers what a tool returns (or throws) when called. */
  onCall: (name: string, handler: FakeToolHandler) => void;
};

export type FakeDaemon = {
  /** Pass as `createMcpServer`'s `openStream`. Every stream it hands out — the startup one and
   * each short-lived progress one — is backed by this same state. */
  openStream: () => Promise<DaemonStream>;
  addSession: (options: FakeSessionOptions) => FakeSession;
  removeSession: (alias: string) => void;
  /** Methods the server called, in order — so a test can assert on what reached "the daemon". */
  calls: () => ReadonlyArray<{ method: string; params: unknown }>;
};

/** A `tool_error` the daemon forwards verbatim to the caller (ARCHITECTURE.md §5: "App-side error
 * types must be preserved **verbatim** end-to-end"). */
export const toolError = (type: ErrorType, message: string, details?: unknown): DaemonRpcError => {
  return new DaemonRpcError(-32000, message, { type, ...(details === undefined ? {} : { details }) });
};

export const createFakeDaemon = (): FakeDaemon => {
  const sessions: SessionSummary[] = [];
  const toolsByAlias = new Map<string, FakeToolEntry[]>();
  const handlersByAlias = new Map<string, Map<string, FakeToolHandler>>();
  const calls: Array<{ method: string; params: unknown }> = [];
  // Every open stream that has subscribed, so a pushed event fans out the way the daemon's own
  // `events.subscribe` fan-out does.
  const subscribers = new Set<(payload: unknown) => void>();
  let nextSeq = 1;

  const emit = (event: Omit<EventNotification, "seq" | "ts">): void => {
    const payload = { ...event, ts: Date.now(), seq: nextSeq++ } as EventNotification;

    for (const notify of [...subscribers]) {
      notify(payload);
    }
  };

  /** The daemon's selector rules (`daemon/sessions.ts`'s `resolveSession`): an alias or session
   * id, or with none given, the sole live session. */
  const resolveSession = (selector: string | undefined): SessionSummary => {
    if (selector !== undefined) {
      const match = sessions.find((session) => session.sessionId === selector || session.alias === selector);

      if (!match) {
        throw toolError("unknown_session", `No session matches "${selector}".`);
      }

      return match;
    }

    if (sessions.length === 0) {
      throw toolError("no_session", "No active or suspended session, and none was specified.");
    }

    if (sessions.length > 1) {
      throw toolError(
        "ambiguous_session",
        `Multiple sessions are live (${sessions.map((session) => session.alias).join(", ")}); specify a selector.`,
      );
    }

    return sessions[0]!;
  };

  const addSession = (options: FakeSessionOptions): FakeSession => {
    const sessionId = options.sessionId ?? `session-${options.alias}`;
    const summary: SessionSummary = {
      sessionId,
      alias: options.alias,
      state: "active",
      device: { model: options.deviceModel ?? "Pixel 8" },
      createdAt: new Date(0).toISOString(),
      toolCount: 0,
    };

    sessions.push(summary);
    toolsByAlias.set(options.alias, []);
    handlersByAlias.set(options.alias, new Map());
    emit({ kind: "session_claimed", sessionId, alias: options.alias, data: null });

    return {
      alias: options.alias,
      sessionId,
      setTools: (tools) => {
        const entries = tools.map((tool) => ({
          description: "A test tool.",
          policy: "allow" as const,
          ...tool,
        })) as FakeToolEntry[];

        toolsByAlias.set(options.alias, entries);
        summary.toolCount = entries.length;
        emit({ kind: "tools_changed", sessionId, alias: options.alias, data: null });
      },
      onCall: (name, handler) => {
        handlersByAlias.get(options.alias)!.set(name, handler);
      },
    };
  };

  const removeSession = (alias: string): void => {
    const index = sessions.findIndex((session) => session.alias === alias);

    if (index === -1) {
      return;
    }

    const [removed] = sessions.splice(index, 1);
    toolsByAlias.delete(alias);
    handlersByAlias.delete(alias);
    emit({ kind: "session_revoked", sessionId: removed!.sessionId, alias, data: null });
  };

  const openStream = async (): Promise<DaemonStream> => {
    let notify: ((payload: unknown) => void) | undefined;
    const closeCallbacks = new Set<() => void>();
    const fanOut = (payload: unknown): void => notify?.(payload);

    const call = async <TResult>(method: string, params?: unknown): Promise<TResult> => {
      calls.push({ method, params });

      if (method === RPC_METHODS.sessionsList) {
        return sessions.map((session) => ({ ...session })) as TResult;
      }

      if (method === RPC_METHODS.sessionsDescribe) {
        const selector = (params as { selector?: string } | undefined)?.selector;
        return { ...resolveSession(selector) } as TResult;
      }

      if (method === RPC_METHODS.toolsList) {
        const { selector, filter, limit, offset } = (params ?? {}) as {
          selector?: string;
          filter?: string;
          limit?: number;
          offset?: number;
        };
        const entries = toolsByAlias.get(resolveSession(selector).alias)!;

        // The daemon's `{ tools, total }` shape: sorted by name as the daemon sorts its registry,
        // `filter`ed on name and description, `total` counted before paging.
        const lowerFilter = filter?.toLowerCase();
        const matching = entries
          .map((entry) => ({ ...entry }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .filter(
            (entry) =>
              lowerFilter === undefined ||
              entry.name.toLowerCase().includes(lowerFilter) ||
              entry.description.toLowerCase().includes(lowerFilter),
          );
        const start = offset ?? 0;
        const tools = matching.slice(start, limit === undefined ? undefined : start + limit);

        return { tools, total: matching.length } as TResult;
      }

      if (method === RPC_METHODS.toolsCall) {
        const { selector, name, args } = params as {
          selector?: string;
          name: string;
          args: Record<string, unknown>;
        };
        const handler = selector === undefined ? undefined : handlersByAlias.get(selector)?.get(name);

        if (!handler) {
          throw toolError("tool_not_found", `Tool "${name}" is not registered.`);
        }

        // Synchronous by design: it runs the handler, which may throw a `DaemonRpcError` the way
        // the real daemon rejects a call whose app answered `tool_error`.
        return { result: handler(args ?? {}), callId: `call-${nextSeq++}` } as TResult;
      }

      if (method === RPC_METHODS.eventsSubscribe) {
        subscribers.add(fanOut);
        return { ok: true } as TResult;
      }

      throw new Error(
        `The in-memory daemon fake was asked for "${method}", which it does not implement. ` +
          "Either the MCP server grew a new daemon dependency (teach the fake about it) or this " +
          "case needs the real daemon in mcp-server.integration.test.ts.",
      );
    };

    return {
      call,
      onNotification: (callback) => {
        notify = callback;
        return () => {
          notify = undefined;
        };
      },
      onClose: (callback) => {
        closeCallbacks.add(callback);
        return () => closeCallbacks.delete(callback);
      },
      close: () => {
        // Drop this stream's subscription *before* notifying: a closed stream that stayed in the
        // fan-out set would keep receiving events, which no real closed socket ever does.
        subscribers.delete(fanOut);
        notify = undefined;

        for (const callback of closeCallbacks) {
          callback();
        }
      },
    };
  };

  return { openStream, addSession, removeSession, calls: () => calls };
};
