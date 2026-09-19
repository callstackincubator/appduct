/**
 * Locates this package's root directory (the one holding `appduct`'s `package.json`) from
 * wherever this module happens to be evaluated.
 *
 * The published build is bundled (`scripts/bundle.mjs`), so a module's location on disk is not
 * its location in `src/`: this code may run from `src/…` under Vitest, from `dist/<entry>.js`, or
 * from a shared chunk at `dist/<name>-<hash>.js`. A fixed `join(here, "..")` cannot be right in
 * all three, so the root is found by walking up to the nearest `package.json` that names this
 * package — at most a couple of `stat`s, done once per process.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "appduct";

let cached: string | undefined;

export const getPackageRoot = (): string => {
  if (cached !== undefined) {
    return cached;
  }

  let dir = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const candidate = join(dir, "package.json");

    if (existsSync(candidate)) {
      let name: unknown;

      try {
        name = (JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown }).name;
      } catch {
        // Not ours (or not JSON): keep walking.
      }

      if (name === PACKAGE_NAME) {
        cached = dir;
        return dir;
      }
    }

    const parent = dirname(dir);

    if (parent === dir) {
      throw new Error(`Could not locate the "${PACKAGE_NAME}" package root above ${import.meta.url}.`);
    }

    dir = parent;
  }
};
