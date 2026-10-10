import { defineConfig } from "vitest/config";

// Unit and integration files run in parallel. The e2e files (real daemons, browsers and bundlers,
// wall-clock timeouts) run after them, two at a time, so they never compete with the unit files
// for CPU and only lightly with each other.
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
        test: { name: "e2e", include: E2E, maxWorkers: 2, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
