import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type Platform = "ios" | "android";

/** One command of a build, run in `cwd` (relative to the playground's `dir`). */
export type Step = { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> };

/** One playground on one platform: where it lives, how to build it, and which cases apply. */
export type Target = {
  name: TargetName;
  platform: Platform;
  /** The playground root, which holds the `.appduct/config.json` that `link` reads its scheme
   * and app id from. */
  dir: string;
  appId: string;
  scheme: string;
  /** Builds the debug app into `artifact`; the device id is for `xcodebuild -destination`. */
  build: (deviceId: string) => Step[];
  artifact: string;
  /** Metro serves the JS, so the suite runs one for the whole run. */
  metro: boolean;
  /** How the app's JS or Dart state restarts in place. The native playgrounds have none. */
  reload?: "metro" | "flutter";
  /** The Swift core keeps the socket open for the background time iOS grants, so a call made
   * right after the app leaves the foreground still succeeds. Android and Flutter close at once. */
  backgroundWindow: boolean;
  /** `<scheme>:///status` reaches the app's router. #227 exempts Android native, whose core
   * finishes on any link that isn't an Appduct link. */
  statusDeepLink: boolean;
  /** A release build with Appduct opted in, for `release-opt-in`. */
  release?: { build: Step[]; artifact: string };
};

export const TARGET_NAMES = ["expo-ios", "expo-android", "native-ios", "native-android", "flutter-ios", "flutter-android"] as const;
export type TargetName = (typeof TARGET_NAMES)[number];

const expo = path.join(repoRoot, "playground");
const native = path.join(repoRoot, "playground-native");
const flutter = path.join(repoRoot, "playground-flutter");

// `expo prebuild` writes ios/ and android/, which are not checked in; run it only when its output
// is missing, since it reruns `pod install` every time. A build can leave a bare android/app/build
// behind, so look for a file prebuild writes rather than the directory.
const prebuild = (platform: Platform, env?: Record<string, string>): Step[] =>
  existsSync(path.join(expo, platform === "ios" ? "ios/Podfile" : "android/gradlew")) && !env
    ? []
    : [{ cmd: "pnpm", args: ["exec", "expo", "prebuild", "--platform", platform, "--no-install"], env }];

const xcodebuild = (args: string[], deviceId: string, cwd?: string): Step => ({
  cmd: "xcodebuild",
  args: [...args, "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", `id=${deviceId}`, "-derivedDataPath", "build", "build"],
  cwd,
});

const targets: Record<TargetName, Target> = {
  "expo-ios": {
    name: "expo-ios",
    platform: "ios",
    dir: expo,
    appId: "com.aitwar.playground",
    scheme: "playground",
    build: (deviceId) => [
      ...prebuild("ios"),
      { cmd: "pod", args: ["install"], cwd: "ios", env: { LANG: "en_US.UTF-8" } },
      // Xcode 27 refuses pods that still declare iOS 9 (SDWebImage). A build setting given on the
      // command line overrides every target, so the generated Podfile stays untouched.
      xcodebuild(["-workspace", "playground.xcworkspace", "-scheme", "playground", "IPHONEOS_DEPLOYMENT_TARGET=15.1"], deviceId, "ios"),
    ],
    artifact: "ios/build/Build/Products/Debug-iphonesimulator/playground.app",
    metro: true,
    reload: "metro",
    backgroundWindow: true,
    statusDeepLink: true,
  },
  "expo-android": {
    name: "expo-android",
    platform: "android",
    dir: expo,
    appId: "com.aitwar.playground",
    scheme: "playground",
    build: () => [...prebuild("android"), { cmd: "./gradlew", args: [":app:assembleDebug"], cwd: "android" }],
    artifact: "android/app/build/outputs/apk/debug/app-debug.apk",
    metro: true,
    reload: "metro",
    backgroundWindow: false,
    statusDeepLink: true,
    release: {
      build: [
        ...prebuild("android", { APPDUCT_ENABLED: "1" }),
        { cmd: "./gradlew", args: [":app:assembleRelease"], cwd: "android", env: { APPDUCT_ENABLED: "1" } },
      ],
      artifact: "android/app/build/outputs/apk/release/app-release.apk",
    },
  },
  "native-ios": {
    name: "native-ios",
    platform: "ios",
    dir: native,
    appId: "com.callstack.appduct.playgroundnative",
    scheme: "appduct-native",
    build: (deviceId) => [
      { cmd: "xcodegen", args: ["generate"], cwd: "ios" },
      xcodebuild(["-project", "AppductPlayground.xcodeproj", "-scheme", "AppductPlayground", "CODE_SIGNING_ALLOWED=NO"], deviceId, "ios"),
    ],
    artifact: "ios/build/Build/Products/Debug-iphonesimulator/AppductPlayground.app",
    metro: false,
    backgroundWindow: true,
    statusDeepLink: true,
  },
  "native-android": {
    name: "native-android",
    platform: "android",
    dir: native,
    appId: "com.callstack.appduct.playground",
    scheme: "appduct-native",
    build: () => [{ cmd: "./gradlew", args: [":app:assembleDebug"], cwd: "android" }],
    artifact: "android/app/build/outputs/apk/debug/app-debug.apk",
    metro: false,
    backgroundWindow: false,
    statusDeepLink: false,
  },
  "flutter-ios": {
    name: "flutter-ios",
    platform: "ios",
    dir: flutter,
    appId: "com.callstack.appduct.playgroundFlutter",
    scheme: "appduct-flutter",
    build: () => [
      { cmd: "flutter", args: ["pub", "get"] },
      { cmd: "flutter", args: ["build", "ios", "--simulator", "--debug"] },
    ],
    artifact: "build/ios/iphonesimulator/Runner.app",
    metro: false,
    reload: "flutter",
    backgroundWindow: false,
    statusDeepLink: true,
  },
  "flutter-android": {
    name: "flutter-android",
    platform: "android",
    dir: flutter,
    appId: "com.callstack.appduct.playground_flutter",
    scheme: "appduct-flutter",
    build: () => [
      { cmd: "flutter", args: ["pub", "get"] },
      { cmd: "flutter", args: ["build", "apk", "--debug"] },
    ],
    artifact: "build/app/outputs/flutter-apk/app-debug.apk",
    metro: false,
    reload: "flutter",
    backgroundWindow: false,
    statusDeepLink: true,
    release: {
      build: [{ cmd: "flutter", args: ["build", "apk", "--release", "--dart-define=APPDUCT_ENABLED=true"] }],
      artifact: "build/app/outputs/flutter-apk/app-release.apk",
    },
  },
};

export const targetNamed = (name: string | undefined): Target => {
  if (!name || !(TARGET_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Set APPDUCT_E2E_TARGET to one of: ${TARGET_NAMES.join(", ")}. Got: ${name ?? "nothing"}.`);
  }
  return targets[name as TargetName];
};
