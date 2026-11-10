import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Limits sized for a loaded CI runner. Tests that spawn the built CLI several times,
    // and temp-dir cleanup hooks, have stalled past vitest's defaults (5 s a test, 10 s a
    // hook) there while taking under a second on a quiet machine. A hung test still fails.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      // Coverage FLOOR (CI gate). Measured baseline clears these comfortably
      // (lines ~84 / branches ~78 / functions ~90 / statements ~84), so the floor
      // catches regressions without blocking today's suite. Ratchet up over time.
      thresholds: { lines: 84, functions: 90, branches: 77, statements: 84 },
    },
  },
});
