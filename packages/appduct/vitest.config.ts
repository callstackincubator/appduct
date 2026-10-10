import { defineConfig } from "vitest/config";

// Unit and integration files run in parallel. The e2e files (real daemons, browsers and bundlers,
// wall-clock timeouts) flake under that CPU contention, so they run one at a time, after the rest.
const E2E = ["src/__tests__/e2e/**/*.test.ts", "src/__tests__/**/*.e2e.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/__tests__/**/*.test.ts"], exclude: E2E, sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: { name: "e2e", include: E2E, fileParallelism: false, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
