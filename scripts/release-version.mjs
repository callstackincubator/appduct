#!/usr/bin/env node
/**
 * Prints the release version and fails unless the three npm packages and the Flutter package carry
 * the same, non-prerelease version (the Flutter package is its `pubspec.yaml` its podspec and its Gradle build).
 *
 * Usage: node scripts/release-version.mjs [--root <dir>] [--tag <vX.Y.Z>]
 *
 * With --tag, the version must also equal the tag minus its leading "v". Used by deploy.yaml.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const root = resolve(
  option("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
);
const tag = option("--tag");

const versions = new Map();
for (const name of ["shared", "appduct", "react-native"]) {
  const file = `packages/${name}/package.json`;
  versions.set(
    file,
    JSON.parse(readFileSync(join(root, file), "utf8")).version,
  );
}
const pubspec = "packages/flutter/pubspec.yaml";
const match = /^version:\s*(\S+)\s*$/m.exec(
  readFileSync(join(root, pubspec), "utf8"),
);
versions.set(pubspec, match?.[1]);
const podspec = "packages/flutter/darwin/appduct.podspec";
const pod = /^\s*s\.version\s*=\s*'([^']+)'/m.exec(
  readFileSync(join(root, podspec), "utf8"),
);
versions.set(podspec, pod?.[1]);
const gradle = "packages/flutter/android/build.gradle.kts";
const gradleVersion = /^version\s*=\s*"([^"]+)"/m.exec(
  readFileSync(join(root, gradle), "utf8"),
);
versions.set(gradle, gradleVersion?.[1]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [version] = versions.values();
if (new Set(versions.values()).size !== 1) {
  fail(
    `Package versions differ:\n${[...versions].map(([file, v]) => `  ${file}: ${v}`).join("\n")}`,
  );
}
if (version.includes("-"))
  fail(`Prerelease versions are not publishable: ${version}`);
if (tag !== undefined && tag !== `v${version}`) {
  fail(`Release tag ${tag} does not match the package version v${version}`);
}
process.stdout.write(version);
