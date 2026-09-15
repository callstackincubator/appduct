/**
 * `appduct doctor` (docs/tasks/08-appduct-doctor.md): the artifact-level replacement for the
 * runtime `debuggable`/`#if DEBUG` gate removed elsewhere in opt-in hardening. Given a built
 * `.app`/`.ipa`/`.apk`/`.aab`, decide whether Appduct's native code actually shipped inside it —
 * not whether the config that's supposed to have produced it looks right.
 *
 * The one property everything here is built around: **never report "absent" because a tool was
 * missing or the artifact couldn't be read.** That failure mode is strictly worse than not having
 * this check at all, because it turns a release gate into a rubber stamp that always exits 0 once
 * `unzip` happens to be missing from a runner's image. Every path that can't produce a truthful
 * answer throws {@link inspectionError} — a distinct, non-zero exit — instead of falling through to
 * `present: false`.
 *
 * Detection strategy, and why no single signal is authoritative on either platform:
 *
 * - iOS: `present` is decided by real-code-only symbols alone, exactly like Android below —
 *   `AppductCoreMarker` (`packages/native/ios/Sources/AppductCore/Real/AppductCoreMarker.swift`,
 *   docs/tasks/14-native-core-extraction.md), an `@objc` class compiled only into the real
 *   implementation, never into the SwiftPM package's `Stub/` branch, so its presence cannot be
 *   confused with a stub build. `RCTNativeAppduct` (`RCT_EXPORT_MODULE`, see
 *   `packages/react-native/ios/RCTNativeAppduct.mm`) is kept as a second real-code signal for
 *   artifacts built before the marker existed. Both are Objective-C runtime metadata — they live in
 *   `__objc_classname`/`__objc_data`, and `strip`/release optimization leaves them alone because
 *   removing them would break `+[NSObject class]`-based dispatch. (A build that dead-strips the whole
 *   translation unit for lack of `-ObjC`/`-force_load` could still drop them — these signals assume
 *   the module actually links into the binary, which is the thing being checked in the first
 *   place.) The plugin-authored `Info.plist` keys
 *   (`AppductCliPins`/`AppductTrust`/`AppductAllowPrivateLanOnly`, docs/tasks/00-overview.md
 *   "Native config keys the plugin writes") are reported as a corroborating signal only and can no
 *   longer flip `present` to `true` on their own — an app author can write these keys by hand (or a
 *   future stub could ship them) without the real implementation being present, exactly the reason
 *   the Android signals below aren't all treated as equally authoritative either.
 * - Android: the primary signal is `AppductNativeMarker`
 *   (`packages/native/android/core/src/main/java/com/callstackincubator/appduct/AppductNativeMarker.kt`,
 *   vendored into `@appduct/react-native` at `android/core/src/main/java/...`), a marker class with no
 *   other purpose. Its fully-qualified name is kept unminified and unremoved by a `-keep` rule in
 *   `consumer-rules.pro` (same vendoring path), shipped to every consuming app via `consumerProguardFiles`
 *   (see `../build.gradle`) — R8 applies it regardless of whether the app used the Expo config plugin or
 *   bare-RN autolinking, and regardless of whether the app authored any keep rules of its own
 *   (docs/tasks/10-android-detection-keep-rule.md). This is the only Android signal guaranteed to survive
 *   minification in every supported consumer setup.
 *
 *   Two more signals are kept as fallbacks for artifacts built before this marker existed: the
 *   `com.callstackincubator.appduct` package string in the dex string pool (survives as long as
 *   R8/ProGuard minification+obfuscation isn't applied to it — an aggressive release config with no keep
 *   rule for this package can rename it away) and the plugin-authored meta-data key names in
 *   `AndroidManifest.xml` (`com.callstackincubator.appduct.CLI_PINS`/`TRUST`/`ALLOW_PRIVATE_LAN_ONLY`):
 *   those are XML attribute string values written by the config plugin at prebuild time, not compiled
 *   identifiers, so R8 never touches them, but they only exist at all if the config plugin ran. Both
 *   encodings AAPT2 can choose for the manifest string pool (UTF-8 or UTF-16LE) are checked.
 *
 * On iOS, `present` is an OR across the two real-code-only signals (`ios-core-marker-symbol`,
 * `ios-objc-class-symbol`) — specifically so a stripped binary that dropped one literal doesn't flip
 * a real inclusion to "absent" just because one check missed — but the Info.plist keys signal cannot
 * flip it to `true` by itself, matching Android's marker-only rule below (a stub that ships the same
 * plist keys without the real implementation is exactly the failure mode this guards against, even
 * though no such stub exists yet as of Phase 1 of docs/tasks/14-native-core-extraction.md).
 *
 * On Android, `present` is decided by the keep-rule marker alone, not an OR across all three
 * signals. The other two are reported in `signals` for corroboration/debugging but cannot flip
 * `present` to `true` on their own: `android/build.gradle`'s `APPDUCT_ENABLED`-gated vendored
 * source-directory swap (`core` vs `core-noop`, docs/tasks/14-native-core-extraction.md; previously a
 * `src/debug`/`src/release-stub` swap, see docs/tasks/00-overview.md's "Revisited
 * post-implementation") compiles a genuine no-op `AppductPackage` into a default release build at
 * the *same* fully-qualified name the real one uses (required so the shared, non-variant-aware
 * `PackageList.java` still resolves), and the config plugin writes the same manifest meta-data
 * regardless of variant (Expo mods edit the single merged manifest, not a per-variant one). Both
 * fallback signals therefore fire on that harmless stub exactly as they would on the real module, and
 * can no longer prove inclusion by themselves.
 *
 * `appduct doctor` is strictly better than the runtime check it replaces (docs/tasks/00-overview.md
 * "What we give up, deliberately"). The keep-rule marker closes the previously-documented gap where a
 * bare-RN app with no config plugin and no keep rule could evade both older Android signals under R8
 * minification (docs/tasks/10-android-detection-keep-rule.md) — that gap applied to builds produced before
 * this library shipped the marker/keep rule; an app that pins an older `@appduct/react-native` version
 * still lacks it, and doctor cannot detect inclusion on such a build at all.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { inspectionError, usageError } from "./errors.js";

export type ArtifactPlatform = "ios" | "android";
export type ArtifactFormat = "app" | "ipa" | "apk" | "aab";

export type DetectionSignal =
  | "ios-core-marker-symbol"
  | "ios-objc-class-symbol"
  | "ios-info-plist-keys"
  | "android-keep-rule-marker"
  | "android-dex-package-symbol"
  | "android-manifest-meta-data-keys";

export type ArtifactInspection = {
  platform: ArtifactPlatform;
  format: ArtifactFormat;
  present: boolean;
  /** Which specific markers matched — empty when `present` is `false`. Surfaced for auditability,
   * not just a boolean: a report that says *why* is checkable by a human without re-running the
   * tool with more verbosity. */
  signals: DetectionSignal[];
};

