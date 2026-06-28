import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      // Coverage FLOOR (CI gate). Measured baseline clears these comfortably
      // (lines ~77 / branches ~82 / functions ~85 / statements ~77), so the floor
      // catches regressions without blocking today's suite. Ratchet up over time.
      thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
    },
  },
});
