/**
 * `appduct init` (issue #29): the project-level setup command, exercised both directly
 * (`commands/init.ts`) and through the real CLI binary in a temporary app root, since its whole
 * value is what it does to a directory a user is standing in.
 *
 * The idempotency criterion from the issue — "`appduct init` is idempotent and covered by a CLI
 * integration test" — is the `re-running` cases below.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { handleInitCommand } from "../commands/init.js";
import { runCliBinary } from "./fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { force: true, recursive: true });
  }
});

/** A throwaway app root, optionally with an `app.json` declaring `expo.scheme`. */
const makeAppRoot = async (expoScheme?: unknown): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "appduct-init-"));
  directories.push(root);

  if (expoScheme !== undefined) {
    await writeFile(
      path.join(root, "app.json"),
      JSON.stringify({ expo: { name: "Demo", scheme: expoScheme } }),
      "utf8",
    );
  }

  return root;
};

const projectConfigPath = (root: string): string => path.join(root, ".appduct", "config.json");

const readProjectConfig = async (root: string): Promise<Record<string, unknown>> => {
  return JSON.parse(await readFile(projectConfigPath(root), "utf8")) as Record<string, unknown>;
};

/** Writes a project config directly, bypassing `init` — for the hand-edited-file cases. */
const writeProjectConfigRaw = async (root: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(projectConfigPath(root)), { recursive: true });
  await writeFile(projectConfigPath(root), JSON.stringify(value), "utf8");
};

/** A state dir the CLI can safely use, so `init` runs never touch the developer's `~/.appduct`. */
const makeStateDir = async (): Promise<string> => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "appduct-init-state-"));
  directories.push(stateDir);

  return stateDir;
};