// --- markers ---

// `@objc(AppductCoreMarker)` -- packages/native/ios/Sources/AppductCore/Real/AppductCoreMarker.swift.
// Compiled only into the real implementation, never the SwiftPM package's Stub/ branch, so unlike
// the Info.plist keys below it cannot exist without the real implementation also being present.
const IOS_CORE_MARKER = "AppductCoreMarker";
const IOS_OBJC_CLASS_MARKER = "RCTNativeAppduct";
const IOS_INFO_PLIST_KEY_MARKERS = ["AppductCliPins", "AppductTrust", "AppductAllowPrivateLanOnly"];

// Fully-qualified name of `AppductNativeMarker`
// (packages/native/android/core/src/main/java/com/callstackincubator/appduct/AppductNativeMarker.kt,
// vendored into packages/react-native/android/core/src/main/java/com/callstackincubator/appduct/AppductNativeMarker.kt
// by scripts/sync-native-core.mjs), kept unminified by packages/native/android/core/consumer-rules.pro
// (vendored to packages/react-native/android/core/consumer-rules.pro the same way). Checked as a dex
// type descriptor (`Lcom/.../AppductNativeMarker;`) — see detectAndroidSignals — which is how the
// class's fully-qualified name is actually encoded in classes.dex.
const ANDROID_KEEP_RULE_MARKER_CLASS = "com/callstackincubator/appduct/AppductNativeMarker";

