/**
 * Issue #29's headline acceptance criterion, end to end against a real daemon: an app directory
 * whose only Appduct-relevant file is `app.json` with `expo.scheme` can mint a link with an
 * otherwise-empty state dir — no `config.json`, no `appduct init`, no hand-editing.
 *
 * The state dir here does hold `wssPort`/`advertisedIp`/`key.pem` because the test daemon needs a
 * free port and a key, but it never holds a `scheme`: that is the value under test.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { handleLinkCommand } from "../commands/link.js";
import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { makeTempStateDir } from "./fixtures.js";

const runningDaemons: RunningDaemon[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (directories.length > 0) {
    await rm(directories.pop()!, { force: true, recursive: true });
  }
});

/** A daemon whose `config.json` deliberately carries no `scheme`. */
const startSchemelessDaemon = async (): Promise<string> => {
  const stateDir = await makeTempStateDir({}, { prefix: "appduct-discovery-state-" });
  directories.push(stateDir);

  runningDaemons.push(await startDaemon({ stateDir }));

  return stateDir;
};

const makeAppRoot = async (expoScheme?: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "appduct-discovery-app-"));
  directories.push(root);

  if (expoScheme !== undefined) {
    await writeFile(
      path.join(root, "app.json"),
      JSON.stringify({ expo: { name: "Demo", scheme: expoScheme } }),
    );
  }

  return root;
};

const failIfCalled = (): never => {
  throw new Error("auto-spawn should never be needed: the test daemon is already running.");
};

const mint = async (stateDir: string, cwd: string, scheme?: string) => {
  return handleLinkCommand(
    { scheme },
    // `schemeEnv` (not `env`, which is the adb/simctl environment) is pinned empty so an exported
    // APPDUCT_SCHEME on the developer's machine cannot decide these assertions.
    { stateDir, cwd, spawn: failIfCalled, schemeEnv: {} },
  );
};

describe("appduct link scheme discovery", () => {
  test("mints from an app.json alone, with no scheme configured anywhere", async () => {
    const stateDir = await startSchemelessDaemon();
    const appRoot = await makeAppRoot("myapp");

    const result = await mint(stateDir, appRoot);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.deepLink).toMatch(/^myapp:\/\/\/\?appduct=/u);
  });

  test("a project .appduct/config.json found by walking up wins over app.json", async () => {
    const stateDir = await startSchemelessDaemon();
    const appRoot = await makeAppRoot("from-app-json");
    await mkdir(path.join(appRoot, ".appduct"), { recursive: true });
    await writeFile(
      path.join(appRoot, ".appduct", "config.json"),
      JSON.stringify({ scheme: "from-project-config" }),
    );

    const nested = path.join(appRoot, "src", "screens");
    await mkdir(nested, { recursive: true });

    // Run from a subdirectory: the walk-up is what makes `appduct link` work anywhere in a repo.
    const result = await mint(stateDir, nested);

    expect(result.ok && result.data.deepLink).toMatch(/^from-project-config:\/\/\/\?appduct=/u);
  });

  test("--scheme still wins over everything discovered", async () => {
    const stateDir = await startSchemelessDaemon();
    const appRoot = await makeAppRoot("from-app-json");

    const result = await mint(stateDir, appRoot, "from-flag");

    expect(result.ok && result.data.deepLink).toMatch(/^from-flag:\/\/\/\?appduct=/u);
  });

  test("fails with a usage error naming every location when nothing declares a scheme", async () => {
    const stateDir = await startSchemelessDaemon();
    const appRoot = await makeAppRoot();

    await expect(mint(stateDir, appRoot)).rejects.toThrow(
      /A deep-link scheme is required[\s\S]*APPDUCT_SCHEME[\s\S]*app\.json/u,
    );
  });
});
