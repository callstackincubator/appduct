import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { runCliBinary, runCliWithCapture } from "./fixtures.js";

describe("CLI integration", () => {
  test("keygen --out --json is non-interactive and works with stdin/stdout not a TTY", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "appduct-keygen-integration-"));
    const keyPath = path.join(directory, "generated-key.pem");

    try {
      const result = await runCliWithCapture(["keygen", "--out", keyPath, "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        ok: true,
        data: {
          path: keyPath,
        },
      });
      expect(parsed.data.pin).toMatch(/^sha256\//u);
      expect(await readFile(keyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("help lists exactly the noun-verb command surface (ARCHITECTURE.md §10, issue #96)", () => {
    const command = runCliBinary(["--help"]);

    expect(command.exitCode).toBe(0);

    const stdout = command.stdout;
    const commandsSection = stdout.split(/\n\s*\n/u).find((block) => block.startsWith("Commands:"));

    expect(commandsSection).toBeDefined();

    const commandNames = commandsSection!
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim().split(/\s{2,}/u)[0]);

    // Exactly the noun-verb command surface (ARCHITECTURE.md §10, plus `mcp` from §9): `ls`,
    // `revoke`, `link` and `invoke` no longer exist as top-level commands (issue #96), and v1's
    // `host`/`connect`/`session` commands must never resurface here either.
    expect(new Set(commandNames)).toEqual(
      new Set([
        "init",
        "keygen",
        "sessions [...args]",
        "tools [...args]",
        "events [...args]",
        "mcp",
        "doctor <artifact>",
        "daemon [action]",
      ]),
    );

    // Global flags (ARCHITECTURE.md §10). `--daemon-restart` (issue #30) has to be discoverable
    // here: it is the documented remedy the version-drift error tells operators to reach for, and
    // an error naming a flag that `--help` never mentions is a dead end.
    const optionsSection = stdout.split(/\n\s*\n/u).find((block) => block.startsWith("Options:"));

    expect(optionsSection).toBeDefined();

    for (const flag of ["--json", "--no-color", "--state-dir", "--daemon-restart"]) {
      expect(optionsSection).toContain(flag);
    }
  });

  test("--help on each command exposes exactly its documented flags", () => {
    const helpFor = (command: string): string => {
      const result = runCliBinary([command, "--help"]);
      expect(result.exitCode).toBe(0);
      return result.stdout;
    };

    const initHelp = helpFor("init");
    expect(initHelp).toContain("--scheme");
    expect(initHelp).toContain("--force");
    expect(initHelp).toContain("--ios-app-id");
    expect(initHelp).toContain("--android-app-id");

    const keygenHelp = helpFor("keygen");
    expect(keygenHelp).toContain("--out");
    expect(keygenHelp).toContain("--force");

    // `sessions` declares every flag any of its verbs uses (`link`'s, since `ls`/`revoke` take
    // none), so `--help` on the noun lists them regardless of which verb is typed (issue #96).
    const sessionsHelp = helpFor("sessions");
    expect(sessionsHelp).toContain("--ttl");
    expect(sessionsHelp).toContain("--qr");
    expect(sessionsHelp).toContain("--scheme");
    expect(sessionsHelp).toContain("--open");
    expect(sessionsHelp).toContain("--device");
    expect(sessionsHelp).toContain("--app-id");
    expect(sessionsHelp).toContain("--relaunch");
    expect(sessionsHelp).toContain("ios-device");

    // `--app-id` has to survive cac's camelCasing all the way into `handleLinkCommand`, and a
    // flag that quietly parsed to `undefined` would look identical to one that was never passed:
    // `sessions link --open ios-sim --app-id ...` would then mint and deliver instead of erroring.
    // The validation runs before any daemon contact, so this needs no state dir beyond an empty one.
    const misplacedAppId = runCliBinary(
      ["sessions", "link", "--open", "ios-sim", "--app-id", "com.example.playground", "--json"],
      { stateDir: path.join(tmpdir(), "appduct-app-id-flag-nonexistent") },
    );
    expect(misplacedAppId.exitCode).not.toBe(0);
    // `--json` escapes the quotes in the message, so match on the shape rather than the literal.
    expect(`${misplacedAppId.stdout}${misplacedAppId.stderr}`).toMatch(
      /--app-id.{0,4} only applies with .{0,4}--open android.{0,4} or .{0,4}--open ios-device/u,
    );

    // `tools` declares every flag any of its verbs uses (`ls`'s and `call`'s).
    const toolsHelp = helpFor("tools");
    expect(toolsHelp).toContain("--full");
    expect(toolsHelp).toContain("--input");
    expect(toolsHelp).toContain("--timeout");

    const eventsHelp = helpFor("events");
    expect(eventsHelp).toContain("--follow");

    // Issue #29: an MCP config entry has to be able to carry its own scheme.
    const mcpHelp = helpFor("mcp");
    expect(mcpHelp).toContain("--scheme");

    const doctorHelp = helpFor("doctor");
    expect(doctorHelp).toContain("--assert-present");
    expect(doctorHelp).toContain("--assert-absent");
    // Each `helpFor` spawns the real CLI binary, so this one test carries ~10 process starts and
    // runs close to the 5s default on a loaded machine (issue #29 added two more commands to it).
  }, 30_000);

  test("version is available from the binary entrypoint", () => {
    const command = runCliBinary(["--version"]);

    expect(command.exitCode).toBe(0);
  });
});
