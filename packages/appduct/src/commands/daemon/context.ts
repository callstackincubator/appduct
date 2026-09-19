/** The context shared by the `appduct daemon <action>` handlers (`run.ts`, `start.ts`, `stop.ts`,
 * `status.ts`). One file per action so the CLI's lazy router (`cli/router.ts`) can load `status`
 * without evaluating `run`'s daemon implementation (ARCHITECTURE.md §10 "Startup cost"). */

import type { Clock } from "../../cli/types.js";
import type { SpawnFn } from "../../rpc/client.js";

export type DaemonCommandContext = {
  stateDir: string;
  clock?: Clock;
  spawn?: SpawnFn;
  warn?: (message: string) => void;
  /** Test seam: the version `daemon status` compares the daemon against; defaults to this
   * package's own version. */
  clientVersion?: string;
};