describe("init command", () => {
  test("writes the scheme discovered from app.json", async () => {
    const root = await makeAppRoot("myapp");

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: projectConfigPath(root),
        scheme: "myapp",
        source: "app.json",
        created: true,
        changed: true,
        mcpServerEntry: { command: "appduct", args: ["mcp", "--scheme", "myapp"] },
      },
    });
    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("takes the first entry of an array expo.scheme", async () => {
    const root = await makeAppRoot(["myapp", "myapp-dev"]);

    await handleInitCommand({}, { cwd: root });

    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("--scheme beats app.json, for projects with a dynamic app.config.js", async () => {
    const root = await makeAppRoot("from-app-json");

    const result = await handleInitCommand({ scheme: "from-flag" }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "from-flag", source: "--scheme" } });
    expect(await readProjectConfig(root)).toEqual({ scheme: "from-flag" });
  });

  test("re-running with the same scheme is a no-op that still reports the snippet", async () => {
    const root = await makeAppRoot("myapp");

    await handleInitCommand({}, { cwd: root });
    const before = await stat(projectConfigPath(root));

    const second = await handleInitCommand({}, { cwd: root });

    expect(second).toMatchObject({
      ok: true,
      data: {
        scheme: "myapp",
        created: false,
        changed: false,
        mcpServerEntry: { args: ["mcp", "--scheme", "myapp"] },
      },
    });
    // Not merely "the content is the same": the file was never rewritten.
    expect((await stat(projectConfigPath(root))).mtimeMs).toBe(before.mtimeMs);
  });

  test("refuses a different scheme without --force", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({}, { cwd: root });

    await expect(handleInitCommand({ scheme: "other" }, { cwd: root })).rejects.toThrow(
      /already records the scheme "myapp"/u,
    );
    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  // A plain re-run must stay idempotent even after `app.json` is edited: `appduct init` is
  // documented as safe to re-run, so renaming a scheme in `app.json` must not start breaking it.
  // The divergence is surfaced as a note, not an error.
  test("keeps the recorded scheme and notes the divergence when app.json changed underneath", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({}, { cwd: root });

    await writeFile(
      path.join(root, "app.json"),
      JSON.stringify({ expo: { scheme: "renamed" } }),
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: { scheme: "myapp", source: "already-recorded", changed: false },
    });
    expect(result.ok && result.data.note).toMatch(/renamed[\s\S]*myapp/u);
    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("--scheme --force adopts the new app.json value the note points at", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({}, { cwd: root });

    const result = await handleInitCommand({ scheme: "renamed", force: true }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "renamed", changed: true } });
    expect(result.ok && result.data.note).toBeUndefined();
  });

  // `--force` on its own is the escape hatch the note tells you to run, so it must both adopt the
  // app.json value and stop reporting a divergence that no longer exists.
  test("--force alone re-adopts app.json and clears the note", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({}, { cwd: root });

    await writeFile(
      path.join(root, "app.json"),
      JSON.stringify({ expo: { scheme: "renamed" } }),
      "utf8",
    );

    const result = await handleInitCommand({ force: true }, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: { scheme: "renamed", source: "app.json", changed: true },
    });
    expect(result.ok && result.data.note).toBeUndefined();
    expect(await readProjectConfig(root)).toEqual({ scheme: "renamed" });
  });

  test("rejects an invalid scheme recorded by hand instead of echoing it into the MCP entry", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "myapp://" });

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(
      /records an invalid deep-link scheme/u,
    );
  });

  // The error above suggests `--scheme <s> --force`; that remedy has to actually work, rather than
  // hitting the same validation and reproducing the error it was offered to fix.
  test("--scheme --force replaces an invalid recorded scheme rather than failing on it", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "myapp://", keepMe: 1 });

    const result = await handleInitCommand({ scheme: "good", force: true }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "good", source: "--scheme" } });
    expect(await readProjectConfig(root)).toEqual({ scheme: "good", keepMe: 1 });
  });

  test("--force alone replaces an invalid recorded scheme with app.json's", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "myapp://" });

    const result = await handleInitCommand({ force: true }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "myapp", source: "app.json" } });
  });

  test("--scheme alone replaces an invalid recorded scheme — there is nothing to protect", async () => {
    const root = await makeAppRoot();
    await writeProjectConfigRaw(root, { scheme: "myapp://" });

    const result = await handleInitCommand({ scheme: "good" }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "good" } });
  });

  test("reports a usage error when .appduct is a file, not a directory", async () => {
    const root = await makeAppRoot("myapp");
    await writeFile(path.join(root, ".appduct"), "not a directory", "utf8");

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(
      /a file already exists where the "\.appduct" directory needs to go/u,
    );
  });

  test("reports a usage error when config.json is a directory", async () => {
    const root = await makeAppRoot("myapp");
    await mkdir(projectConfigPath(root), { recursive: true });

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(
      /it is a directory, not a file/u,
    );
  });

  test("writes the project config 0600 inside a 0700 directory", async () => {
    const root = await makeAppRoot("myapp");

    await handleInitCommand({}, { cwd: root });

    expect((await stat(projectConfigPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(projectConfigPath(root)))).mode & 0o777).toBe(0o700);
  });

  // `mkdir`/`writeFile` modes apply only at creation, so a directory left loose by an earlier
  // version, a umask, or a `git checkout` has to be repaired by a later run.
  test("tightens loose modes on a --force run", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "stale" });
    await chmod(path.dirname(projectConfigPath(root)), 0o755);
    await chmod(projectConfigPath(root), 0o644);

    await handleInitCommand({ force: true }, { cwd: root });

    expect((await stat(projectConfigPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(projectConfigPath(root)))).mode & 0o777).toBe(0o700);
  });

  test("tightens loose modes even on an idempotent no-op run", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "myapp" });
    await chmod(path.dirname(projectConfigPath(root)), 0o755);
    await chmod(projectConfigPath(root), 0o644);

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { changed: false } });
    expect((await stat(projectConfigPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(projectConfigPath(root)))).mode & 0o777).toBe(0o700);
  });

  // Run from `$HOME`, or from the parent of a `APPDUCT_STATE_DIR`, `<cwd>/.appduct` is the
  // daemon's state directory — where `key.pem` and the audit log live. Writing a config there and
  // calling it "safe to commit" would be an invitation to commit a private key.
  test("refuses to write into the active state directory", async () => {
    const parent = await makeAppRoot("myapp");
    const stateDir = path.join(parent, ".appduct");

    await expect(handleInitCommand({}, { cwd: parent, stateDir })).rejects.toThrow(
      /Refusing to write[\s\S]*state directory/u,
    );
    await expect(stat(projectConfigPath(parent))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to write into <home>/.appduct even with an unrelated state dir", async () => {
    const home = await makeAppRoot("myapp");

    await expect(
      handleInitCommand(
        {},
        { cwd: home, homeDir: home, stateDir: path.join(await makeAppRoot(), "elsewhere") },
      ),
    ).rejects.toThrow(/Refusing to write[\s\S]*state directory/u);
  });

  test("still writes normally in an app root that merely sits under the home directory", async () => {
    const home = await makeAppRoot();
    const appRoot = path.join(home, "projects", "demo");
    await mkdir(appRoot, { recursive: true });
    await writeFile(
      path.join(appRoot, "app.json"),
      JSON.stringify({ expo: { scheme: "myapp" } }),
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: appRoot, homeDir: home });

    expect(result).toMatchObject({ ok: true, data: { scheme: "myapp" } });
  });

  test("no divergence note when --scheme names the recorded value explicitly", async () => {
    const root = await makeAppRoot("renamed");
    await writeProjectConfigRaw(root, { scheme: "myapp" });

    const result = await handleInitCommand({ scheme: "myapp" }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "myapp", source: "--scheme" } });
    expect(result.ok && result.data.note).toBeUndefined();
  });

  test("--force replaces the scheme and preserves every other key", async () => {
    const root = await makeAppRoot("myapp");
    await mkdir(path.dirname(projectConfigPath(root)), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ scheme: "stale", somethingElse: { kept: true } }),
      "utf8",
    );

    const result = await handleInitCommand({ force: true }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "myapp", created: false, changed: true } });
    expect(await readProjectConfig(root)).toEqual({
      scheme: "myapp",
      somethingElse: { kept: true },
    });
  });

  test("keeps an existing scheme when app.json has none", async () => {
    const root = await makeAppRoot();
    await handleInitCommand({ scheme: "myapp" }, { cwd: root });

    const second = await handleInitCommand({}, { cwd: root });

    expect(second).toMatchObject({
      ok: true,
      data: { scheme: "myapp", source: "already-recorded", changed: false },
    });
  });

  test("fails with a usage error when no scheme can be found or given", async () => {
    const root = await makeAppRoot();

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(
      /No deep-link scheme found/u,
    );
  });

  test("rejects a scheme that is really a URL prefix", async () => {
    const root = await makeAppRoot();

    await expect(handleInitCommand({ scheme: "myapp://" }, { cwd: root })).rejects.toThrow(
      /Invalid deep-link scheme/u,
    );
  });

  test("reports a malformed existing project config instead of silently overwriting it", async () => {
    const root = await makeAppRoot("myapp");
    await mkdir(path.dirname(projectConfigPath(root)), { recursive: true });
    await writeFile(projectConfigPath(root), "{ not json", "utf8");

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(/Could not parse/u);
  });

  test("never generates key material or daemon state", async () => {
    const root = await makeAppRoot("myapp");

    await handleInitCommand({}, { cwd: root });

    await expect(stat(path.join(root, ".appduct", "key.pem"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(root, ".appduct", "daemon.sock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("init command (--ios-app-id / --android-app-id, issue #63)", () => {
  test("writes both ids into the project config, alongside scheme", async () => {
    const root = await makeAppRoot("myapp");

    const result = await handleInitCommand(
      { iosAppId: "com.example.ios", androidAppId: "com.example.android" },
      { cwd: root },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { appId: { ios: "com.example.ios", android: "com.example.android" } },
    });
    expect(await readProjectConfig(root)).toEqual({
      scheme: "myapp",
      appId: { ios: "com.example.ios", android: "com.example.android" },
    });
  });

  test("the two ids are independent: writing only one leaves the other untouched", async () => {
    const root = await makeAppRoot("myapp");

    await handleInitCommand({ androidAppId: "com.example.android" }, { cwd: root });
    const result = await handleInitCommand({ iosAppId: "com.example.ios" }, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: { appId: { ios: "com.example.ios", android: "com.example.android" } },
    });
    expect(await readProjectConfig(root)).toEqual({
      scheme: "myapp",
      appId: { ios: "com.example.ios", android: "com.example.android" },
    });
  });

  test("re-running with the same id is a no-op", async () => {
    const root = await makeAppRoot("myapp");

    await handleInitCommand({ androidAppId: "com.example.android" }, { cwd: root });
    const second = await handleInitCommand({ androidAppId: "com.example.android" }, { cwd: root });

    expect(second).toMatchObject({ ok: true, data: { changed: false } });
  });

  test("replacing a recorded id needs --force, exactly like --scheme", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({ androidAppId: "com.example.old" }, { cwd: root });

    await expect(
      handleInitCommand({ androidAppId: "com.example.new" }, { cwd: root }),
    ).rejects.toThrow(/--force/u);

    const forced = await handleInitCommand(
      { androidAppId: "com.example.new", force: true },
      { cwd: root },
    );
    expect(forced).toMatchObject({ ok: true, data: { appId: { android: "com.example.new" } } });
    expect(await readProjectConfig(root)).toMatchObject({
      appId: { android: "com.example.new" },
    });
  });

  test("--force on its own (no app id flags) does not touch an already-recorded id", async () => {
    const root = await makeAppRoot("myapp");
    await handleInitCommand({ androidAppId: "com.example.android" }, { cwd: root });

    const result = await handleInitCommand({ force: true }, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { appId: { android: "com.example.android" } } });
  });

  test("no appId flags at all: the config carries only scheme, same as before issue #63", async () => {
    const root = await makeAppRoot("myapp");

    const result = await handleInitCommand({}, { cwd: root });

    expect(result.ok && result.data.appId).toBeUndefined();
    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("a malformed already-recorded appId is reported rather than silently overwritten", async () => {
    const root = await makeAppRoot("myapp");
    await writeProjectConfigRaw(root, { scheme: "myapp", appId: { android: "" } });

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(/appId\.android/u);

    // --android-app-id is about to replace exactly the broken value, so it is not fatal here.
    const result = await handleInitCommand({ androidAppId: "com.example.android" }, { cwd: root });
    expect(result).toMatchObject({ ok: true, data: { appId: { android: "com.example.android" } } });
  });

  test("an app id that delivery would refuse is rejected before anything is written", async () => {
    for (const [option, bad] of [
      ["androidAppId", "com.x;reboot"],
      ["androidAppId", ""],
      ["iosAppId", "--console"],
      ["iosAppId", "com.$(id)"],
    ] as const) {
      const root = await makeAppRoot("myapp");

      await expect(handleInitCommand({ [option]: bad }, { cwd: root })).rejects.toThrow(
        /not a valid app id/u,
      );
      await expect(readFile(path.join(root, ".appduct", "config.json"), "utf8")).rejects.toThrow();
    }
  });

  test("an Android package name with underscores is accepted", async () => {
    const root = await makeAppRoot("myapp");

    await handleInitCommand({ androidAppId: "com.my_company.app" }, { cwd: root });

    expect(await readProjectConfig(root)).toMatchObject({ appId: { android: "com.my_company.app" } });
  });
});

/**
 * Issue #48's addition: `init` runs the exact same static-file discovery `resolveScheme`'s last
 * step does (`scheme.ts`'s `discoverStaticProjectScheme`) — `app.json` first, then the native
 * Android/iOS probes from `native-scheme.ts`. These cases exercise that path through `init`
 * specifically: the `source`/`origin` it reports, the disagreement error, and the "read from"
 * hint in `nextSteps`.
 */
describe("init command (native project discovery)", () => {
  test("discovers a scheme from an Android build.gradle.kts placeholder", async () => {
    const root = await makeAppRoot();
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(
      path.join(root, "app", "build.gradle.kts"),
      'android { defaultConfig { manifestPlaceholders["appductScheme"] = "myapp" } }',
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: {
        scheme: "myapp",
        source: "android-gradle",
        origin: expect.stringContaining("build.gradle.kts"),
      },
    });
    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("discovers a scheme from an AndroidManifest.xml VIEW intent-filter", async () => {
    const root = await makeAppRoot();
    const manifestPath = path.join(root, "app", "src", "main", "AndroidManifest.xml");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application><activity android:name=".Main"><intent-filter>
          <action android:name="android.intent.action.VIEW" />
          <data android:scheme="myapp" />
        </intent-filter></activity></application>
      </manifest>`,
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: { scheme: "myapp", source: "android-manifest" },
    });
  });

  test("discovers a scheme from an Info.plist CFBundleURLSchemes entry", async () => {
    const root = await makeAppRoot();
    await writeFile(
      path.join(root, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict>
        <key>CFBundleURLTypes</key>
        <array><dict>
          <key>CFBundleURLSchemes</key>
          <array><string>myapp</string></array>
        </dict></array>
      </dict></plist>`,
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: { scheme: "myapp", source: "ios-info-plist" },
    });
  });

  test("discovers a scheme from xcodegen's project.yml", async () => {
    const root = await makeAppRoot();
    await writeFile(
      path.join(root, "project.yml"),
      "info:\n  properties:\n    CFBundleURLTypes:\n      - CFBundleURLSchemes:\n          - myapp\n",
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({
      ok: true,
      data: { scheme: "myapp", source: "ios-project-yml" },
    });
  });

  test("app.json still wins over every native probe", async () => {
    const root = await makeAppRoot("from-app-json");
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(
      path.join(root, "app", "build.gradle.kts"),
      'manifestPlaceholders["appductScheme"] = "from-gradle"',
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: root });

    expect(result).toMatchObject({ ok: true, data: { scheme: "from-app-json", source: "app.json" } });
  });

  test("the human-readable hint names the file the scheme was read from", async () => {
    const root = await makeAppRoot();
    const manifestPath = path.join(root, "app", "src", "main", "AndroidManifest.xml");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application><activity android:name=".Main"><intent-filter>
          <action android:name="android.intent.action.VIEW" />
          <data android:scheme="myapp" />
        </intent-filter></activity></application>
      </manifest>`,
      "utf8",
    );

    const result = await handleInitCommand({}, { cwd: root });

    expect(result.ok).toBe(true);
    expect(
      result.ok && result.data.nextSteps.some((step) => step.includes(manifestPath)),
    ).toBe(true);
  });

  test("refuses to guess when two native probes disagree, naming both", async () => {
    const root = await makeAppRoot();
    const manifestPath = path.join(root, "app", "src", "main", "AndroidManifest.xml");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application><activity android:name=".Main"><intent-filter>
          <action android:name="android.intent.action.VIEW" />
          <data android:scheme="androidscheme" />
        </intent-filter></activity></application>
      </manifest>`,
      "utf8",
    );
    await writeFile(
      path.join(root, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict>
        <key>CFBundleURLTypes</key>
        <array><dict>
          <key>CFBundleURLSchemes</key>
          <array><string>iosscheme</string></array>
        </dict></array>
      </dict></plist>`,
      "utf8",
    );

    await expect(handleInitCommand({}, { cwd: root })).rejects.toThrow(
      /Conflicting deep-link schemes[\s\S]*androidscheme[\s\S]*iosscheme/u,
    );
    // Refusing to guess must not still write a config with one of the two guesses.
    await expect(stat(projectConfigPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("--force adopts a changed native-probe value and updates the note accordingly", async () => {
    const root = await makeAppRoot();
    const manifestPath = path.join(root, "app", "src", "main", "AndroidManifest.xml");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const writeManifest = (scheme: string) =>
      writeFile(
        manifestPath,
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
          <application><activity android:name=".Main"><intent-filter>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="${scheme}" />
          </intent-filter></activity></application>
        </manifest>`,
        "utf8",
      );
    await writeManifest("myapp");
    await handleInitCommand({}, { cwd: root });

    await writeManifest("renamed");
    const kept = await handleInitCommand({}, { cwd: root });

    expect(kept).toMatchObject({
      ok: true,
      data: { scheme: "myapp", source: "already-recorded", changed: false },
    });
    expect(kept.ok && kept.data.note).toMatch(/renamed[\s\S]*myapp/u);

    const forced = await handleInitCommand({ force: true }, { cwd: root });

    expect(forced).toMatchObject({
      ok: true,
      data: { scheme: "renamed", source: "android-manifest", changed: true },
    });
    expect(forced.ok && forced.data.note).toBeUndefined();
  });
});

/**
 * Issue #153: the first next step has to be the wiring this project still needs. It used to be the
 * `@appduct/react-native/auto` import for every project, which a plain Swift or Kotlin app cannot
 * act on. Which kind of project this is comes from the app root's own `package.json` (React Native
 * or not) and from what scheme discovery found on disk (`discovered.source`, which `init` computes
 * whether or not the scheme ends up coming from it), not from the `source` a run happens to report.
 */
describe("init command (next steps match the project it found)", () => {
  /** The step an Expo / React Native app gets, pinned verbatim: that path is what most users see. */
  const REACT_NATIVE_STEP =
    'Add `import "@appduct/react-native/auto";` to your app entry (index.js / App.tsx) — it ' +
    "is what starts the in-app agent endpoint.";

  const stepsOf = (result: Awaited<ReturnType<typeof handleInitCommand>>): string[] => {
    if (!result.ok) {
      throw new Error(`init failed: ${JSON.stringify(result)}`);
    }

    return result.data.nextSteps;
  };

  /** Writes an `Info.plist` declaring the `myapp` URL scheme in `directory`. */
  const writeInfoPlist = async (directory: string): Promise<void> => {
    await writeFile(
      path.join(directory, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict>
        <key>CFBundleURLTypes</key>
        <array><dict>
          <key>CFBundleURLSchemes</key>
          <array><string>myapp</string></array>
        </dict></array>
      </dict></plist>`,
      "utf8",
    );
  };

  /** Writes `app/src/main/AndroidManifest.xml` with a `myapp` deep-link filter and no
   * `appductScheme` placeholder — the shape the `android-manifest` probe resolves. */
  const writeAndroidDeepLinkManifest = async (root: string): Promise<void> => {
    const manifestPath = path.join(root, "app", "src", "main", "AndroidManifest.xml");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
        <application><activity android:name=".Main"><intent-filter>
          <action android:name="android.intent.action.VIEW" />
          <data android:scheme="myapp" />
        </intent-filter></activity></application>
      </manifest>`,
      "utf8",
    );
  };

  /** A plain SwiftUI app root: a URL scheme in `Info.plist`, no `package.json` anywhere. */
  const makeIosAppRoot = async (): Promise<string> => {
    const root = await makeAppRoot();
    await writeInfoPlist(root);

    return root;
  };

  /** A plain Kotlin app root: the `appductScheme` placeholder in `app/build.gradle.kts`. */
  const makeAndroidAppRoot = async (): Promise<string> => {
    const root = await makeAppRoot();
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(
      path.join(root, "app", "build.gradle.kts"),
      'android { defaultConfig { manifestPlaceholders["appductScheme"] = "myapp" } }',
      "utf8",
    );

    return root;
  };

  const writePackageJson = async (root: string, dependencies: Record<string, string>) => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "shop-app", dependencies }),
      "utf8",
    );
  };

  test("an Expo app still gets the React Native auto-import as its first step", async () => {
    const root = await makeAppRoot("myapp");
    await writePackageJson(root, { expo: "~54.0.33", react: "19.1.0", "react-native": "0.81.5" });

    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    expect(steps[0]).toBe(REACT_NATIVE_STEP);
  });

  test("a bare React Native app still gets the auto-import when its scheme came from ios/Info.plist", async () => {
    const root = await makeAppRoot();
    await writePackageJson(root, { react: "19.1.0", "react-native": "0.81.5" });
    await mkdir(path.join(root, "ios", "ShopApp"), { recursive: true });
    await writeFile(
      path.join(root, "ios", "ShopApp", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict>
        <key>CFBundleURLTypes</key>
        <array><dict>
          <key>CFBundleURLSchemes</key>
          <array><string>myapp</string></array>
        </dict></array>
      </dict></plist>`,
      "utf8",
    );

    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    // The iOS probe found the scheme, and the app is still React Native: the import is the step,
    // not UIKit URL forwarding, which this app does through React Native's Linking.
    expect(steps[0]).toBe(REACT_NATIVE_STEP);
    expect(steps.join("\n")).not.toContain("Appduct.shared.handle");
  });

  test("a plain iOS app gets the URL-forwarding step, not the React Native import", async () => {
    const root = await makeIosAppRoot();

    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    expect(steps[0]).toContain("Appduct.shared.handle(url)");
    expect(steps.join("\n")).not.toContain("@appduct/react-native");
  });

  test("a plain iOS app is not treated as React Native because it has a package.json", async () => {
    const root = await makeIosAppRoot();
    await writePackageJson(root, { "react-native-svg": "15.0.0" });

    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    expect(steps[0]).toContain("Appduct.shared.handle(url)");
    expect(steps.join("\n")).not.toContain("@appduct/react-native");
  });

  test("a plain Android app gets the appductScheme placeholder step, not the React Native import", async () => {
    const root = await makeAndroidAppRoot();

    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    // The scheme came from the placeholder itself, so this one really does name it.
    expect(steps[0]).toContain('manifestPlaceholders["appductScheme"] = "myapp"');
    expect(steps.join("\n")).not.toContain("@appduct/react-native");
  });

  // The `android-manifest` probe only ever reads the app's own VIEW intent filter, so the scheme it
  // reports is the app's primary deep link, not Appduct's. Telling the user to put it in
  // `appductScheme` is the collision the Android guide warns about: Appduct's trampoline activity
  // takes every link on that scheme and drops the ones that carry no Appduct payload.
  test("an Android app whose scheme came from its own manifest is told to give Appduct a scheme of its own", async () => {
    const root = await makeAppRoot();
    await writeAndroidDeepLinkManifest(root);

    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    expect(steps[0]).toContain('manifestPlaceholders["appductScheme"]');
    expect(steps[0]).not.toContain('"myapp"');
    expect(steps[0]).toContain("/install/android/#deep-links");
  });

  test("a plain Android app whose scheme came from its own manifest still gets the placeholder step, not the React Native import", async () => {
    const root = await makeAppRoot();
    await writeAndroidDeepLinkManifest(root);

    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    expect(steps.join("\n")).not.toContain("@appduct/react-native");
  });

  test("an Expo app run from its ios directory still gets the auto-import", async () => {
    const root = await makeAppRoot();
    await writePackageJson(root, { expo: "~54.0.33", "react-native": "0.81.5" });
    await mkdir(path.join(root, "ios"), { recursive: true });

    const steps = stepsOf(
      await handleInitCommand({ scheme: "myapp" }, { cwd: path.join(root, "ios") }),
    );

    expect(steps[0]).toBe(REACT_NATIVE_STEP);
    expect(steps.join("\n")).not.toContain("Appduct.shared.handle");
  });

  test("a bare React Native app run from its ios directory still gets the auto-import", async () => {
    const root = await makeAppRoot();
    await writePackageJson(root, { react: "19.1.0", "react-native": "0.81.5" });
    await mkdir(path.join(root, "ios", "ShopApp"), { recursive: true });
    await writeInfoPlist(path.join(root, "ios", "ShopApp"));

    const steps = stepsOf(await handleInitCommand({}, { cwd: path.join(root, "ios") }));

    // People sit in `ios/` to run `pod install`, and the iOS probe hits there — but the app is still
    // React Native, and forwarding URLs to `Appduct.shared.handle(url)` is code it does not have.
    expect(steps[0]).toBe(REACT_NATIVE_STEP);
    expect(steps.join("\n")).not.toContain("Appduct.shared.handle");
  });

  test("a bare React Native app run from its android directory still gets the auto-import", async () => {
    const root = await makeAppRoot();
    await writePackageJson(root, { react: "19.1.0", "react-native": "0.81.5" });
    await writeAndroidDeepLinkManifest(path.join(root, "android"));

    const steps = stepsOf(await handleInitCommand({}, { cwd: path.join(root, "android") }));

    expect(steps[0]).toBe(REACT_NATIVE_STEP);
    expect(steps.join("\n")).not.toContain("manifestPlaceholders");
  });

  // The walk up exists to see the app's own manifest from inside `ios/` or `android/`, so it stops
  // two directories above the app root: past that it would be reading a workspace or a home
  // directory that says nothing about the app being initialized.
  test("a plain iOS app three directories below a React Native manifest still gets the URL-forwarding step", async () => {
    const repo = await makeAppRoot();
    await writePackageJson(repo, { react: "19.1.0", "react-native": "0.81.5" });
    const appDir = path.join(repo, "apps", "shop", "ios");
    await mkdir(appDir, { recursive: true });
    await writeInfoPlist(appDir);

    const steps = stepsOf(await handleInitCommand({}, { cwd: appDir }));

    expect(steps[0]).toContain("Appduct.shared.handle(url)");
    expect(steps.join("\n")).not.toContain("@appduct/react-native");
  });

  test("a re-run that keeps the recorded scheme still prints the same native step", async () => {
    const root = await makeIosAppRoot();

    await handleInitCommand({}, { cwd: root });
    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    expect(steps[0]).toContain("Appduct.shared.handle(url)");
    expect(steps.join("\n")).not.toContain("@appduct/react-native");
  });

  test("--scheme in a project whose platform discovery cannot see names both native steps", async () => {
    const root = await makeAppRoot();

    const steps = stepsOf(await handleInitCommand({ scheme: "myapp" }, { cwd: root }));

    expect(steps[0]).toContain("Appduct.shared.handle(url)");
    expect(steps[1]).toContain('manifestPlaceholders["appductScheme"]');
    expect(steps.join("\n")).not.toContain("@appduct/react-native");
  });

  /** One root that is both an Android module root and an Xcode project, agreeing on `myapp`. */
  const makeBothPlatformsRoot = async (): Promise<string> => {
    const root = await makeAndroidAppRoot();
    await mkdir(path.join(root, "ios", "App"), { recursive: true });
    await writeInfoPlist(path.join(root, "ios", "App"));

    return root;
  };

  const platformsOf = (result: Awaited<ReturnType<typeof handleInitCommand>>): unknown => {
    if (!result.ok) {
      throw new Error(`init failed: ${JSON.stringify(result)}`);
    }

    return (result.data as { platforms?: unknown }).platforms;
  };

  test("a root that spans iOS and Android prints the iOS step and then the Android placeholder step", async () => {
    const root = await makeBothPlatformsRoot();

    const result = await handleInitCommand({}, { cwd: root });
    const steps = stepsOf(result);

    expect(steps[0]).toContain("Appduct.shared.handle(url)");
    expect(steps[1]).toContain('manifestPlaceholders["appductScheme"] = "myapp"');
    expect(platformsOf(result)).toEqual(["android", "ios"]);
    expect(result.ok && result.data.source).toBe("android-gradle");
  });

  test("a root whose Gradle file and Android manifest agree reports android only and prints only the placeholder step", async () => {
    const root = await makeAndroidAppRoot();
    await writeAndroidDeepLinkManifest(root);

    const result = await handleInitCommand({}, { cwd: root });
    const steps = stepsOf(result);

    expect(platformsOf(result)).toEqual(["android"]);
    expect(steps[0]).toContain('manifestPlaceholders["appductScheme"] = "myapp"');
    expect(steps.join("\n")).not.toContain("Appduct.shared.handle");
  });

  test("an Android manifest next to an iOS project prints the iOS step and the own-scheme Android step", async () => {
    const root = await makeAppRoot();
    await writeAndroidDeepLinkManifest(root);
    await mkdir(path.join(root, "ios", "App"), { recursive: true });
    await writeInfoPlist(path.join(root, "ios", "App"));

    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    expect(steps[0]).toContain("Appduct.shared.handle(url)");
    expect(steps[1]).toContain('manifestPlaceholders["appductScheme"]');
    expect(steps[1]).not.toContain('"myapp"');
  });

  test("an Android-only root reports android and an iOS-only root reports ios", async () => {
    expect(platformsOf(await handleInitCommand({}, { cwd: await makeAndroidAppRoot() }))).toEqual([
      "android",
    ]);
    expect(platformsOf(await handleInitCommand({}, { cwd: await makeIosAppRoot() }))).toEqual(["ios"]);
  });

  test("a re-run that keeps the recorded scheme still reports platforms and prints both steps", async () => {
    const root = await makeBothPlatformsRoot();

    await handleInitCommand({}, { cwd: root });
    const result = await handleInitCommand({}, { cwd: root });
    const steps = stepsOf(result);

    expect(result.ok && result.data.source).toBe("already-recorded");
    expect(platformsOf(result)).toEqual(["android", "ios"]);
    expect(steps[0]).toContain("Appduct.shared.handle(url)");
    expect(steps[1]).toContain("appductScheme");
  });

  test("--scheme in a two-platform root still reports platforms", async () => {
    const root = await makeBothPlatformsRoot();

    const result = await handleInitCommand({ scheme: "other" }, { cwd: root });

    expect(platformsOf(result)).toEqual(["android", "ios"]);
  });

  test("no native project seen: platforms is absent and both steps print", async () => {
    const root = await makeAppRoot();

    const result = await handleInitCommand({ scheme: "myapp" }, { cwd: root });

    expect(result.ok && "platforms" in result.data).toBe(false);
    expect(stepsOf(result)[0]).toContain("Appduct.shared.handle(url)");
    expect(stepsOf(result)[1]).toContain("appductScheme");
  });

  test("the native steps replace the import step but leave every other step alone", async () => {
    const root = await makeAndroidAppRoot();

    const steps = stepsOf(await handleInitCommand({}, { cwd: root }));

    expect(steps[1]).toContain("Add the Appduct MCP server entry");
    expect(steps[2]).toContain("appduct sessions link --open ios-sim");
    expect(steps[3]).toContain("was read from");
    expect(steps[4]).toContain("--ios-app-id");
    expect(steps[5]).toContain("safe to commit");
    expect(steps).toHaveLength(6);
  });

  test("prints the iOS step and not the React Native import, through the real CLI", async () => {
    const root = await makeIosAppRoot();

    const result = runCliBinary(["init"], { cwd: root, stateDir: await makeStateDir() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Appduct.shared.handle(url)");
    expect(result.stdout).not.toContain("@appduct/react-native");
  });
});

describe("appduct init (CLI)", () => {
  test("is idempotent across two real CLI runs", async () => {
    const root = await makeAppRoot("myapp");
    const stateDir = await makeStateDir();

    const first = runCliBinary(["init", "--json"], { cwd: root, stateDir });
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      ok: true,
      data: { scheme: "myapp", created: true, changed: true },
    });

    const second = runCliBinary(["init", "--json"], { cwd: root, stateDir });
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      ok: true,
      data: { scheme: "myapp", created: false, changed: false },
    });

    expect(await readProjectConfig(root)).toEqual({ scheme: "myapp" });
  });

  test("prints the MCP snippet and the auto-import reminder", async () => {
    const root = await makeAppRoot("myapp");

    const result = runCliBinary(["init"], { cwd: root, stateDir: await makeStateDir() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"appduct"');
    expect(result.stdout).toContain('"--scheme"');
    expect(result.stdout).toContain("myapp");
    expect(result.stdout).toContain('import "@appduct/react-native/auto"');
  });

  test("exits 64 with a usage error when there is nothing to discover", async () => {
    const root = await makeAppRoot();

    const result = runCliBinary(["init", "--json"], { cwd: root, stateDir: await makeStateDir() });

    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { type: "usage_error" },
    });
  });

  test("--force is required to change a recorded scheme", async () => {
    const root = await makeAppRoot("myapp");
    const stateDir = await makeStateDir();

    runCliBinary(["init"], { cwd: root, stateDir });

    const refused = runCliBinary(["init", "--scheme", "other", "--json"], { cwd: root, stateDir });
    expect(refused.exitCode).toBe(64);

    const forced = runCliBinary(["init", "--scheme", "other", "--force", "--json"], {
      cwd: root,
      stateDir,
    });
    expect(forced.exitCode).toBe(0);
    expect(await readProjectConfig(root)).toEqual({ scheme: "other" });
  });

  test("--ios-app-id/--android-app-id write appId, and re-running is still safe", async () => {
    const root = await makeAppRoot("myapp");
    const stateDir = await makeStateDir();

    const first = runCliBinary(
      ["init", "--ios-app-id", "com.example.ios", "--android-app-id", "com.example.android", "--json"],
      { cwd: root, stateDir },
    );
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      ok: true,
      data: { appId: { ios: "com.example.ios", android: "com.example.android" } },
    });
    expect(await readProjectConfig(root)).toEqual({
      scheme: "myapp",
      appId: { ios: "com.example.ios", android: "com.example.android" },
    });

    const second = runCliBinary(
      ["init", "--ios-app-id", "com.example.ios", "--android-app-id", "com.example.android", "--json"],
      { cwd: root, stateDir },
    );
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, data: { changed: false } });
  });
});
