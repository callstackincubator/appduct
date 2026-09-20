import { generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { runCli } from "../cli.js";

export const FIXED_NOW = new Date("2026-03-17T10:00:00.000Z");

export const fixedClock = {
  now: () => FIXED_NOW,
};

/** Package root: `packages/appduct` (this file lives in `src/__tests__`). */
export const packageRoot = path.resolve(import.meta.dirname, "..", "..");

export const binEntry = path.join(packageRoot, "bin.js");

type CliProcessOptions = {
  stateDir?: string;
  extraEnv?: NodeJS.ProcessEnv;
  /** Working directory for the spawned CLI; defaults to {@link packageRoot}. Scheme discovery and
   * the project-config walk-up are cwd-relative, so tests for those must be able to move it. */
  cwd?: string;
};

const cliEnvironment = ({ stateDir, extraEnv }: CliProcessOptions): NodeJS.ProcessEnv => ({
  ...process.env,
  ...extraEnv,
  ...(stateDir ? { APPDUCT_STATE_DIR: stateDir } : {}),
});

/** Runs the built Node CLI as a subprocess, mirroring the published executable. */
export const runCliBinary = (args: string[], options: CliProcessOptions = {}) => {
  const result = spawnSync(process.execPath, [binEntry, ...args], {
    cwd: options.cwd ?? packageRoot,
    encoding: "utf8",
    env: cliEnvironment(options),
  });

  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
};

/** Starts the built Node CLI without waiting for it to exit. */
export const spawnCliBinary = (
  args: string[],
  options: CliProcessOptions = {},
): ChildProcessByStdio<null, Readable, Readable> => {
  return spawn(process.execPath, [binEntry, ...args], {
    cwd: options.cwd ?? packageRoot,
    env: cliEnvironment(options),
    stdio: ["ignore", "pipe", "pipe"],
  });
};

export const waitForExit = (
  process: ChildProcessByStdio<null, Readable, Readable>,
): Promise<number> => {
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code) => resolve(code ?? 1));
  });
};

/**
 * Generates a throwaway EC host key directly into a temp state dir with mode 0600 — the daemon's
 * TLS listener (daemon/tls.ts) refuses to start without one. Never used outside test runtime; the
 * key is never committed (LOOP.md: "test keys are generated at test runtime into temp dirs").
 */
export const writeTestHostKey = async (keyPath: string): Promise<void> => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

  await writeFile(keyPath, pem, { encoding: "utf8", mode: 0o600 });
};

type RunCliCaptureOptions = {
  stdoutIsTTY?: boolean;
};

export const runCliWithCapture = async (
  argv: string[],
  options: RunCliCaptureOptions = {},
) => {
  let stdout = "";
  let stderr = "";

  const exitCode = await runCli(argv, {
    clock: fixedClock,
    stdout: {
      isTTY: options.stdoutIsTTY ?? false,
      write(chunk: string | Uint8Array) {
        stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    },
  });

  return {
    exitCode,
    stdout,
    stderr,
  };
};

/**
 * A temp state dir every daemon-starting test can share: a throwaway host key plus a `config.json`
 * that asks for an OS-assigned wss port (`wssPort: 0`, ARCHITECTURE.md §3) and advertises
 * loopback.
 *
 * This replaces the `pickFreePort` helper that used to be copy-pasted into a dozen test files.
 * Pre-picking a port and then writing it into a config is a TOCTOU race *by construction*: between
 * the probe socket closing and the daemon binding, any other process on the machine — including
 * another vitest process running this same suite in another worktree — can take that port. Asking
 * the OS to assign one at bind time has no window at all. A test that needs the number reads it
 * back from the running daemon (`RunningDaemon.listener.port()` in-process, `daemon status --json`
 * across a process boundary) rather than deciding it up front.
 *
 * Callers clean the directory up themselves ({@link removeStateDir}) — this suite's files all keep
 * their own `afterEach` sweep, and a hook registered here would be this file's, not theirs.
 */
export const makeTempStateDir = async (
  configOverrides: Record<string, unknown> = {},
  options: { prefix?: string } = {},
): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), options.prefix ?? "appduct-test-"));
  await writeTestHostKey(path.join(directory, "key.pem"));

  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ wssPort: 0, advertisedIp: "127.0.0.1", ...configOverrides }),
    { encoding: "utf8", mode: 0o600 },
  );

  return directory;
};

/** Recursive, never-throwing removal of a temp state dir. */
export const removeStateDir = async (directory: string): Promise<void> => {
  await rm(directory, { force: true, recursive: true });
};

/**
 * The port a daemon started from {@link makeTempStateDir} actually bound, read back over the real
 * CLI (`daemon status --json`) — the only way to learn it across a process boundary, since the
 * config deliberately does not name one.
 */
export const readDaemonWssPort = async (stateDir: string): Promise<number> => {
  const result = runCliBinary(["daemon", "status", "--json"], { stateDir });
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    data?: { daemon: { wss_port: number; pid: number } };
  };

  if (!payload.ok || !payload.data) {
    throw new Error(`Failed to read daemon status for "${stateDir}": ${result.stdout}${result.stderr}`);
  }

  return payload.data.daemon.wss_port;
};
