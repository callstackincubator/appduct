import { createRequire } from "node:module";
import path from "node:path";

import { exec } from "./process.js";

const bin = path.join(path.dirname(createRequire(import.meta.url).resolve("appduct/package.json")), "bin.js");

export type CliResult<T> = { ok: true; data: T } | { ok: false; error: { type: string; message: string } };

/** Runs this checkout's `appduct` CLI against `stateDir` with `--json`. A command that fails
 * still resolves, with `ok: false`, so a test can assert on the error. */
export const appduct = async <T>(stateDir: string, args: string[]): Promise<CliResult<T>> => {
  const { stdout, output } = await exec(process.execPath, [bin, "--state-dir", stateDir, "--json", ...args]);
  try {
    return JSON.parse(stdout) as CliResult<T>;
  } catch {
    throw new Error(`appduct ${args.join(" ")} printed no JSON envelope:\n${output}`);
  }
};

/** One row of `sessions ls --json`. */
export type Session = {
  sessionId: string;
  alias: string;
  state: "pending" | "active" | "suspended" | "discarded" | "expired" | "revoked";
  suspendReason?: "app_backgrounded" | "connection_lost";
  device: { manufacturer?: string; model?: string; os?: string };
};

export const sessions = async (stateDir: string): Promise<Session[]> => {
  const result = await appduct<Session[]>(stateDir, ["sessions", "ls"]);
  if (!result.ok) {
    throw new Error(`sessions ls failed: ${result.error.message}`);
  }
  return result.data;
};

export const appductBin = bin;
