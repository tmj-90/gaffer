import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ScriptedCommandRunner,
  FakeCommandRunner,
  type CommandRunner,
} from "../src/adapters/commandRunner.js";
import { EventLog } from "../src/events/eventLog.js";
import { runIdleTypeQualityLoop } from "../src/loops/idleTypeQuality.js";
import { runIdleTechDebtLoop } from "../src/loops/idleTechDebt.js";
import { runIdleSecurityHotspotLoop } from "../src/loops/idleSecurityHotspot.js";
import { createTscOracle } from "../src/loops/oracles/tscOracle.js";
import { createEslintOracle } from "../src/loops/oracles/eslintOracle.js";
import { createDeadCodeOracle } from "../src/loops/oracles/deadCodeOracle.js";
import { createSecurityOracle } from "../src/loops/oracles/securityOracle.js";
import type { OracleSet } from "../src/loops/idleLoop.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";
import { RepoRegistry } from "../src/index.js";
import { crewConfigSchema, type CrewConfig } from "../src/config/schema.js";

function tempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Install a fake local binary so resolveBinary treats the tool as present. */
function installLocalBin(repo: string, name: string): void {
  const dir = join(repo, "node_modules", ".bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function configForRepo(path: string): CrewConfig {
  const config = crewConfigSchema.parse({
    factory: { name: "test-factory", mode: "local_strict" },
    repos: [{ id: "demo", name: "demo", path, stack: "typescript", package_manager: "pnpm" }],
  });
  config.loops.idle_type_quality.enabled = true;
  config.loops.idle_tech_debt.enabled = true;
  config.loops.idle_security_hotspot.enabled = true;
  return config;
}

function deps(
  config: CrewConfig,
  wg: FakeDispatchClient,
  runner: CommandRunner = new FakeCommandRunner({ stdout: "", exitCode: 0 }),
  oracles?: OracleSet,
) {
  return {
    config,
    repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
    dispatch: wg,
    runner,
    events: new EventLog(new TestClock()),
    clock: new TestClock(),
    ...(oracles ? { oracles } : {}),
  };
}

// ── type-quality: tsc oracle ──────────────────────────────────────────────────

describe("type-quality loop with tsc oracle", () => {
  it("drafts from tsc diagnostics when the oracle is available, logging path=oracle", () => {
    const repo = tempRepo("orcl-typ-");
    installLocalBin(repo, "tsc");
    // The repo also has a heuristic signal — but the oracle must win.
    writeFileSync(join(repo, "thing.ts"), `const a = value as Widget;\n`);
    const diag = "src/thing.ts(1,7): error TS2304: Cannot find name 'value'.";
    const runner = new ScriptedCommandRunner([
      { match: (c) => c.includes("tsc"), result: { stdout: diag, exitCode: 2 } },
    ]);
    const wg = new FakeDispatchClient();
    const d = deps(configForRepo(repo), wg, runner, { tsc: createTscOracle(runner) });

    const outcome = runIdleTypeQualityLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    // The drafted ticket carries the precise tsc finding, not the heuristic.
    expect(ticket.ticket.description).toMatch(/TS2304/);
    expect(ticket.ticket.description).toMatch(/tsc oracle/);
    expect(ticket.ticket.description).toMatch(/no code was changed/i);
    // Path was logged as oracle.
    const scanned = d.events.events.find((e) => e.type === "type_quality_scanned");
    expect(scanned!.payload).toMatchObject({ path: "oracle", oracle: "tsc" });
  });

  it("falls back to the heuristic when the tsc tool is absent, logging path=heuristic", () => {
    const repo = tempRepo("orcl-typ-fb-");
    // No local tsc bin installed → oracle resolves nothing → unavailable.
    writeFileSync(join(repo, "thing.ts"), `const a = value as Widget;\n`);
    const wg = new FakeDispatchClient();
    const d = deps(configForRepo(repo), wg, new FakeCommandRunner({ stdout: "", exitCode: 0 }), {
      tsc: createTscOracle(new FakeCommandRunner({ stdout: "", exitCode: 0 }), "/nonexistent/tsc"),
    });

    const outcome = runIdleTypeQualityLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    // Heuristic summary names the typescript-conventions skill (the grep path).
    expect(ticket.ticket.description).toMatch(/typescript-conventions/);
    expect(d.events.types()).toContain("type_quality_oracle_unavailable");
    const scanned = d.events.events.find((e) => e.type === "type_quality_scanned");
    expect(scanned!.payload).toMatchObject({ path: "heuristic" });
  });

  it("dedups identical oracle findings across ticks (one draft only)", () => {
    const repo = tempRepo("orcl-typ-dedup-");
    installLocalBin(repo, "tsc");
    const diag = "src/thing.ts(1,7): error TS2304: Cannot find name 'value'.";
    const wg = new FakeDispatchClient();
    const oracleRunner = new ScriptedCommandRunner([
      { match: (c) => c.includes("tsc"), result: { stdout: diag, exitCode: 2 } },
    ]);
    const first = runIdleTypeQualityLoop(
      deps(configForRepo(repo), wg, oracleRunner, { tsc: createTscOracle(oracleRunner) }),
    );
    expect(first.status).toBe("draft_created");
    const secondDeps = deps(configForRepo(repo), wg, oracleRunner, {
      tsc: createTscOracle(oracleRunner),
    });
    const second = runIdleTypeQualityLoop(secondDeps);
    expect(second.status).toBe("no_findings");
    expect(secondDeps.events.types()).toContain("idle_finding_deduped");
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);
  });
});

