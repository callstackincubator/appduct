import type { CliResult } from "./result-types.js";

import { getExitCodeForError, toCliError } from "../errors.js";
import { formatJson } from "./global-flags.js";
import { renderResult, type RenderOptions } from "../output.js";
import { finalizeResult } from "./envelope.js";
import type { CliEnv, CliIoWriters } from "./types.js";

/**
 * Long-lived command result shape shared by any CLI command that keeps a process alive
 * until completion/cancellation (e.g. a foreground daemon run). Not tied to any specific
 * command's data type.
 */
type HostedCommandResult = {
  result: CliResult<unknown>;
  completion: Promise<void>;
  stop: () => void;
};

/**
 * Minimal reporter contract for {@link executeHostedCommand}: an optional live-rendering
 * reporter that receives lifecycle events and must be disposed once the hosted command
 * completes. `kind: "plain"` reporters render their own bootstrap output instead of the
 * default `renderResult` output.
 */
export type HostedCommandReporter = {
  kind: "interactive" | "plain";
  onEvent: (event: unknown) => void | Promise<void>;
  dispose: () => void;
};

const writeRenderedOutput = (
  rendered: { stdout?: string; stderr?: string },
  writers: CliIoWriters,
): void => {
  if (rendered.stdout) {
    writers.stdout.write(rendered.stdout);
  }

  if (rendered.stderr) {
    writers.stderr.write(rendered.stderr);
  }
};

export const executeCommand = async (
  command: string,
  handler: () => CliResult<unknown> | Promise<CliResult<unknown>>,
  env: CliEnv,
  render: Partial<Pick<RenderOptions, "qr" | "full">> = {},
): Promise<number> => {
  const startedAt = env.clock.now();

  try {
    const result = await handler();
    const finishedAt = env.clock.now();
    const finalized = finalizeResult(result, { command, startedAt, finishedAt }, env.flags);
    const renderOptions: RenderOptions = {
      command,
      flags: env.flags,
      now: finishedAt,
      qr: render.qr,
      full: render.full,
    };

    writeRenderedOutput(renderResult(finalized, renderOptions), env);

    return 0;
  } catch (error) {
    const finishedAt = env.clock.now();
    const cliError = toCliError(error);
    const result: CliResult<never> = { ok: false, error: cliError };
    const finalized = finalizeResult(result, { command, startedAt, finishedAt }, env.flags);
    const renderOptions: RenderOptions = {
      command,
      flags: env.flags,
      now: finishedAt,
      qr: render.qr,
      full: render.full,
    };

    writeRenderedOutput(renderResult(finalized, renderOptions), env);

    return getExitCodeForError(error);
  }
};

export const executeHostedCommand = async (
  command: string,
  handler: () => Promise<HostedCommandResult>,
  env: CliEnv,
  reporter?: HostedCommandReporter,
): Promise<number> => {
  const startedAt = env.clock.now();
  let renderedSuccess = false;

  try {
    const hosted = await handler();
    const finishedAt = env.clock.now();
    const finalized = finalizeResult(hosted.result, { command, startedAt, finishedAt }, env.flags);

    // A live reporter (e.g. `events`'s streaming NDJSON/human lines) renders its own output as it
    // goes; only the absence of a reporter (or an explicit "plain" one) falls back to the default
    // one-shot `renderResult` bootstrap rendering.
    const shouldRenderBootstrap = !reporter || reporter.kind === "plain";

    if (shouldRenderBootstrap) {
      writeRenderedOutput(
        renderResult(finalized, { command, flags: env.flags, now: finishedAt }),
        env,
      );
      renderedSuccess = true;
    }

    let resolved = false;
    const stop = () => {
      if (resolved) {
        return;
      }

      resolved = true;
      hosted.stop();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      await hosted.completion;
    } finally {
      resolved = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      reporter?.dispose();
    }

    return 0;
  } catch (error) {
    reporter?.dispose();

    const finishedAt = env.clock.now();
    const cliError = toCliError(error);
    const result: CliResult<never> = { ok: false, error: cliError };
    const finalized = finalizeResult(result, { command, startedAt, finishedAt }, env.flags);

    if (renderedSuccess && env.flags.json) {
      // The single-JSON-document-on-stdout contract was already fulfilled by the bootstrap render
      // above; a failure that happens later (e.g. during a long-running `completion`) must still
      // be a JSON document, just on stderr instead — bare text here was v1's defect (leaked
      // unparseable output onto stderr in `--json` mode). One document, so `--pretty` may apply.
      env.stderr.write(`${formatJson(finalized, env.flags)}\n`);
      return getExitCodeForError(error);
    }

    writeRenderedOutput(
      renderResult(finalized, { command, flags: env.flags, now: finishedAt }),
      env,
    );

    return getExitCodeForError(error);
  }
};
