import { defineConfig } from "vitest/config";

// One device, one app: every case drives the same simulator or emulator, so files run one at a
// time and nothing is retried. A failure that passes on a rerun is a flake to report, not hide.
export default defineConfig({
  test: {
    include: ["cases/*.device.test.ts"],
    globalSetup: ["src/global-setup.ts"],
    fileParallelism: false,
    retry: 0,
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