// ── tech-debt: eslint + dead-code oracles ─────────────────────────────────────

describe("tech-debt loop with eslint / dead-code oracles", () => {
  it("drafts from merged eslint + knip findings when available", () => {
    const repo = tempRepo("orcl-td-");
    installLocalBin(repo, "eslint");
    installLocalBin(repo, "knip");
    const eslintOut = JSON.stringify([
      {
        filePath: "src/big.ts",
        messages: [{ ruleId: "complexity", severity: 2, line: 1, message: "too complex" }],
      },
    ]);
    const knipOut = JSON.stringify({ files: ["src/dead.ts"] });
    const runner = new ScriptedCommandRunner([
      { match: (c) => c.includes("eslint"), result: { stdout: eslintOut, exitCode: 1 } },
      { match: (c) => c.includes("knip"), result: { stdout: knipOut, exitCode: 1 } },
    ]);
    const wg = new FakeDispatchClient();
    const d = deps(configForRepo(repo), wg, runner, {
      eslint: createEslintOracle(runner),
      deadCode: createDeadCodeOracle(runner),
    });

    const outcome = runIdleTechDebtLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.description).toMatch(/complexity/);
    expect(ticket.ticket.description).toMatch(/unused-file/);
    expect(ticket.ticket.description).toMatch(/refactor-module/);
    const scanned = d.events.events.find((e) => e.type === "tech_debt_scanned");
    expect(scanned!.payload).toMatchObject({ path: "oracle" });
  });

  it("falls back to the heuristic god-file scan when no oracle tool is installed", () => {
    const repo = tempRepo("orcl-td-fb-");
    const filler = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n");
    writeFileSync(join(repo, "god.ts"), `${filler}\n`);
    const config = configForRepo(repo);
    config.loops.idle_tech_debt.god_file_lines = 20;
    const wg = new FakeDispatchClient();
    const d = deps(config, wg, new FakeCommandRunner({ stdout: "", exitCode: 0 }), {
      eslint: createEslintOracle(
        new FakeCommandRunner({ stdout: "", exitCode: 0 }),
        "/nonexistent/eslint",
      ),
      deadCode: createDeadCodeOracle(new FakeCommandRunner({ stdout: "", exitCode: 0 }), {
        knip: "/nonexistent/knip",
        tsPrune: "/nonexistent/ts-prune",
      }),
    });

    const outcome = runIdleTechDebtLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.description).toMatch(/God-file/);
    expect(d.events.types()).toContain("tech_debt_oracle_unavailable");
    const scanned = d.events.events.find((e) => e.type === "tech_debt_scanned");
    expect(scanned!.payload).toMatchObject({ path: "heuristic" });
  });
});

