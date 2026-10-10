import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

import { repoRoot, type Step } from "./targets.js";

/** Build, Metro and `flutter run` output for the last run, one file per process. */
export const logsDir = path.join(repoRoot, "e2e-device", ".artifacts");

export const logFile = (name: string): string => {
  mkdirSync(logsDir, { recursive: true });
  return path.join(logsDir, `${name}.log`);
};

type RunOptions = { cwd?: string; env?: Record<string, string>; log?: string; timeoutMs?: number };

/** Runs a command to completion and resolves with its exit code, its stdout, and stdout and
 * stderr interleaved. The interleaved output also goes to `log` when one is given. */
export const exec = (
  cmd: string,
  args: string[],
  options: RunOptions = {},
): Promise<{ code: number | null; stdout: string; output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const file = options.log ? createWriteStream(options.log, { flags: "a" }) : undefined;
    file?.write(`\n$ ${cmd} ${args.join(" ")}\n`);
    let stdout = "";
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      output += chunk;
      file?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk;
      file?.write(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      file?.end();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      file?.end();
      resolve({ code, stdout, output });
    });
  });

/** {@link exec}, rejecting on a non-zero exit with the last lines of output. */
export const run = async (cmd: string, args: string[], options: RunOptions = {}): Promise<string> => {
  const { code, output } = await exec(cmd, args, options);
  if (code !== 0) {
    const where = options.log ? ` Full output: ${options.log}` : "";
    throw new Error(`${cmd} ${args.join(" ")} exited with ${code}.${where}\n${output.slice(-3000)}`);
  }
  return output;
};

/** Runs a target's build steps in order, each in the playground directory. */
export const runSteps = async (dir: string, steps: Step[], log: string): Promise<void> => {
  for (const step of steps) {
    await run(step.cmd, step.args, { cwd: path.join(dir, step.cwd ?? "."), env: step.env, log, timeoutMs: 30 * 60_000 });
  }
};

/** Polls `check` until it returns something other than `undefined`, and returns that. Throws
 * with `description` once `timeoutMs` passes, so every wait in the suite has a deadline. */
export const until = async <T>(
  check: () => Promise<T | undefined>,
  description: string,
  timeoutMs = 30_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
