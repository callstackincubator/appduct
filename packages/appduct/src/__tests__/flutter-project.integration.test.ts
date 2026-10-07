/**
 * Flutter projects (issue #197, slice 7 of #189): a directory with a `pubspec.yaml` keeps its
 * Android app in `android/app/` and its Apple apps in `ios/Runner` and `macos/Runner`. Scheme
 * discovery has to look there, and `appduct init` has to print Flutter's setup steps instead of
 * the React Native reminder.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { handleInitCommand } from "../commands/init.js";
import { handleLinkCommand } from "../commands/link.js";
import type { ExecFn } from "../cli/open-target.js";
import { startDaemon, type RunningDaemon } from "../daemon/daemon.js";
import { discoverStaticProjectScheme } from "../scheme.js";
import { makeTempStateDir, removeStateDir, runCliBinary } from "./fixtures.js";

const directories: string[] = [];
const stateDirs: string[] = [];
const runningDaemons: RunningDaemon[] = [];

afterEach(async () => {
  while (runningDaemons.length > 0) {
    await runningDaemons.pop()?.shutdown();
  }

  while (stateDirs.length > 0) {
    await removeStateDir(stateDirs.pop()!);
  }

  while (directories.length > 0) {
    await rm(directories.pop()!, { force: true, recursive: true });
  }
});

const androidManifest = (scheme: string): string => `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="demo">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW"/>
        <category android:name="android.intent.category.DEFAULT"/>
        <category android:name="android.intent.category.BROWSABLE"/>
        <data android:scheme="${scheme}"/>
      </intent-filter>
    </activity>
  </application>
</manifest>
`;

const infoPlist = (scheme: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>demo</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${scheme}</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;

const write = async (root: string, relative: string, contents: string): Promise<void> => {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
};

type FlutterFixture = { android?: string; ios?: string; macos?: string; pubspec?: boolean };

/** A Flutter project tree shaped like `flutter create` output, with the given schemes declared. */
const makeProject = async (fixture: FlutterFixture): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "appduct-flutter-"));
  directories.push(root);

  if (fixture.pubspec !== false) {
    await write(root, "pubspec.yaml", "name: demo\nenvironment:\n  sdk: ^3.10.0\n");
  }

  if (fixture.android !== undefined) {
    await write(root, "android/app/src/main/AndroidManifest.xml", androidManifest(fixture.android));
  }

  if (fixture.ios !== undefined) {
    await write(root, "ios/Runner/Info.plist", infoPlist(fixture.ios));
  }

  if (fixture.macos !== undefined) {
    await write(root, "macos/Runner/Info.plist", infoPlist(fixture.macos));
  }

  return root;
};

describe("scheme discovery in a Flutter project", () => {
  test("reads the Android scheme from android/app/src/main/AndroidManifest.xml", async () => {
    const root = await makeProject({ android: "fluttermanifest" });

    const found = await discoverStaticProjectScheme(root);

    expect(found).toMatchObject({ scheme: "fluttermanifest", source: "android-manifest" });
    expect(found.origin).toContain(path.join("android", "app", "src", "main", "AndroidManifest.xml"));
  });

  test("reads the Android scheme from the appductScheme placeholder in android/app/build.gradle.kts", async () => {
    const root = await makeProject({});
    await write(
      root,
      "android/app/build.gradle.kts",
      'android { defaultConfig { manifestPlaceholders["appductScheme"] = "flutterplaceholder" } }\n',
    );

    expect(await discoverStaticProjectScheme(root)).toMatchObject({
      scheme: "flutterplaceholder",
      source: "android-gradle",
    });
  });

  test("reads the iOS scheme from ios/Runner/Info.plist", async () => {
    const root = await makeProject({ ios: "flutterios" });

    expect(await discoverStaticProjectScheme(root)).toMatchObject({
      scheme: "flutterios",
      source: "ios-info-plist",
    });
  });

  test("reads the macOS scheme from macos/Runner/Info.plist", async () => {
    const root = await makeProject({ macos: "fluttermac" });

    expect(await discoverStaticProjectScheme(root)).toMatchObject({
      scheme: "fluttermac",
      source: "ios-info-plist",
    });
  });

  test("a project that declares the same scheme on every platform resolves to it", async () => {
    const root = await makeProject({ android: "myapp", ios: "myapp", macos: "myapp" });

    expect(await discoverStaticProjectScheme(root)).toMatchObject({ scheme: "myapp" });
  });

  test("names both files when Android and iOS declare different schemes", async () => {
    const root = await makeProject({ android: "droidapp", ios: "iosapp" });

    await expect(discoverStaticProjectScheme(root)).rejects.toThrow(
      /android[/\\]app[/\\]src[/\\]main[/\\]AndroidManifest\.xml.*"droidapp".*ios[/\\]Runner[/\\]Info\.plist.*"iosapp"/su,
    );
  });

  test("names both files when iOS and macOS declare different schemes", async () => {
    const root = await makeProject({ ios: "iosapp", macos: "macapp" });

    await expect(discoverStaticProjectScheme(root)).rejects.toThrow(
      /ios[/\\]Runner[/\\]Info\.plist.*"iosapp".*macos[/\\]Runner[/\\]Info\.plist.*"macapp"/su,
    );
  });

  test("does not read android/app without a pubspec.yaml", async () => {
    const root = await makeProject({ android: "notflutter", pubspec: false });

    const found = await discoverStaticProjectScheme(root);

    expect(found.scheme).toBeUndefined();
  });
});

