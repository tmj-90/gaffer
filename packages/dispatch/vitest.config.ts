import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Clears long-lived pollers/timeouts the web SPA (app.js) leaves running
    // after each DOM test, so a timer can't fire after JSDOM teardown (vitest 3
    // fails the run on that). See test/setup-timers.ts.
    setupFiles: ["test/setup-timers.ts"],
    // Audit writes are off by default in tests so the suite doesn't litter an
    // audit.jsonl beside the cwd DB. The dedicated audit tests opt back in by
    // pointing DISPATCH_AUDIT at a temp file and clearing this flag locally.
    env: { DISPATCH_AUDIT_OFF: "1" },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/api/web/**"],
      // Coverage FLOOR (CI gate). Measured baseline clears these comfortably
      // (lines ~82 / branches ~85 / functions ~95 / statements ~82), so the floor
      // catches regressions without blocking today's suite. Ratchet up over time.
      thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
    },
  },
});
