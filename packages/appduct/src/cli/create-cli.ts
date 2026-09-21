import { cac } from "cac";

import { getPackageVersion } from "../package-version.js";
import { registerGlobalFlags } from "./global-flags.js";

export const createCli = () => {
  const version = getPackageVersion();
  const cli = cac("appduct");

  // `--json`/`--pretty`/`--verbose`/`--no-color`: the declarative table in `global-flags.ts`.
  // `--state-dir`/`--daemon-restart` stay registered by hand below — they are not output flags
  // and are resolved differently (state-dir resolution, version-drift guard).
  registerGlobalFlags(cli);
  cli.option("--state-dir <path>", "Override the Appduct state directory (default: ~/.appduct).");
  cli.option(
    "--daemon-restart",
    "On a daemon/CLI version mismatch, restart the daemon even though that drops live sessions and unclaimed links.",
  );

  cli
    .command("init", "Set up the current app directory: write .appduct/config.json and print the MCP snippet.")
    .option(
      "--scheme <scheme>",
      "Deep-link URI scheme to write. Only this flag and <cwd>/app.json are consulted — not " +
        "APPDUCT_SCHEME, and no walk-up: init decides what to write here, so it never bakes " +
        "an ambient value into a committed file.",
    )
    .option("--force", "Replace the scheme already recorded in the project config.")
    .option(
      "--ios-app-id <id>",
      "iOS bundle id to write as \"appId.ios\" (needed to deliver a link with --open ios-device).",
    )
    .option(
      "--android-app-id <id>",
      "Android package name to write as \"appId.android\" (needed to deliver a link with --open android).",
    );

  cli
    .command("keygen", "Generate an Appduct host private key and print its app fingerprint.")
    .option("--out <path>", "Destination path (default: <state-dir>/key.pem).")
    .option("--force", "Overwrite an existing key at the destination path.");

  cli
    .command("link", "Mint a pending session and print its deep link.")
    .option("--ttl <seconds>", "Link time-to-live in seconds (default: from config.json).")
    .option("--qr", "Also render the deep link as a terminal QR code.")
    .option(
      "--scheme <scheme>",
      "Deep-link URI scheme (also: APPDUCT_SCHEME; default: app.json's \"expo.scheme\").",
    )
    .option(
      "--open <target>",
      "Deliver the link automatically via adb/simctl/devicectl (android|ios-sim|ios-device; ios-device is experimental).",
    )
    .option("--device <id>", "adb serial, simulator udid or paired-device udid to target when --open is ambiguous.")
    .option(
      "--app-id <id>",
      "Installed app id for --open android/ios-device (default: .appduct/config.json's \"appId.<platform>\").",
    )
    .option(
      "--relaunch",
      "With --open ios-device, terminate a running instance first (try this if delivery to an already-running app does nothing).",
    );

  cli.command("ls", "List Appduct sessions.");

  cli
    .command("tools [selector] [name]", "List a session's tools, or show one tool's full schema.")
    .option("--full", "Render full schemas/annotations for every listed tool.")
    .option("--group <name>", "Only tools in this group (\"checkout\" includes \"checkout/payment\").")
    .option("--groups", "List the session's groups with tool counts instead of its tools.")
    .option("--filter <text>", "Only tools whose name or description contains this text (case-insensitive).")
    .option("--limit <n>", "Show at most n tools.")
    .option("--offset <n>", "Skip the first n tools of the sorted list.");

  cli
    .command("invoke [selector] [tool]", "Call a tool on a session.")
    .option("--input <json>", "Tool input arguments as a JSON object.")
    .option(
      "--timeout <ms>",
      "Call timeout in milliseconds. Shortens the deadline; it cannot extend one past the app's " +
        "own timer, which is the tool's declared timeoutMs (else 10000).",
    );

  cli
    .command("events [selector]", "Stream session/tool events until interrupted.")
    .option("--follow", "Accepted for script readability; the default behavior already follows.")
    .option("--since <cursor>", "One-shot: print events retained since this cursor instead of streaming live.");

  cli.command("revoke [selector]", "Revoke a session.");

  cli
    .command("mcp", "Start a stdio MCP server that gives MCP clients access to connected apps' tools.")
    .option(
      "--scheme <scheme>",
      "Deep-link URI scheme for appduct_connect (also: APPDUCT_SCHEME).",
    );

  cli
    .command("doctor <artifact>", "Report (or assert) whether a built .app/.ipa/.apk/.aab contains Appduct.")
    .option("--assert-present", "Exit non-zero (and report) if Appduct is not present in the artifact.")
    .option("--assert-absent", "Exit non-zero (and report) if Appduct is present in the artifact.");

  // cac only matches a command's first word against argv[0], so "run"/"start"/"stop"/"status"
  // are handled as a sub-action of the single "daemon" command rather than four cac commands.
  cli.command("daemon [action]", "Manage the Appduct daemon: run, start, stop, or status.");

  cli.help();
  cli.version(version);

  return cli;
};