const ANDROID_DEX_PACKAGE_MARKERS = ["com/callstackincubator/appduct", "com.callstackincubator.appduct"];
const ANDROID_MANIFEST_KEY_MARKER = "com.callstackincubator.appduct.";

const bufferIncludesAscii = (haystack: Buffer, needle: string): boolean => {
  return haystack.includes(Buffer.from(needle, "utf8"));
};

const bufferIncludesUtf16le = (haystack: Buffer, needle: string): boolean => {
  return haystack.includes(Buffer.from(needle, "utf16le"));
};

// --- process execution seam (mirrors src/cli/open-target.ts's ExecFn, but with Buffer stdout:
// archive contents are binary and must not round-trip through a lossy utf8 string conversion) ---

export type ExecBufferResult = {
  stdout: Buffer;
  stderr: Buffer;
};

/** Injectable subprocess seam; tests stub this to simulate a missing `unzip` (ENOENT) or a
 * corrupt-archive failure without needing either condition to be true on the machine running the
 * tests. */
export type ExecBufferFn = (command: string, args: string[]) => Promise<ExecBufferResult>;

/** Real subprocess execution via `execFile`, buffered as raw bytes. `maxBuffer` is generous (an
 * artifact's full decompressed contents are read into memory at once — see {@link readZipEntries})
 * since real `.ipa`/`.apk`/`.aab` files can run into the hundreds of MB. */
export const defaultExecBuffer: ExecBufferFn = (command, args) => {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
};

const TOOL_INSTALL_HINT: Record<string, string> = {
  unzip: "Info-ZIP's unzip (present by default on macOS and most Linux CI images)",
};

/** Runs an external tool, translating "not found on PATH" and "ran but failed" into a single
 * {@link inspectionError} class — both mean the same thing to a caller: this artifact could not be
 * inspected, so no presence/absence claim can be trusted. Never resolves to a result that looks
 * like a clean "not present" answer. */
const runToolOrInspectionError = async (
  exec: ExecBufferFn,
  command: string,
  args: string[],
  context: string,
): Promise<Buffer> => {
  try {
    const result = await exec(command, args);
    return result.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer };

    if (err.code === "ENOENT") {
      throw inspectionError(
        `"${command}" was not found on PATH; cannot inspect ${context}. Install ${
          TOOL_INSTALL_HINT[command] ?? command
        } and retry.`,
      );
    }

    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw inspectionError(
        `"${command} ${args.join(" ")}" produced more output than this command will buffer while ` +
          `inspecting ${context}. The artifact is unusually large, not necessarily corrupt — this is ` +
          `a tooling limit, not a presence/absence answer.`,
      );
    }

    const stderr = err.stderr ? err.stderr.toString("utf8").trim() : "";
    throw inspectionError(
      `"${command} ${args.join(" ")}" failed while inspecting ${context}${
        stderr ? `: ${stderr}` : `: ${err.message}`
      }. The artifact may be corrupt or not a valid archive.`,
    );
  }
};

/** The container-shape check every zip-format artifact must pass before its contents are trusted
 * for a presence/absence answer (see {@link readZipEntries}): an empty, wrong-file-renamed, or
 * otherwise not-actually-that-kind-of-artifact zip must never silently read back as "no signals
 * found" — it isn't an answer, it's evidence the input wasn't what its extension claimed. */