describe("appduct init in a Flutter project", () => {
  const run = async (root: string) => {
    const result = await handleInitCommand({}, { cwd: root });

    if (!result.ok) {
      throw new Error("expected init to succeed");
    }

    return result.data;
  };

  test("records the scheme found under android/app", async () => {
    const root = await makeProject({ android: "myapp" });

    expect(await run(root)).toMatchObject({ scheme: "myapp", source: "android-manifest" });
  });

  test("prints the Flutter steps and not the React Native reminder", async () => {
    const root = await makeProject({ android: "myapp", ios: "myapp" });

    const steps = (await run(root)).nextSteps.join("\n");

    expect(steps).toContain("flutter pub add appduct");
    expect(steps).toContain("Appduct.ensureInitialized()");
    expect(steps).toMatch(/before `?runApp/u);
    expect(steps).not.toContain("@appduct/react-native/auto");
    expect(steps).not.toContain("Appduct.shared.handle");
    expect(steps).not.toContain("manifestPlaceholders");
  });

  test("names the URL scheme to register on each platform", async () => {
    const root = await makeProject({ android: "myapp" });

    const steps = (await run(root)).nextSteps.join("\n");

    expect(steps).toMatch(/AndroidManifest\.xml/u);
    expect(steps).toMatch(/ios\/Runner\/Info\.plist/u);
    expect(steps).toMatch(/macos\/Runner\/Info\.plist/u);
    expect(steps).toContain("CFBundleURLSchemes");
  });

  test("names the permissions a LAN link needs on each platform", async () => {
    const root = await makeProject({ android: "myapp" });

    const steps = (await run(root)).nextSteps.join("\n");

    expect(steps).toContain("android.permission.INTERNET");
    expect(steps).toContain("NSLocalNetworkUsageDescription");
    expect(steps).toContain("com.apple.security.network.client");
    expect(steps).toContain("DebugProfile.entitlements");
    expect(steps).toContain("Release.entitlements");
  });

  test("keeps every step after the first the same as for any other project", async () => {
    const flutter = await makeProject({ android: "myapp" });
    const expo = await mkdtemp(path.join(tmpdir(), "appduct-flutter-expo-"));
    directories.push(expo);
    await write(expo, "app.json", JSON.stringify({ expo: { scheme: "myapp" } }));

    const flutterSteps = (await run(flutter)).nextSteps;
    const expoSteps = (await run(expo)).nextSteps;

    const generic = (steps: string[]): string[] =>
      steps.filter((step) => !step.startsWith("Scheme ") && /MCP|pair a device|safe to commit|app's id/u.test(step));

    expect(generic(flutterSteps)).toHaveLength(4);
    expect(generic(flutterSteps)).toEqual(generic(expoSteps));
  });

  test("still prints the React Native reminder for an Expo app", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "appduct-flutter-expo-"));
    directories.push(root);
    await write(root, "app.json", JSON.stringify({ expo: { scheme: "myapp" } }));

    const steps = (await run(root)).nextSteps.join("\n");

    expect(steps).toContain('import "@appduct/react-native/auto"');
    expect(steps).not.toContain("flutter pub add");
  });

  test("prints the Flutter steps through the real CLI", async () => {
    const root = await makeProject({ android: "myapp" });
    const stateDir = await makeTempStateDir({}, { prefix: "appduct-flutter-state-" });
    stateDirs.push(stateDir);

    const result = runCliBinary(["init"], { cwd: root, stateDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("flutter pub add appduct");
    expect(result.stdout).not.toContain("@appduct/react-native/auto");
  });
});

describe("appduct sessions link from a Flutter project", () => {
  test("--open android picks the scheme from android/app", async () => {
    const root = await makeProject({ android: "fluttercli" });
    const stateDir = await makeTempStateDir(
      { advertisedIp: "203.0.113.9" },
      { prefix: "appduct-flutter-link-" },
    );
    stateDirs.push(stateDir);
    runningDaemons.push(await startDaemon({ stateDir }));

    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };

    const result = await handleLinkCommand(
      { open: "android", appId: "com.example.demo" },
      { stateDir, cwd: root, exec, schemeEnv: {}, env: { ANDROID_SERIAL: "emulator-5554" } },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.deepLink).toMatch(/^fluttercli:\/\/\/\?appduct=/u);
    expect(calls.at(-1)?.args).toContain("com.example.demo");
  });
});
