import type { DevtoolsBrowser, DevtoolsPage, DevtoolsTarget } from "./ports.js";
import { createMemoryPageChannel, type MemoryPageChannel } from "./memory-page-channel.js";

export type MemoryDevtoolsBrowser = DevtoolsBrowser & {
  /** The tab's page, as the relay sees it: the one the next `openPage` returns, then the latest it returned. */
  page(targetId: string): MemoryPageChannel;
  /** Target ids passed to `openPage`, in order, that have not been closed since. */
  attachedTargets(): string[];
};

/** A browser with the given tabs, each backed by a memory page channel. */
export const createMemoryDevtoolsBrowser = (tabs: DevtoolsTarget[]): MemoryDevtoolsBrowser => {
  const pages = new Map(tabs.map((tab) => [tab.id, createMemoryPageChannel()]));
  const opened = new Set<string>();
  const attached = new Set<string>();
  const pageOf = (targetId: string): MemoryPageChannel => {
    const page = pages.get(targetId);
    if (!page) throw new Error(`no tab ${targetId}`);
    return page;
  };

  return {
    targets: async () => tabs.map((tab) => ({ ...tab })),
    openPage: async (targetId): Promise<DevtoolsPage> => {
      const first = pageOf(targetId);
      // A second open is a new connection with its own handlers; the first keeps the pre-made channel.
      const channel = opened.has(targetId) ? createMemoryPageChannel() : first;
      opened.add(targetId);
      pages.set(targetId, channel);
      attached.add(targetId);
      const dropHandlers = channel.close;
      return Object.assign(channel, {
        close: () => {
          dropHandlers();
          if (pages.get(targetId) === channel) attached.delete(targetId);
        },
      });
    },
    close: () => attached.clear(),
    page: pageOf,
    attachedTargets: () => [...attached],
  };
};
