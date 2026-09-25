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
      "Deep-link URI scheme to write. Only this flag and static project files in <cwd> are " +
        "consulted (app.json's \"expo.scheme\", then Android app/build.gradle(.kts) and " +
        "app/src/main/AndroidManifest.xml, then iOS Info.plist and project.yml) — not " +
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

  // cac only matches a command's first word against argv[0] and builds its boolean/string table
  // from that command's own declared options (ARCHITECTURE.md §10 "CLI surface"), so each noun
  // below declares every option any of its verbs uses — otherwise a boolean flag ahead of a
  // positional (`sessions link --qr --open ios-sim`) would swallow it as that flag's value.
  cli
    .command("sessions [...args]", "Manage Appduct sessions: ls, revoke, or link.")
    .usage("sessions <ls|revoke|link> [selector] [args]")
    .option("--ttl <seconds>", "link: time-to-live in seconds (default: from config.json).")
    .option("--qr", "link: also render the deep link as a terminal QR code.")
    .option(
      "--scheme <scheme>",
      "link: deep-link URI scheme (also: APPDUCT_SCHEME; default: .appduct/config.json, then " +
        "app.json's \"expo.scheme\", then the Android/iOS project files in <cwd>).",
    )
    .option(
      "--open <target>",
      "link: deliver the link automatically via adb/simctl/devicectl (android|ios-sim|ios-device; ios-device is experimental).",
    )
    .option("--device <id>", "link: adb serial, simulator udid or paired-device udid to target when --open is ambiguous.")
    .option(
      "--app-id <id>",
      "link: installed app id for --open android/ios-device (default: .appduct/config.json's \"appId.<platform>\").",
    )
    .option(
      "--relaunch",
      "link: with --open ios-device, terminate a running instance first (try this if delivery to an already-running app does nothing).",
    );

  cli
    .command("tools [...args]", "List a session's tools, describe one, or call one: ls, describe, or call.")
    .usage("tools <ls|describe|call> [selector] [args]")
    .option("--full", "ls: render full schemas/annotations for every listed tool.")
    .option("--group <name>", "ls: only tools in this group (\"checkout\" includes \"checkout/payment\").")
    .option("--groups", "ls: list the session's groups with tool counts instead of its tools.")
    .option("--filter <text>", "ls: only tools whose name or description contains this text (case-insensitive).")
    .option("--limit <n>", "ls: show at most n tools.")
    .option("--offset <n>", "ls: skip the first n tools of the sorted list.")
    .option("--input <json>", "call: tool input arguments as a JSON object.")
    .option(
      "--timeout <ms>",
      "call: call timeout in milliseconds. Shortens the deadline; it cannot extend one past the " +
        "app's own timer, which is the tool's declared timeoutMs (else 10000).",
    );

  cli
    .command("events [...args]", "Stream the app's events, or replay them since a cursor: tail or since.")
    .usage("events <tail|since> [selector] [args]")
    .option("--follow", "tail: accepted for script readability; the default behavior already follows.")
    .option(
      "--name <glob>",
      "Only events whose name matches this whole-name, case-sensitive glob (\"*\" matches any run of characters).",
    )
    .option(
      "--payload-max-bytes <n>",
      "Cap each event's payload at this many UTF-8 bytes of its JSON; over the cap, the event carries " +
        "payloadPreview, payloadBytes and truncated: true instead of payload.",
    );

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