const EXPECTED_ENTRY_PATTERN: Record<"ipa" | "apk" | "aab", RegExp> = {
  ipa: /\.app\//iu,
  apk: /(^|\/)AndroidManifest\.xml$/u,
  aab: /(^|\/)AndroidManifest\.xml$/u,
};

const assertExpectedZipShape = (
  format: "ipa" | "apk" | "aab",
  entries: string[],
  context: string,
): void => {
  if (entries.length === 0) {
    throw inspectionError(`${context} contains no entries — it is not a valid archive.`);
  }

  if (!entries.some((entry) => EXPECTED_ENTRY_PATTERN[format].test(entry))) {
    throw inspectionError(
      `${context} does not look like a valid .${format}: none of its ${entries.length} entries match ` +
        `the expected ${format === "ipa" ? '"*.app/" bundle' : '"AndroidManifest.xml"'} shape. Refusing ` +
        `to report absence for an artifact that may simply be the wrong file.`,
    );
  }
};

/** Lists a zip archive's entry names via `unzip -Z1` (zipinfo mode: one path per line, nothing
 * else) — used only for the {@link assertExpectedZipShape} sanity check, not for detection itself. */
const listZipEntries = async (exec: ExecBufferFn, archivePath: string, context: string): Promise<string[]> => {
  const stdout = await runToolOrInspectionError(exec, "unzip", ["-Z1", archivePath], context);

  return stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

/** Streams every entry of a zip-format archive (`.ipa`/`.apk`/`.aab` are all zip containers)
 * decompressed and concatenated to one buffer, via `unzip -p`. Deliberately does not attempt to
 * enumerate entries and extract selectively first — a single whole-archive pass is simpler, cannot
 * miss a signal hiding in an unexpected internal path (embedded framework, AAB's `base/dex/`
 * nesting, ...), and correctness matters far more than the marginal speed of a narrower read for a
 * command that runs once per release. Validates the archive actually has the expected internal
 * shape first ({@link assertExpectedZipShape}) so an empty or mislabeled zip can't read back as a
 * clean "no signals found" instead of the "this wasn't a real artifact" it actually is. */
const readZipEntries = async (
  exec: ExecBufferFn,
  archivePath: string,
  format: "ipa" | "apk" | "aab",
  context: string,
): Promise<Buffer> => {
  const entries = await listZipEntries(exec, archivePath, context);
  assertExpectedZipShape(format, entries, context);

  return runToolOrInspectionError(exec, "unzip", ["-p", archivePath], context);
};

/** Recursively reads every regular file under a `.app` bundle directory into one concatenated
 * buffer. Symlinks are skipped (never followed) to avoid loops; `.app` bundles don't legitimately
 * need them for this check. */
const readAppDirectory = async (appDirPath: string, context: string): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw inspectionError(
        `Could not read "${dir}" while inspecting ${context}: ${(error as Error).message}.`,
      );
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (entry.isFile()) {
        try {
          chunks.push(await readFile(entryPath));
        } catch (error) {
          throw inspectionError(
            `Could not read "${entryPath}" while inspecting ${context}: ${(error as Error).message}.`,
          );
        }
      }
    }
  };

  await walk(appDirPath);
  return Buffer.concat(chunks);
};

// --- format resolution ---

const resolveFormat = (artifactPath: string): { platform: ArtifactPlatform; format: ArtifactFormat } => {
  const extension = path.extname(artifactPath).toLowerCase();

  switch (extension) {
    case ".app":
      return { platform: "ios", format: "app" };
    case ".ipa":
      return { platform: "ios", format: "ipa" };
    case ".apk":
      return { platform: "android", format: "apk" };
    case ".aab":
      return { platform: "android", format: "aab" };
    default:
      throw usageError(
        `Unrecognized artifact extension "${extension || artifactPath}". Expected one of: .app, .ipa, .apk, .aab.`,
      );
  }
};

// --- signal detection ---

