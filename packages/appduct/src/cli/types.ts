import type { GlobalFlags } from "./global-flags.js";

export type Clock = {
  now: () => Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

export type RunCliOptions = {
  stdout?: Pick<typeof process.stdout, "write" | "isTTY">;
  stderr?: Pick<typeof process.stderr, "write">;
  clock?: Clock;
};

export type CliIoWriters = Required<Pick<RunCliOptions, "stdout" | "stderr">>;

/**
 * Everything a route's handler needs about how to behave and where to write, in one object:
 * the resolved global flags plus the writers and clock. A future global flag is added to
 * `global-flags.ts`'s table and becomes available as `env.flags.<name>` everywhere this is
 * threaded, with no other plumbing change.
 */
export type CliEnv = {
  flags: GlobalFlags;
  stdout: CliIoWriters["stdout"];
  stderr: CliIoWriters["stderr"];
  clock: Clock;
};
