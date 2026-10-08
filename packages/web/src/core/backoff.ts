const BASE_MS = 500;
const CAP_MS = 30_000;

/** Reconnect delay with full jitter: `random() * min(30 s, 500 ms * 2^attempt)`. `attempt` counts
 * from 0 for the first retry after a loss. Same schedule as the Swift and Kotlin cores. */
export const fullJitterBackoffMs = (attempt: number, random: () => number): number =>
  Math.floor(random() * Math.min(CAP_MS, BASE_MS * 2 ** Math.max(attempt, 0)));
