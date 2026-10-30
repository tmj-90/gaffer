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
    // The DOM tests boot the dashboard afresh per test case with a cache-busting
    // query (`import(app.js?t=…)`). Left to vite-node, every one of those is a
    // new module id, so the MAIN vitest process transforms the 800 KB bundle
    // again and keeps each result (code + source map) in its module graph for
    // the whole run: ~170 boots → ~2 GB → the run dies with a heap OOM on a
    // 7 GB macOS runner. app.js is plain ESM that needs no transform (and is
    // excluded from coverage), so hand it to Node's own loader in the worker:
    // the per-test instances then live and die with that test file's process.
    server: { deps: { external: [/\/src\/api\/web\/app\.js(\?|$)/] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/api/web/**"],
      // Coverage FLOOR (CI gate). Measured baseline clears these comfortably
      // (lines ~82 / branches ~85 / functions ~95 / statements ~82), so the floor
      // catches regressions without blocking today's suite. Ratchet up over time.
      thresholds: { lines: 83, functions: 94, branches: 85, statements: 83 },
    },
  },
});