// ── security-hotspot: semgrep oracle ──────────────────────────────────────────

describe("security-hotspot loop with semgrep oracle", () => {
  it("drafts from semgrep findings when the oracle is available", () => {
    const repo = tempRepo("orcl-sec-");
    installLocalBin(repo, "semgrep");
    // The repo also has a grep-detectable eval — the oracle must win.
    writeFileSync(join(repo, "h.ts"), `eval(req.body);\n`);
    const sgOut = JSON.stringify({
      results: [
        {
          check_id: "javascript.lang.security.eval",
          path: "src/h.ts",
          start: { line: 1 },
          extra: { message: "eval is dangerous", severity: "ERROR" },
        },
      ],
    });
    const runner = new ScriptedCommandRunner([
      { match: (c) => c.includes("semgrep"), result: { stdout: sgOut, exitCode: 1 } },
    ]);
    const wg = new FakeDispatchClient();
    // An explicit local ruleset is required now that `auto` is never defaulted.
    const d = deps(configForRepo(repo), wg, runner, {
      security: createSecurityOracle(runner, { ruleset: "p/local" }),
    });

    const outcome = runIdleSecurityHotspotLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.description).toMatch(/javascript\.lang\.security\.eval/);
    expect(ticket.ticket.description).toMatch(/semgrep oracle/);
    const scanned = d.events.events.find((e) => e.type === "security_hotspot_scanned");
    expect(scanned!.payload).toMatchObject({ path: "oracle", oracle: "semgrep" });
  });

  it("falls back to the three-lens heuristic when semgrep is absent", () => {
    const repo = tempRepo("orcl-sec-fb-");
    writeFileSync(join(repo, "h.ts"), `eval(req.body);\n`);
    const wg = new FakeDispatchClient();
    const d = deps(configForRepo(repo), wg, new FakeCommandRunner({ stdout: "", exitCode: 0 }), {
      security: createSecurityOracle(new FakeCommandRunner({ stdout: "", exitCode: 0 }), {
        binary: "/nonexistent/semgrep",
      }),
    });

    const outcome = runIdleSecurityHotspotLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    // Heuristic path names the lens skill.
    expect(ticket.ticket.description).toMatch(/security-input-validation/);
    expect(d.events.types()).toContain("security_hotspot_oracle_unavailable");
    const scanned = d.events.events.find((e) => e.type === "security_hotspot_scanned");
    expect(scanned!.payload).toMatchObject({ path: "heuristic" });
  });

  it("reports no_findings when the semgrep oracle ran clean (no fallback)", () => {
    const repo = tempRepo("orcl-sec-clean-");
    installLocalBin(repo, "semgrep");
    // A grep-detectable eval is present, but the oracle ran and found nothing, so
    // the loop must NOT fall back to grep — it trusts the oracle's clean verdict.
    writeFileSync(join(repo, "h.ts"), `eval(req.body);\n`);
    const runner = new ScriptedCommandRunner([
      {
        match: (c) => c.includes("semgrep"),
        result: { stdout: JSON.stringify({ results: [] }), exitCode: 0 },
      },
    ]);
    const wg = new FakeDispatchClient();
    const d = deps(configForRepo(repo), wg, runner, {
      security: createSecurityOracle(runner, { ruleset: "p/local" }),
    });
    expect(runIdleSecurityHotspotLoop(d).status).toBe("no_findings");
  });
});
