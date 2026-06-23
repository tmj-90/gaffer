import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      // TODO: ratchet these up once a real baseline is measured. Left
      // unset (informational only) so `test:coverage` reports without
      // failing CI on day one.
      // thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
    },
  },
});
