/**
 * The daemon's own event log, `<stateDir>/events.log` (ARCHITECTURE.md §3): one JSON line per
 * event, for debugging Appduct itself. The daemon decides which events to record; this module only
 * writes them and keeps the file bounded.
 *
 * Writes are serialized on a promise queue, so {@link EventsLog.record} returns at once and never
 * blocks the emitter. After each append the file is rotated to a single backup once it is over
 * `maxBytes`, so the current file is never above the cap once a write has settled. A failed write
 * or rotation is warned, never thrown, and never stops later writes.
 */

import type { EventNotification } from "@appduct/shared";

/** A file that only ever grows by whole lines, with one backup slot. */
export type AppendOnlyFile = {
  /** Appends `line` plus a newline, creating the file at mode `0600` if it is missing. */
  append(line: string): Promise<void>;
  /** Current size in bytes; `0` when the file does not exist. */
  size(): Promise<number>;
  /** Moves the file to the backup slot, replacing any previous backup. */
  rotate(): Promise<void>;
};

export type EventsLog = {
  /** Queues `event` as one JSON line; returns immediately. */
  record(event: EventNotification): void;
  /** Resolves once every write queued so far has settled. */
  flush(): Promise<void>;
};

export const createEventsLog = (options: {
  file: AppendOnlyFile;
  maxBytes: number;
  warn: (message: string) => void;
}): EventsLog => {
  const { file, maxBytes, warn } = options;
  let queue: Promise<void> = Promise.resolve();

  return {
    record: (event) => {
      const line = JSON.stringify(event);

      queue = queue.then(async () => {
        try {
          await file.append(line);

          if ((await file.size()) > maxBytes) {
            await file.rotate();
          }
        } catch (error) {
          warn(`appduct daemon: failed to write events.log: ${(error as Error).message}`);
        }
      });
    },
    flush: () => queue,
  };
};
