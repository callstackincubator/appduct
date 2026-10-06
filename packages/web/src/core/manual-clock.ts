import type { Clock, TimerHandle } from "./ports.js";

export type ManualClock = Clock & {
  /** Moves time forward, running every timer that falls due, in order. */
  advance(ms: number): void;
  /** Timers set and not yet run or cleared. */
  pendingTimers(): number;
};

export const createManualClock = (startMs = 0): ManualClock => {
  let current = startMs;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();

  return {
    now: () => current,
    setTimeout(run, ms) {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(ms, 0), run });
      return id;
    },
    clearTimeout(handle: TimerHandle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let dueId: number | undefined;
        let due: { at: number; run: () => void } | undefined;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === undefined || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (due === undefined || dueId === undefined) break;
        timers.delete(dueId);
        current = due.at;
        due.run();
      }
      current = target;
    },
    pendingTimers: () => timers.size,
  };
};
