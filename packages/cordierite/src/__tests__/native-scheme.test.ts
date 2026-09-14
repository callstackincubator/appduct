/**
 * Static-file scheme discovery for plain iOS/Android apps (`native-scheme.ts`,
 * docs/tasks/20-cli-native-scheme-discovery.md, phase 3 of issue #48): the four probes
 * (`android-gradle`, `android-manifest`, `ios-info-plist`, `ios-project-yml`), the depth/size
 * limits guarding the `Info.plist` walk, binary-plist handling, and the disagreement error.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { discoverNativeScheme } from "../native-scheme.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { force: true, recursive: true });
  }
});

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "cordierite-native-scheme-"));
  directories.push(dir);

  return dir;
};

const write = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
};

const androidManifestXml = (dataTag: string, actionName = "android.intent.action.VIEW"): string => `
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <activity android:name=".MainActivity">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
      <intent-filter>
        <action android:name="${actionName}" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        ${dataTag}
      </intent-filter>
    </activity>
  </application>
</manifest>
`;

const infoPlistXml = (scheme: string): string => `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>${scheme}</string>
			</array>
		</dict>
	</array>
	<key>CFBundleIdentifier</key>
	<string>com.example.demo</string>
</dict>
</plist>
`;

describe("discoverNativeScheme", () => {
  test("returns no result and one tried entry per probe when nothing exists", async () => {
    const root = await makeDir();

    const { result, tried } = await discoverNativeScheme(root);

    expect(result).toBeUndefined();
    expect(tried).toHaveLength(4);
  });

  describe("android-gradle", () => {
    test("reads the bracket-form placeholder from build.gradle.kts", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "app", "build.gradle.kts"),
        'android { defaultConfig { manifestPlaceholders["cordieriteScheme"] = "myapp" } }',
      );

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ source: "android-gradle", scheme: "myapp" });
    });

    test("reads the dot-property form", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "app", "build.gradle.kts"),
        'android { defaultConfig { manifestPlaceholders.cordieriteScheme = "myapp" } }',
      );

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ source: "android-gradle", scheme: "myapp" });
    });

    test("falls back to build.gradle when build.gradle.kts has no placeholder", async () => {
      const root = await makeDir();
      await write(path.join(root, "app", "build.gradle.kts"), "android { defaultConfig { } }");
      await write(
        path.join(root, "app", "build.gradle"),
        'android { defaultConfig { manifestPlaceholders["cordieriteScheme"] = "myapp" } }',
      );

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ source: "android-gradle", scheme: "myapp" });
    });

    test("throws for an invalid placeholder value", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "app", "build.gradle.kts"),
        'manifestPlaceholders["cordieriteScheme"] = "myapp://"',
      );

      await expect(discoverNativeScheme(root)).rejects.toThrow(/Invalid deep-link scheme/u);
    });

    test("skips a build.gradle.kts too large to read, without throwing", async () => {
      const root = await makeDir();
      // One byte over the 2 MiB cap; deliberately contains a well-formed placeholder so the only
      // way the test can pass is if the size cap — not the regex — is what skips it.
      const oversized =
        'manifestPlaceholders["cordieriteScheme"] = "myapp"\n' + "x".repeat(2 * 1024 * 1024);
      await write(path.join(root, "app", "build.gradle.kts"), oversized);

      const { result, tried } = await discoverNativeScheme(root);

      expect(result).toBeUndefined();
      expect(tried[0]).toContain("too large, skipped");
    });
  });

  describe("android-manifest", () => {
    test("reads the data scheme from the VIEW intent-filter", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "app", "src", "main", "AndroidManifest.xml"),
        androidManifestXml('<data android:scheme="myapp" />'),
      );

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ source: "android-manifest", scheme: "myapp" });
    });

    test("ignores a <data android:scheme> in a non-VIEW intent-filter", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "app", "src", "main", "AndroidManifest.xml"),
        androidManifestXml('<data android:scheme="myapp" />', "android.intent.action.SEND"),
      );

      const { result } = await discoverNativeScheme(root);

      expect(result).toBeUndefined();
    });

    test("throws for an invalid manifest scheme", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "app", "src", "main", "AndroidManifest.xml"),
        androidManifestXml('<data android:scheme="not a scheme" />'),
      );

      await expect(discoverNativeScheme(root)).rejects.toThrow(/Invalid deep-link scheme/u);
    });
  });

  describe("ios-info-plist", () => {
    test("reads the first CFBundleURLSchemes entry", async () => {
      const root = await makeDir();
      await write(path.join(root, "Info.plist"), infoPlistXml("myapp"));

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ source: "ios-info-plist", scheme: "myapp" });
    });

    test("prefers the shallower of two Info.plist files", async () => {
      const root = await makeDir();
      await write(path.join(root, "MyApp", "Info.plist"), infoPlistXml("nested"));
      await write(path.join(root, "Info.plist"), infoPlistXml("shallow"));

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ scheme: "shallow" });
    });

    test("never descends into Pods, build, node_modules or DerivedData", async () => {
      const root = await makeDir();
      await write(path.join(root, "Pods", "Info.plist"), infoPlistXml("pods"));
      await write(path.join(root, "node_modules", "Info.plist"), infoPlistXml("nm"));
      await write(path.join(root, "build", "Info.plist"), infoPlistXml("build"));
      await write(path.join(root, "DerivedData", "Info.plist"), infoPlistXml("dd"));

      const { result } = await discoverNativeScheme(root);

      expect(result).toBeUndefined();
    });

    test("does not descend past two levels deep", async () => {
      const root = await makeDir();
      // Three levels below root: excluded by the depth cap.
      await write(path.join(root, "a", "b", "c", "Info.plist"), infoPlistXml("toodeep"));

      const { result } = await discoverNativeScheme(root);

      expect(result).toBeUndefined();
    });

    test("finds an Info.plist exactly two levels deep", async () => {
      const root = await makeDir();
      await write(path.join(root, "a", "b", "Info.plist"), infoPlistXml("twolevels"));

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ scheme: "twolevels" });
    });

    test("treats a binary-encoded plist as unreadable rather than a hard failure", async () => {
      const root = await makeDir();
      const binary = Buffer.concat([Buffer.from("bplist00", "latin1"), Buffer.from([0, 1, 2, 3])]);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "Info.plist"), binary);

      const { result, tried } = await discoverNativeScheme(root);

      expect(result).toBeUndefined();
      expect(tried.join("\n")).toContain("binary plist");
      expect(tried.join("\n")).toContain("use --scheme");
    });

    test("falls through a binary plist to a readable one", async () => {
      const root = await makeDir();
      const binary = Buffer.concat([Buffer.from("bplist00", "latin1"), Buffer.from([0, 1, 2, 3])]);
      // "a/Info.plist" sorts before "b/Info.plist" at the same depth, so the binary one is tried
      // first and must not stop discovery from reaching the readable one.
      await mkdir(path.join(root, "a"), { recursive: true });
      await writeFile(path.join(root, "a", "Info.plist"), binary);
      await write(path.join(root, "b", "Info.plist"), infoPlistXml("readable"));

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ scheme: "readable" });
    });

    test("throws for an invalid scheme in Info.plist", async () => {
      const root = await makeDir();
      await write(path.join(root, "Info.plist"), infoPlistXml("not a scheme"));

      await expect(discoverNativeScheme(root)).rejects.toThrow(/Invalid deep-link scheme/u);
    });

    test("skips a CFBundleURLTypes dict with no CFBundleURLSchemes and uses the next one", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeRole</key>
			<string>Editor</string>
		</dict>
		<dict>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>second</string>
			</array>
		</dict>
	</array>
</dict>
</plist>`,
      );

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ scheme: "second" });
    });
  });

  describe("ios-project-yml", () => {
    test("reads the block-sequence form", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "project.yml"),
        [
          "name: Demo",
          "info:",
          "  properties:",
          "    CFBundleURLTypes:",
          "      - CFBundleURLSchemes:",
          "          - myapp",
        ].join("\n"),
      );

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ source: "ios-project-yml", scheme: "myapp" });
    });

    test("reads the inline flow-sequence form", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "project.yml"),
        [
          "name: Demo",
          "info:",
          "  properties:",
          "    CFBundleURLTypes:",
          "      - CFBundleURLSchemes: [myapp]",
        ].join("\n"),
      );

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ source: "ios-project-yml", scheme: "myapp" });
    });

    test("throws for an invalid scheme", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "project.yml"),
        "info:\n  properties:\n    CFBundleURLTypes:\n      - CFBundleURLSchemes: [not-valid://]",
      );

      await expect(discoverNativeScheme(root)).rejects.toThrow(/Invalid deep-link scheme/u);
    });

    test("is only consulted when Info.plist found nothing", async () => {
      const root = await makeDir();
      await write(path.join(root, "Info.plist"), infoPlistXml("fromplist"));
      await write(
        path.join(root, "project.yml"),
        "info:\n  properties:\n    CFBundleURLTypes:\n      - CFBundleURLSchemes: [fromplist]",
      );

      const { result } = await discoverNativeScheme(root);

      // Both agree, so no disagreement error; the earlier probe (ios-info-plist) is attributed.
      expect(result).toMatchObject({ source: "ios-info-plist", scheme: "fromplist" });
    });
  });

  describe("disagreement", () => {
    test("throws naming both sources when two probes resolve different schemes", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "app", "src", "main", "AndroidManifest.xml"),
        androidManifestXml('<data android:scheme="myapp" />'),
      );
      await write(path.join(root, "Info.plist"), infoPlistXml("otherapp"));

      await expect(discoverNativeScheme(root)).rejects.toThrow(
        /Conflicting deep-link schemes[\s\S]*myapp[\s\S]*otherapp/u,
      );
    });

    test("does not throw, and attributes the earlier probe, when every hit agrees", async () => {
      const root = await makeDir();
      await write(
        path.join(root, "app", "build.gradle.kts"),
        'manifestPlaceholders["cordieriteScheme"] = "myapp"',
      );
      await write(
        path.join(root, "app", "src", "main", "AndroidManifest.xml"),
        androidManifestXml('<data android:scheme="myapp" />'),
      );

      const { result } = await discoverNativeScheme(root);

      expect(result).toMatchObject({ source: "android-gradle", scheme: "myapp" });
    });
  });
});
