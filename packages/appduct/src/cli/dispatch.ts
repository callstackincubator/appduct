/**
 * The CLI's eager entry: everything that runs before a command word is known. Parses argv with
 * `cac`, resolves the global flags, and hands off to the root router, which lazy-loads exactly one
 * route module (`./routes/<command>.js`) for the command that matched.
 *
 * Keep this module's *static* imports to what every invocation needs (ARCHITECTURE.md §10
 * "Startup cost"): the parser, the runner, the state-dir resolution and the version guard. A
 * command's handler, and anything only that command needs, belongs behind its route's loader in
 * {@link rootRouter}, never up here.
 */

import { loadConfig } from "../daemon/config.js";
import { getStateDirPaths, resolveStateDir } from "../daemon/state-dir.js";
import { usageError } from "../errors.js";
import { getPackageVersion } from "../package-version.js";
import { createCli } from "./create-cli.js";
import { createRouter, unknownCommandError, type RouteContext } from "./router.js";
import { executeCommand } from "./runner.js";
import { systemClock } from "./types.js";
import type { RunCliOptions } from "./types.js";

/** `APPDUCT_DAEMON_RESTART=1` forces a version-mismatch restart for one run — the env-var form
 * of `--daemon-restart`, so an MCP launch config (which passes no CLI flags) can opt in. */
const DAEMON_RESTART_ENV = "APPDUCT_DAEMON_RESTART";

const isEnvTruthy = (value: string | undefined): boolean => {
  return value === "1" || value?.toLowerCase() === "true";
};

/**
 * One entry per command `create-cli.ts` registers. Each loader is a dynamic `import()` so the
 * route — and its command handler, and that handler's dependencies — is only evaluated when the
 * command runs. `daemon` is a router of its own (`routes/daemon/index.ts`), one level down.
 */
const rootRouter = createRouter(
  {
    init: () => import("./routes/init.js"),
    keygen: () => import("./routes/keygen.js"),
    link: () => import("./routes/link.js"),
    ls: () => import("./routes/ls.js"),
    tools: () => import("./routes/tools.js"),
    invoke: () => import("./routes/invoke.js"),
    revoke: () => import("./routes/revoke.js"),
    events: () => import("./routes/events.js"),
    mcp: () => import("./routes/mcp.js"),
    doctor: () => import("./routes/doctor.js"),
    daemon: () => import("./routes/daemon/index.js"),
  },
  { unknown: unknownCommandError },
);

export const runCli = async (argv: string[], options: RunCliOptions = {}): Promise<number> => {
  const writers = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
  const clock = options.clock ?? systemClock;

  const cli = createCli();

  try {
    cli.parse(["node", "appduct", ...argv], {
      run: false,
    });
  } catch (error) {
    return executeCommand(
      "cli",
      () => {
        throw error;
      },
      {
        json: argv.includes("--json"),
        color: !argv.includes("--no-color"),
        stdout: writers.stdout,
        stderr: writers.stderr,
        clock,
      },
    );
  }

  const matchedCommand = cli.matchedCommandName;
  const parsedOptions = cli.options as Record<string, unknown>;
  const parsedArgs = cli.args as string[];

  if (parsedOptions.help || parsedOptions.version) {
    return 0;
  }

  if (!matchedCommand) {
    if (parsedArgs[0]) {
      return executeCommand(
        "cli",
        () => {
          throw usageError(`Unknown command "${parsedArgs[0]}".`);
        },
        {
          json: Boolean(parsedOptions.json),
          color: parsedOptions.color !== false,
          stdout: writers.stdout,
          stderr: writers.stderr,
          clock,
        },
      );
    }

    cli.outputHelp();
    return 0;
  }

  const json = Boolean(parsedOptions.json);
  const color = parsedOptions.color !== false;
  const io = { json, color, stdout: writers.stdout, stderr: writers.stderr, clock };
  const stateDir = resolveStateDir(
    typeof parsedOptions.stateDir === "string" ? parsedOptions.stateDir : undefined,
  );

  // --- daemon/CLI version drift (issue #30, ARCHITECTURE.md §4 "Version drift") ------------------

  let forceRestart: Promise<boolean> | undefined;

  /** Memoized so the config read behind `restartDaemonOnVersionMismatch` happens at most once. */
  const resolveForceRestart = (): Promise<boolean> => {
    forceRestart ??= (async () => {
      let configuredForce = false;

      try {
        configuredForce = (await loadConfig(getStateDirPaths(stateDir))).restartDaemonOnVersionMismatch;
      } catch {
        // An unreadable/invalid `config.json` must not turn every command into a config error just
        // because one optional knob lives there; the daemon reports the real problem when it starts.
      }

      // An explicit flag wins outright, in both directions: `--no-daemon-restart` is how an
      // operator overrules a `restartDaemonOnVersionMismatch: true` in their config (or a
      // `APPDUCT_DAEMON_RESTART` exported by a wrapper script) for one command, and silently
      // ignoring it would be the worst kind of surprise for a knob that decides whether their
      // connected devices survive.
      const flag = typeof parsedOptions.daemonRestart === "boolean" ? parsedOptions.daemonRestart : undefined;

      return flag ?? (isEnvTruthy(process.env[DAEMON_RESTART_ENV]) || configuredForce);
    })();

    return forceRestart;
  };

  /**
   * Where the "the running daemon is newer than this client" notice goes. `--json` promises one
   * machine-readable object and nothing else, so in that mode the notice is dropped rather than
   * dribbled onto stderr where it would corrupt a script that captures both streams — the check
   * still behaves identically, it just says nothing. (A structured warning channel would be the
   * better answer; the runner has none today.)
   */
  const cliWarning = json ? () => {} : (message: string) => void writers.stderr.write(message);

  const context: RouteContext = {
    path: [],
    // cac has already split the command word off `cli.args`; put it back so the root router
    // consumes it the same way the nested routers consume theirs.
    args: [matchedCommand, ...parsedArgs],
    options: parsedOptions,
    io,
    stateDir,
    versionCheck: {
      clientVersion: getPackageVersion(),
      forceRestart: resolveForceRestart,
      warn: cliWarning,
    },
  };

  return rootRouter(context);
};
