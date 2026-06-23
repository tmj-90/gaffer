import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
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
      // TODO: ratchet these up once a real baseline is measured. Left
      // unset (informational only) so `test:coverage` reports without
      // failing CI on day one.
      // thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
    },
  },
});