const detectIosSignals = (bytes: Buffer): DetectionSignal[] => {
  const signals: DetectionSignal[] = [];

  // Primary signal: checked first because, unlike the Info.plist keys below, it cannot exist
  // without the real implementation (see the file-level doc comment).
  if (bufferIncludesAscii(bytes, IOS_CORE_MARKER)) {
    signals.push("ios-core-marker-symbol");
  }

  if (bufferIncludesAscii(bytes, IOS_OBJC_CLASS_MARKER)) {
    signals.push("ios-objc-class-symbol");
  }

  if (IOS_INFO_PLIST_KEY_MARKERS.some((marker) => bufferIncludesAscii(bytes, marker))) {
    signals.push("ios-info-plist-keys");
  }

  return signals;
};

const detectAndroidSignals = (bytes: Buffer): DetectionSignal[] => {
  const signals: DetectionSignal[] = [];

  // Primary signal: checked first because it's the only one guaranteed to survive R8 minification
  // in every supported consumer setup (see the file-level doc comment). Matched as a dex type
  // descriptor (`L` + fully-qualified-name-with-slashes + `;`) since that's the actual encoding of
  // a class name inside classes.dex, not just a loose substring check.
  if (bufferIncludesAscii(bytes, `L${ANDROID_KEEP_RULE_MARKER_CLASS};`)) {
    signals.push("android-keep-rule-marker");
  }

  if (ANDROID_DEX_PACKAGE_MARKERS.some((marker) => bufferIncludesAscii(bytes, marker))) {
    signals.push("android-dex-package-symbol");
  }

  if (
    bufferIncludesAscii(bytes, ANDROID_MANIFEST_KEY_MARKER) ||
    bufferIncludesUtf16le(bytes, ANDROID_MANIFEST_KEY_MARKER)
  ) {
    signals.push("android-manifest-meta-data-keys");
  }

  return signals;
};

// --- public entry point ---

export type InspectArtifactOptions = {
  exec?: ExecBufferFn;
};

/** Inspects a built artifact for Appduct's native inclusion. Throws {@link usageError} for an
 * unrecognized path/extension (a CLI-usage mistake) and {@link inspectionError} for anything that
 * prevents a truthful presence/absence answer (missing tool, unreadable/corrupt artifact) — it
 * never resolves successfully with a guessed or default answer. */
export const inspectArtifact = async (
  artifactPath: string,
  options: InspectArtifactOptions = {},
): Promise<ArtifactInspection> => {
  const exec = options.exec ?? defaultExecBuffer;
  const { platform, format } = resolveFormat(artifactPath);
  const context = `"${artifactPath}"`;

  let stats;

  try {
    stats = await stat(artifactPath);
  } catch (error) {
    throw inspectionError(`Artifact not found at ${context}: ${(error as Error).message}.`);
  }

  let bytes: Buffer;

  if (format === "app") {
    if (!stats.isDirectory()) {
      throw inspectionError(`Expected ${context} (a ".app" bundle) to be a directory.`);
    }

    bytes = await readAppDirectory(artifactPath, context);
  } else {
    if (!stats.isFile()) {
      throw inspectionError(`Expected ${context} to be a file.`);
    }

    bytes = await readZipEntries(exec, artifactPath, format, context);
  }

  const signals = platform === "ios" ? detectIosSignals(bytes) : detectAndroidSignals(bytes);

  // Android: only the keep-rule marker proves inclusion (see the file-level doc comment) -- the
  // other two Android signals are reported but can't flip `present` on their own. iOS mirrors
  // this: only the two real-code-only symbols prove inclusion (OR'd together so a stripped binary
  // that dropped one doesn't read as absent) -- the Info.plist keys are corroborating only and
  // can't flip `present` on their own either.
  const present =
    platform === "android"
      ? signals.includes("android-keep-rule-marker")
      : signals.includes("ios-core-marker-symbol") || signals.includes("ios-objc-class-symbol");

  return {
    platform,
    format,
    present,
    signals,
  };
};
