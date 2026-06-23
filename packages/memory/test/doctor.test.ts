/**
 * `memory doctor` — health check. Drives runDoctor against a temp DB
 * via MEMORY_DB and asserts the check levels (ok/warn/fail) and exit
 * code for the states that matter: fresh-but-uninitialised, initialised,
 * and the restricted-MCP / audit-off env warnings.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "../src/db/index.js";
import { renderDoctor, runDoctor } from "../src/cli/doctor.js";
import { VERSION } from "../src/version.js";

let dir: string;
const ENV = [
  "MEMORY_DB",
  "MEMORY_AUDIT_LOG",
  "MEMORY_ALLOW_RESTRICTED_MCP",
  "MEMORY_AUDIT_OFF",
  "MEMORY_NO_TELEMETRY",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "memory-doctor-"));
  process.env["MEMORY_DB"] = join(dir, "lore.db");
  process.env["MEMORY_AUDIT_LOG"] = join(dir, "audit.jsonl");
  delete process.env["MEMORY_ALLOW_RESTRICTED_MCP"];
  delete process.env["MEMORY_AUDIT_OFF"];
  delete process.env["MEMORY_NO_TELEMETRY"];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function labels(checks: { label: string }[]): string {
  return checks.map((c) => c.label).join("\n");
}

describe("runDoctor", () => {
  it("warns (but does not fail) when the DB doesn't exist yet", async () => {
    const { exitCode, checks } = await runDoctor();
    expect(exitCode).toBe(0); // missing DB is a warn, not a fail
    expect(labels(checks)).toContain("DB missing");
  });

  it("reports a healthy, initialised DB with exit 0 and FTS ready", async () => {
    openDb(process.env["MEMORY_DB"]).close(); // init
    const { exitCode, checks } = await runDoctor();
    expect(exitCode).toBe(0);
    const text = labels(checks);
    expect(text).toContain("DB exists");
    expect(text).toContain("FTS index: ready");
    expect(text).toContain("Lore table: 0 record(s)");
    expect(text).toContain(`Version: ${VERSION}`);
  });

  it("warns when the restricted-MCP gate is enabled", async () => {
    openDb(process.env["MEMORY_DB"]).close();
    process.env["MEMORY_ALLOW_RESTRICTED_MCP"] = "1";
    const { checks } = await runDoctor();
    const c = checks.find((x) => x.label.includes("Restricted MCP access"));
    expect(c?.level).toBe("warn");
    expect(c?.label).toContain("ENABLED");
  });

  it("warns when audit logging is disabled", async () => {
    openDb(process.env["MEMORY_DB"]).close();
    process.env["MEMORY_AUDIT_OFF"] = "1";
    const { checks } = await runDoctor();
    expect(labels(checks)).toContain("Audit disabled");
  });
});

describe("renderDoctor", () => {
  it("renders glyphs and a readiness footer", async () => {
    openDb(process.env["MEMORY_DB"]).close();
    const { checks } = await runDoctor();
    const out = renderDoctor(checks);
    expect(out).toContain("memory doctor");
    expect(out).toMatch(/Ready/);
    expect(out).toContain("✓");
  });

  it("says 'Not ready' when a check failed", () => {
    const out = renderDoctor([{ label: "FTS index: MISSING", level: "fail" }]);
    expect(out).toContain("✗");
    expect(out).toContain("Not ready");
  });
});
