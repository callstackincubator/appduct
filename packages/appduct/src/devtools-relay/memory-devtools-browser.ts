import type { DevtoolsBrowser, DevtoolsPage, DevtoolsTarget } from "./ports.js";
import { createMemoryPageChannel, type MemoryPageChannel } from "./memory-page-channel.js";

export type MemoryDevtoolsBrowser = DevtoolsBrowser & {
  /** The tab's page, as the relay sees it. */
  page(targetId: string): MemoryPageChannel;
  /** Target ids passed to `openPage`, in order, that have not been closed since. */
  attachedTargets(): string[];
};

/** A browser with the given tabs, each backed by a memory page channel. */
export const createMemoryDevtoolsBrowser = (tabs: DevtoolsTarget[]): MemoryDevtoolsBrowser => {
  const pages = new Map(tabs.map((tab) => [tab.id, createMemoryPageChannel()]));
  const attached = new Set<string>();
  const pageOf = (targetId: string): MemoryPageChannel => {
    const page = pages.get(targetId);
    if (!page) throw new Error(`no tab ${targetId}`);
    return page;
  };

  return {
    targets: async () => tabs.map((tab) => ({ ...tab })),
    openPage: async (targetId): Promise<DevtoolsPage> => {
      attached.add(targetId);
      return Object.assign(pageOf(targetId), { close: () => void attached.delete(targetId) });
    },
    close: () => attached.clear(),
    page: pageOf,
    attachedTargets: () => [...attached],
  };
};
