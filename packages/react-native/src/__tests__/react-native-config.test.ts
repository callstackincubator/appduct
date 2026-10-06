import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";

// `react-native.config.js` is a CommonJS helper at the package root, not a TS module under
// `src/` -- see `metro.test.ts` for the same pattern with `metro.js`. `createRequire` loads it
// without adding a `require` ambient declaration to this test file.
const require = createRequire(import.meta.url);

const rnConfig = require("../../react-native.config.js") as {
  __testables: {
    resolvePlatforms: () => unknown;
    devOnly: unknown;
    everyBuild: unknown;
    excluded: { android: null; ios: null };
  };
};

const { resolvePlatforms, devOnly, everyBuild, excluded } =
  rnConfig.__testables;

const ENV_VAR = "APPDUCT_ENABLED";

describe("react-native.config.js resolvePlatforms", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test("unset env: dev-only -- Debug configuration on iOS, no release; Android split lives in build.gradle", () => {
    delete process.env[ENV_VAR];
    expect(resolvePlatforms()).toStrictEqual(devOnly);
    expect(
      (devOnly as { android: { buildTypes?: string[] } }).android.buildTypes,
    ).toBeUndefined();
    expect(
      (devOnly as { ios: { configurations: string[] } }).ios.configurations,
    ).toStrictEqual(["Debug"]);
  });

  test("empty env: same as unset -- dev-only", () => {
    process.env[ENV_VAR] = "";
    expect(resolvePlatforms()).toStrictEqual(devOnly);
  });

  // An empty `configurations` is CocoaPods' "no restriction", i.e. link the pod into every
  // Xcode configuration. Naming ["Debug", "Release"] instead approximates "every build" by
  // spelling: a pipeline whose configuration is called `Staging` is left unlinked (and in a
  // project that has no `Release` configuration at all, CocoaPods hard-fails install over the
  // unknown whitelisted name). `APPDUCT_ENABLED=1` promises every build, so it has to widen by
  // lifting the restriction rather than by guessing which names a project might use.
  test.each(["1", "true", "TRUE"])(
    "%s: every build -- no iOS configuration restriction at all, so a custom-named configuration carries Appduct; Android unaffected (build.gradle reads the env var itself)",
    (value) => {
      process.env[ENV_VAR] = value;
      expect(resolvePlatforms()).toStrictEqual(everyBuild);
      expect(
        (everyBuild as { ios: { configurations: string[] } }).ios
          .configurations,
      ).toStrictEqual([]);
    },
  );

  test.each(["0", "false", "FALSE"])(
    "%s: excluded from every build",
    (value) => {
      process.env[ENV_VAR] = value;
      expect(resolvePlatforms()).toStrictEqual(excluded);
    },
  );

  test.each(["yes-please", "yes", "PIN"])(
    "%s: unparseable value falls back to dev-only, same as unset, rather than throwing or including in every build",
    (value) => {
      process.env[ENV_VAR] = value;
      expect(resolvePlatforms()).toStrictEqual(devOnly);
    },
  );
});
