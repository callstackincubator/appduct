import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const playgroundPath = (path: string): string =>
  fileURLToPath(new URL(`../../../../playground/${path}`, import.meta.url));

describe("playground Appduct config", () => {
  test("records the scheme and app ids app.json declares in its project config", async () => {
    const [projectConfig, appConfig] = await Promise.all([
      readFile(playgroundPath(".appduct/config.json"), "utf8"),
      readFile(playgroundPath("app.json"), "utf8"),
    ]);

    const { expo } = JSON.parse(appConfig);

    // `link --open android` must work without `--app-id`, and against the app this config builds.
    expect(JSON.parse(projectConfig)).toEqual({
      scheme: expo.scheme,
      appId: { ios: expo.ios.bundleIdentifier, android: expo.android.package },
    });
  });

  test("takes the zero-config trust path: no embedded pins", async () => {
    const { expo } = JSON.parse(await readFile(playgroundPath("app.json"), "utf8"));
    const pluginOptions = expo.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === "@appduct/react-native",
    )[1];

    expect(pluginOptions.cliPins).toBeUndefined();
    expect(pluginOptions.trust).toBeUndefined();
  });
});
