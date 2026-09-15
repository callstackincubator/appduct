#!/usr/bin/env node
/**
 * Vendors the framework-free native core (`packages/native`,
 * docs/tasks/14-native-core-extraction.md) into this package at build/publish time, so
 * `@appduct/react-native` never depends on `packages/native` being separately published to
 * CocoaPods trunk or Maven Central -- that is deferred to Phase 3, and this package's own releases
 * should not be blocked on it.
 *
 * Copies:
 *   - packages/native/ios/Sources/AppductCore/Real/*.swift -> ios/Core/
 *     Only the `Real/` branch: `Appduct.podspec` always compiles with `-DAPPDUCT_ENABLED` set
 *     (autolinking, not this file's contents, decides whether the pod links at all -- see
 *     `react-native.config.js`), so the RN pod never needs the `Stub/` branch.
 *   - packages/native/android/core/src/main/java/** (+ consumer-rules.pro) -> android/core/
 *   - packages/native/android/core-noop/src/main/java/** -> android/core-noop/
 *
 * Run via this package's `build`/`prepack` scripts (see package.json) -- Turbo runs `build` before
 * `test` and before CI's `expo prebuild`, and `prepack` covers `npm pack`/`npm publish` outside a
 * Turbo run. Safe to re-run: each destination directory is fully replaced, never merged, so a file
 * removed upstream cannot linger as a stale copy.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rnRoot = join(here, "..");
const nativeRoot = join(rnRoot, "..", "native");

/** Replaces `destDir` with a fresh copy of `srcDir`'s contents (only files matching `filter`, if
 * given). `srcDir` must exist -- a missing native-core source is a build-breaking error, not
 * something to silently skip. */
function syncDir(srcDir, destDir, { filter } = {}) {
  if (!existsSync(srcDir)) {
    throw new Error(`sync-native-core: expected source directory does not exist: ${srcDir}`);
  }

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(srcDir, destDir, { recursive: true, filter });
  console.log(`[sync-native-core] ${srcDir} -> ${destDir}`);
}

function syncFile(srcFile, destFile) {
  if (!existsSync(srcFile)) {
    throw new Error(`sync-native-core: expected source file does not exist: ${srcFile}`);
  }

  mkdirSync(dirname(destFile), { recursive: true });
  cpSync(srcFile, destFile);
  console.log(`[sync-native-core] ${srcFile} -> ${destFile}`);
}

// The app-facing entry points of the native core (issue #48 phase 3) are deliberately NOT vendored
// into the React Native package: the RN bridge owns its own `AppductClient`, and a second client
// behind `Appduct.shared` / the `Appduct` object would compete with it for the one
// process-memory resume lease. Android's init `ContentProvider` and deep-link trampoline `Activity`
// exist only for plain apps too (RN routes links through `Linking`) and are never declared in the
// RN module's manifest. Everything else -- the client, transport, codecs, marker -- is shared.
const IOS_FACADE_FILES = new Set(["AppductAPI.swift"]);
const ANDROID_FACADE_FILES = new Set([
  "Appduct.kt",
  "AppductInitProvider.kt",
  "AppductLinkActivity.kt",
]);

const excludeFacade = (facadeFiles) => (src) => !facadeFiles.has(src.split("/").pop());

function main() {
  // --- iOS: Real/ only, minus the plain-app facade ---
  syncDir(
    join(nativeRoot, "ios", "Sources", "AppductCore", "Real"),
    join(rnRoot, "ios", "Core"),
    { filter: excludeFacade(IOS_FACADE_FILES) },
  );

  // --- Android: core ---
  const coreJavaSrc = join(
    nativeRoot,
    "android",
    "core",
    "src",
    "main",
    "java",
  );
  syncDir(coreJavaSrc, join(rnRoot, "android", "core"), { filter: excludeFacade(ANDROID_FACADE_FILES) });
  syncFile(
    join(nativeRoot, "android", "core", "consumer-rules.pro"),
    join(rnRoot, "android", "core", "consumer-rules.pro"),
  );

  // --- Android: core-noop ---
  const coreNoopJavaSrc = join(
    nativeRoot,
    "android",
    "core-noop",
    "src",
    "main",
    "java",
  );
  syncDir(coreNoopJavaSrc, join(rnRoot, "android", "core-noop"), { filter: excludeFacade(ANDROID_FACADE_FILES) });

  if (readdirSync(join(rnRoot, "ios", "Core")).length === 0) {
    throw new Error("sync-native-core: ios/Core ended up empty -- packages/native/ios moved?");
  }
}

main();
