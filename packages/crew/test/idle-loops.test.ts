import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FakeCommandRunner } from "../src/adapters/commandRunner.js";
import { EventLog } from "../src/events/eventLog.js";
import { runIdleCoverageLoop } from "../src/loops/idleLoop.js";
import { runIdleTestQualityLoop, scanTestQuality } from "../src/loops/idleTestQuality.js";
import { runIdleDocsLoop, scanDocs } from "../src/loops/idleDocs.js";
import {
  runIdleDependencyLoop,
  parseOutdated,
  parseAudit,
  scanPackageJson,
} from "../src/loops/idleDependencies.js";
import {
  runIdleSecurityHotspotLoop,
  scanSecurityHotspots,
} from "../src/loops/idleSecurityHotspot.js";
import { runIdleLoops } from "../src/loops/idleRegistry.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { TestClock } from "../src/util/clock.js";
import { RepoRegistry } from "../src/index.js";
import { crewConfigSchema, type CrewConfig } from "../src/config/schema.js";

/**
 * Enable every idle SCAN loop. Scan loops default to `enabled: false` (they
 * spend tokens), so registry-driven tests must opt them in explicitly to
 * observe the loops running.
 */
function enableScanLoops(config: CrewConfig): CrewConfig {
  config.loops.idle_coverage.enabled = true;
  config.loops.idle_test_quality.enabled = true;
  config.loops.idle_documentation.enabled = true;
  config.loops.idle_dependencies.enabled = true;
  config.loops.idle_security_hotspot.enabled = true;
  return config;
}

/** A config whose single repo points at a real temp directory. Scan loops on. */
function configForRepo(
  path: string,
  overrides: Partial<CrewConfig["repos"][number]> = {},
): CrewConfig {
  return enableScanLoops(
    crewConfigSchema.parse({
      factory: { name: "test-factory", mode: "local_strict" },
      repos: [
        {
          id: "demo",
          name: "demo",
          path,
          stack: "typescript",
          package_manager: "pnpm",
          ...overrides,
        },
      ],
    }),
  );
}

function deps(
  config: CrewConfig,
  wg: FakeDispatchClient,
  runner = new FakeCommandRunner({ stdout: "", exitCode: 0 }),
) {
  return {
    config,
    repoRegistry: RepoRegistry.fromConfig(config, "/tmp"),
    dispatch: wg,
    runner,
    events: new EventLog(new TestClock()),
    clock: new TestClock(),
  };
}

function tempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("test-quality scan", () => {
  it("flags skipped, focused and assertion-less tests", () => {
    const src = `
describe("auth", () => {
  it.skip("logs in", () => { expect(1).toBe(1); });
  it.only("focused", () => { expect(2).toBe(2); });
  it("does nothing", () => {
    const x = 1;
  });
  it("asserts", () => { expect(3).toBe(3); });
});`;
    const findings = scanTestQuality(src, "auth.test.ts");
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toContain("skipped");
    expect(kinds).toContain("focused");
    expect(kinds).toContain("no_assertion");
    expect(findings.find((f) => f.kind === "no_assertion")!.snippet).toMatch(/does nothing/);
  });

  it("creates a DRAFT ticket from canned test files (no code edits)", () => {
    const repo = tempRepo("fg-tq-");
    writeFileSync(
      join(repo, "thing.test.ts"),
      `it.skip("x", () => { expect(1).toBe(1); });\nit("y", () => { const z = 2; });\n`,
    );
    const wg = new FakeDispatchClient();
    const d = deps(configForRepo(repo), wg);

    const outcome = runIdleTestQualityLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");

    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.status).toBe("draft");
    expect(ticket.ticket.description).toMatch(/no code was changed/i);
    expect(ticket.repositories[0]!.name).toBe("demo");
    expect(wg.evidence).toHaveLength(0);
    expect(d.events.types()).toContain("idle_ticket_created");
  });

  it("reports no_findings when tests are clean", () => {
    const repo = tempRepo("fg-tq-clean-");
    writeFileSync(join(repo, "ok.test.ts"), `it("works", () => { expect(1).toBe(1); });\n`);
    const wg = new FakeDispatchClient();
    const outcome = runIdleTestQualityLoop(deps(configForRepo(repo), wg));
    expect(outcome.status).toBe("no_findings");
  });

  it("skips when ready tickets exist", () => {
    const repo = tempRepo("fg-tq-skip-");
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "ready", status: "ready" });
    expect(runIdleTestQualityLoop(deps(configForRepo(repo), wg)).status).toBe(
      "skipped_tickets_ready",
    );
  });
});

describe("documentation scan", () => {
  it("flags a missing README", () => {
    const repo = tempRepo("fg-doc-missing-");
    const findings = scanDocs(configForRepo(repo).repos[0]!, repo);
    expect(findings.map((f) => f.kind)).toContain("missing_readme");
  });

  it("flags a README with no setup section and a stale package-manager command", () => {
    const repo = tempRepo("fg-doc-stale-");
    writeFileSync(join(repo, "README.md"), "# Demo\n\nSome prose.\n\n```bash\nnpm install\n```\n");
    const findings = scanDocs(configForRepo(repo).repos[0]!, repo);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("missing_setup");
    expect(kinds).toContain("stale_command");
  });

  it("creates a DRAFT ticket for a doc gap", () => {
    const repo = tempRepo("fg-doc-draft-");
    const wg = new FakeDispatchClient();
    const d = deps(configForRepo(repo), wg);
    const outcome = runIdleDocsLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    expect(wg.getTicket(outcome.drafts[0]!.ticketId).ticket.status).toBe("draft");
    expect(wg.evidence).toHaveLength(0);
  });

  it("reports no_findings when README has a setup section and consistent commands", () => {
    const repo = tempRepo("fg-doc-ok-");
    writeFileSync(join(repo, "README.md"), "# Demo\n\n## Setup\n\n```bash\npnpm install\n```\n");
    const wg = new FakeDispatchClient();
    expect(runIdleDocsLoop(deps(configForRepo(repo), wg)).status).toBe("no_findings");
  });
});

describe("dependency hygiene scan", () => {
  it("parses outdated JSON output", () => {
    const out = JSON.stringify({
      lodash: { current: "4.17.20", latest: "4.17.21" },
      react: { current: "18.0.0", latest: "18.0.0" },
    });
    const findings = parseOutdated(out);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toMatch(/lodash/);
  });

  it("parses npm audit JSON output", () => {
    const out = JSON.stringify({
      metadata: { vulnerabilities: { info: 0, low: 1, high: 2, critical: 0 } },
    });
    const findings = parseAudit(out);
    expect(findings.map((f) => f.detail).join(" ")).toMatch(/low/);
    expect(findings.map((f) => f.detail).join(" ")).toMatch(/high/);
  });

  it("flags floating version ranges in package.json", () => {
    const findings = scanPackageJson(
      JSON.stringify({ dependencies: { a: "*", b: "^1.0.0" }, devDependencies: { c: "latest" } }),
    );
    expect(findings.map((f) => f.detail).join(" ")).toMatch(/a/);
    expect(findings.map((f) => f.detail).join(" ")).toMatch(/c/);
    expect(findings.map((f) => f.detail).join(" ")).not.toMatch(/\bb\b/);
  });

  it("creates a DRAFT ticket from package.json + canned audit output (no installs)", () => {
    const repo = tempRepo("fg-dep-");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { foo: "*" } }));
    const config = configForRepo(repo);
    config.loops.idle_dependencies.audit_command = "pnpm outdated --json";
    const wg = new FakeDispatchClient();
    const runner = new FakeCommandRunner({
      stdout: JSON.stringify({ foo: { current: "1.0.0", latest: "2.0.0" } }),
      exitCode: 1,
    });
    const d = deps(config, wg, runner);

    const outcome = runIdleDependencyLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.status).toBe("draft");
    expect(ticket.ticket.description).toMatch(/floating/i);
    // The audit command was the only command run — no install was issued.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.command).toBe("pnpm outdated --json");
    expect(wg.evidence).toHaveLength(0);
  });
});

describe("security-hotspot scan", () => {
  it("flags hardcoded secrets, injection sinks, unsafe APIs and disabled controls", () => {
    const src = [
      `const apiKey = "sk_live_abcdef0123456789";`,
      `const q = \`SELECT * FROM users WHERE id = \${userId}\`;`,
      `el.innerHTML = userInput;`,
      `eval(payload);`,
      `const agent = new https.Agent({ rejectUnauthorized: false });`,
      `const safe = process.env.TOKEN;`,
    ].join("\n");

    const findings = scanSecurityHotspots(src, "app.ts");
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("secret");
    expect(kinds).toContain("injection");
    expect(kinds).toContain("unsafe_api");
    expect(kinds).toContain("authz_gap");
    // Every finding carries a file location and a why-it's-a-risk explanation.
    for (const f of findings) {
      expect(f.file).toBe("app.ts");
      expect(f.line).toBeGreaterThan(0);
      expect(f.risk.length).toBeGreaterThan(0);
    }
  });

  it("does not flag env reads or placeholder values as secrets", () => {
    const src = [
      `const token = process.env.TOKEN;`,
      `const apiKey = "your-api-key-here";`,
      `const password = "changeme";`,
    ].join("\n");
    expect(scanSecurityHotspots(src, "config.ts").filter((f) => f.kind === "secret")).toHaveLength(
      0,
    );
  });

  it("redacts secret values from the finding snippet", () => {
    const findings = scanSecurityHotspots(
      `const apiKey = "sk_live_abcdef0123456789";`,
      "secrets.ts",
    );
    const secret = findings.find((f) => f.kind === "secret")!;
    expect(secret.snippet).not.toMatch(/sk_live_abcdef0123456789/);
    expect(secret.snippet).toMatch(/\*\*\*/);
  });

  it("creates a DRAFT ticket whose description carries the file location + risk (no code edits)", () => {
    const repo = tempRepo("fg-sec-");
    writeFileSync(
      join(repo, "handler.ts"),
      `const dbUrl = "postgres://app:s3cr3tp4ss@db/app";\nconst sql = "SELECT * FROM t WHERE id=" + req.params.id;\n`,
    );
    const wg = new FakeDispatchClient();
    const d = deps(configForRepo(repo), wg);

    const outcome = runIdleSecurityHotspotLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");

    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.status).toBe("draft");
    expect(ticket.ticket.description).toMatch(/no code was changed/i);
    // AC: findings include the file/location + why it's a risk.
    expect(ticket.ticket.description).toMatch(/handler\.ts:\d+/);
    expect(ticket.ticket.description).toMatch(/risk|injection|secret/i);
    // AC: the drafted ticket must not leak the hardcoded secret value.
    expect(ticket.ticket.description).not.toMatch(/s3cr3tp4ss/);
    expect(ticket.repositories[0]!.name).toBe("demo");
    expect(wg.evidence).toHaveLength(0);
    expect(d.events.types()).toContain("security_hotspot_scanned");
    expect(d.events.types()).toContain("idle_ticket_created");
  });

  it("reports no_findings when source is clean", () => {
    const repo = tempRepo("fg-sec-clean-");
    writeFileSync(
      join(repo, "clean.ts"),
      `export const add = (a: number, b: number): number => a + b;\n`,
    );
    const wg = new FakeDispatchClient();
    expect(runIdleSecurityHotspotLoop(deps(configForRepo(repo), wg)).status).toBe("no_findings");
  });

  it("skips when ready tickets exist (an idle tick only fires with no ready work)", () => {
    const repo = tempRepo("fg-sec-skip-");
    writeFileSync(join(repo, "bad.ts"), `eval(x);\n`);
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "ready", status: "ready" });
    expect(runIdleSecurityHotspotLoop(deps(configForRepo(repo), wg)).status).toBe(
      "skipped_tickets_ready",
    );
  });
});

describe("idle-loop modes", () => {
  /** Write a repo whose test_quality scan yields exactly one finding. */
  function smellyRepo(): string {
    const repo = tempRepo("fg-mode-");
    writeFileSync(join(repo, "smelly.test.ts"), `it.skip("x", () => { expect(1).toBe(1); });\n`);
    return repo;
  }

  const draftCreations = (wg: FakeDispatchClient) =>
    wg.events.filter((e) => e.type === "draft_ticket.created");

  it("observe_only records the finding and creates nothing in Dispatch", () => {
    const repo = smellyRepo();
    const config = configForRepo(repo);
    config.loops.idle_test_quality.mode = "observe_only";
    const wg = new FakeDispatchClient();
    const d = deps(config, wg);

    const outcome = runIdleTestQualityLoop(d);

    expect(outcome.status).toBe("observed");
    if (outcome.status !== "observed") throw new Error("unreachable");
    // The finding is still returned in the outcome.
    expect(outcome.observations).toHaveLength(1);
    expect(outcome.observations[0]!.repoName).toBe("demo");
    expect(outcome.observations[0]!.summary).toMatch(/Test-quality scan/);
    // Nothing was created in Dispatch: no draft, no ready ticket.
    expect(draftCreations(wg)).toHaveLength(0);
    expect(wg.listReady()).toHaveLength(0);
    // The finding was recorded as a runtime event.
    expect(d.events.types()).toContain("idle_finding_observed");
    expect(d.events.types()).not.toContain("idle_ticket_created");
  });

  it("create_draft_tickets is the default and unchanged", () => {
    const repo = smellyRepo();
    const config = configForRepo(repo);
    // Default with no override.
    expect(config.loops.idle_test_quality.mode).toBe("create_draft_tickets");
    const wg = new FakeDispatchClient();
    const d = deps(config, wg);

    const outcome = runIdleTestQualityLoop(d);

    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.status).toBe("draft");
    expect(draftCreations(wg)).toHaveLength(1);
    expect(wg.listReady()).toHaveLength(0);
    expect(d.events.types()).toContain("idle_ticket_created");
    expect(d.events.types()).not.toContain("idle_ticket_marked_ready");
  });

  it("create_ready_tickets creates the ticket and marks it ready", () => {
    const repo = smellyRepo();
    const config = configForRepo(repo);
    config.loops.idle_test_quality.mode = "create_ready_tickets";
    const wg = new FakeDispatchClient();
    const d = deps(config, wg);

    const outcome = runIdleTestQualityLoop(d);

    expect(outcome.status).toBe("ready_created");
    if (outcome.status !== "ready_created") throw new Error("unreachable");
    const ticketId = outcome.drafts[0]!.ticketId;
    expect(draftCreations(wg)).toHaveLength(1);
    // The created ticket was transitioned to ready.
    expect(wg.getTicket(ticketId).ticket.status).toBe("ready");
    expect(wg.listReady().map((t) => t.ticketId)).toContain(ticketId);
    expect(d.events.types()).toContain("idle_ticket_marked_ready");
  });

  it("applies observe_only to the coverage loop too (nothing created, finding returned)", () => {
    const repo = tempRepo("fg-mode-cov-");
    const config = configForRepo(repo, { coverage_command: "echo cov" });
    config.loops.idle_coverage.mode = "observe_only";
    const wg = new FakeDispatchClient();
    const runner = new FakeCommandRunner({ stdout: "TOTAL 100 40 60%", exitCode: 0 });
    const d = deps(config, wg, runner);

    const outcome = runIdleCoverageLoop(d);

    expect(outcome.status).toBe("observed");
    if (outcome.status !== "observed") throw new Error("unreachable");
    expect(outcome.observations[0]!.finding.totalCoverage).toBe(60);
    expect(draftCreations(wg)).toHaveLength(0);
    expect(wg.listReady()).toHaveLength(0);
  });

  it("applies create_ready_tickets to the coverage loop too", () => {
    const repo = tempRepo("fg-mode-cov-ready-");
    const config = configForRepo(repo, { coverage_command: "echo cov" });
    config.loops.idle_coverage.mode = "create_ready_tickets";
    const wg = new FakeDispatchClient();
    const runner = new FakeCommandRunner({ stdout: "TOTAL 100 40 60%", exitCode: 0 });
    const d = deps(config, wg, runner);

    const outcome = runIdleCoverageLoop(d);

    expect(outcome.status).toBe("ready_created");
    if (outcome.status !== "ready_created") throw new Error("unreachable");
    expect(wg.getTicket(outcome.drafts[0]!.ticketId).ticket.status).toBe("ready");
  });
});

describe("self-improve closed loop", () => {
  /** A repo whose test_quality scan yields exactly one finding. */
  function smellyRepo(prefix = "fg-si-"): string {
    const repo = tempRepo(prefix);
    writeFileSync(join(repo, "smelly.test.ts"), `it.skip("x", () => { expect(1).toBe(1); });\n`);
    return repo;
  }

  function readyStatuses(wg: FakeDispatchClient): string[] {
    return wg.listReady().map((t) => t.ticketId);
  }

  it("is off by default — drafts stay drafts even when findings exist", () => {
    const repo = smellyRepo();
    const config = configForRepo(repo, { coverage_command: null });
    // No self_improve config touched: enabled defaults to false.
    expect(config.loops.self_improve.enabled).toBe(false);
    const wg = new FakeDispatchClient();

    const report = runIdleLoops(deps(config, wg));

    expect(report.selfImprovePromoted).toBe(0);
    expect(readyStatuses(wg)).toHaveLength(0);
  });

  it("enabled + opted-in low-risk repo auto-readies a draft, and the delivery loop claims it", () => {
    const repo = smellyRepo();
    const config = configForRepo(repo, { coverage_command: null, risk_level: "low" });
    config.loops.self_improve.enabled = true;
    config.loops.self_improve.repos = ["demo"];
    // Only test_quality fires (give it a README so docs stays quiet) to keep one finding.
    writeFileSync(join(repo, "README.md"), "# Demo\n\n## Setup\n\n```bash\npnpm install\n```\n");
    const wg = new FakeDispatchClient();

    const report = runIdleLoops(deps(config, wg));

    // AC1: the idle tick drafted + auto-readied a low-risk improvement.
    expect(report.selfImprovePromoted).toBe(1);
    const ready = wg.listReady();
    expect(ready).toHaveLength(1);
    // …and the delivery loop can pick it up.
    const claim = wg.claimNextTicket({ agentId: "agent-1", ttlSeconds: 900 });
    expect(claim).not.toBeNull();
    expect(claim!.ticketId).toBe(ready[0]!.ticketId);
  });

  it("is bounded — the per-tick cap limits how many drafts a single loop promotes", () => {
    // Two opted-in low-risk repos, each with a smelly test and a clean README,
    // so the test_quality loop drafts for BOTH in one pass. With the queue-empty
    // guard, only the first loop in a tick can promote, so the cap must hold
    // within that single multi-repo pass.
    const setup = "# Demo\n\n## Setup\n\n```bash\npnpm install\n```\n";
    const repoA = tempRepo("fg-si-capA-");
    const repoB = tempRepo("fg-si-capB-");
    for (const r of [repoA, repoB]) {
      writeFileSync(join(r, "smelly.test.ts"), `it.skip("x", () => { expect(1).toBe(1); });\n`);
      writeFileSync(join(r, "README.md"), setup);
    }
    const config = enableScanLoops(
      crewConfigSchema.parse({
        factory: { name: "test-factory", mode: "local_strict" },
        repos: [
          { id: "a", name: "repo-a", path: repoA, stack: "typescript", risk_level: "low" },
          { id: "b", name: "repo-b", path: repoB, stack: "typescript", risk_level: "low" },
        ],
      }),
    );
    config.loops.self_improve.enabled = true;
    config.loops.self_improve.repos = ["repo-a", "repo-b"];
    config.loops.self_improve.max_ready_per_run = 1;
    const wg = new FakeDispatchClient();
    const d = deps(config, wg);

    const report = runIdleLoops(d);

    // AC2: two drafts created, but the cap means only one is promoted to ready.
    expect(report.totalDrafts).toBeGreaterThanOrEqual(2);
    expect(report.selfImprovePromoted).toBe(1);
    expect(wg.listReady()).toHaveLength(1);
    expect(d.events.types()).toContain("self_improve_cap_reached");
  });

  it("respects strict opt-in — a repo not listed is never promoted", () => {
    const repo = smellyRepo("fg-si-optout-");
    const config = configForRepo(repo, { coverage_command: null, risk_level: "low" });
    config.loops.self_improve.enabled = true;
    config.loops.self_improve.repos = ["some-other-repo"]; // demo is not listed
    const wg = new FakeDispatchClient();

    const report = runIdleLoops(deps(config, wg));

    expect(report.selfImprovePromoted).toBe(0);
    expect(wg.listReady()).toHaveLength(0);
  });

  it("respects the risk ceiling — a repo above max_risk is skipped", () => {
    const repo = smellyRepo("fg-si-risk-");
    const config = configForRepo(repo, { coverage_command: null, risk_level: "high" });
    config.loops.self_improve.enabled = true;
    config.loops.self_improve.repos = ["demo"];
    config.loops.self_improve.max_risk = "low"; // high > low → skipped
    const wg = new FakeDispatchClient();
    const d = deps(config, wg);

    const report = runIdleLoops(d);

    expect(report.selfImprovePromoted).toBe(0);
    expect(wg.listReady()).toHaveLength(0);
    expect(d.events.types()).toContain("self_improve_skipped");
  });
});

describe("idle-loop registry", () => {
  it("runs every enabled loop and aggregates draft counts", () => {
    const repo = tempRepo("fg-reg-");
    // No README + a smelly test => documentation + test_quality both fire.
    writeFileSync(join(repo, "bad.test.ts"), `it.only("focus", () => { const a = 1; });\n`);
    const wg = new FakeDispatchClient();
    const config = configForRepo(repo, { coverage_command: null });
    const report = runIdleLoops(deps(config, wg));

    const ran = report.loops.map((l) => l.id);
    expect(ran).toContain("documentation");
    expect(ran).toContain("test_quality");
    expect(ran).toContain("dependency_hygiene");
    expect(ran).toContain("security_hotspot");
    // Stubs are not present.
    expect(ran).not.toContain("lore_gap");
    expect(ran).not.toContain("design_drift");
    expect(report.totalDrafts).toBeGreaterThanOrEqual(1);
  });

  it("skips all loops when ready tickets exist", () => {
    const repo = tempRepo("fg-reg-skip-");
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "ready", status: "ready" });
    const report = runIdleLoops(deps(configForRepo(repo, { coverage_command: null }), wg));
    expect(report.totalDrafts).toBe(0);
    for (const l of report.loops) expect(l.outcome.status).toBe("skipped_tickets_ready");
  });

  it("respects per-loop enabled flags", () => {
    const repo = tempRepo("fg-reg-disabled-");
    const wg = new FakeDispatchClient();
    const config = configForRepo(repo, { coverage_command: null });
    config.loops.idle_documentation.enabled = false;
    config.loops.idle_test_quality.enabled = false;
    config.loops.idle_dependencies.enabled = false;
    config.loops.idle_coverage.enabled = false;
    config.loops.idle_security_hotspot.enabled = false;
    const report = runIdleLoops(deps(config, wg));
    expect(report.loops).toHaveLength(0);
  });
});

describe("idle finding dedup", () => {
  it("creates ONE draft when the same scan finding recurs across ticks", () => {
    const repo = tempRepo("fg-dedup-");
    writeFileSync(
      join(repo, "thing.test.ts"),
      `it.skip("x", () => { expect(1).toBe(1); });\nit("y", () => { const z = 2; });\n`,
    );
    const wg = new FakeDispatchClient();

    // First tick: the finding is new, so a draft is created.
    const first = runIdleTestQualityLoop(deps(configForRepo(repo), wg));
    expect(first.status).toBe("draft_created");
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);

    // Second tick (fresh deps, same repo + finding): the open draft suppresses a
    // re-draft via the stamped Finding-Key marker.
    const secondDeps = deps(configForRepo(repo), wg);
    const second = runIdleTestQualityLoop(secondDeps);

    // Still exactly one draft ticket across both ticks.
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);
    // The second tick reports no new findings and emits the dedup event.
    expect(second.status).toBe("no_findings");
    expect(secondDeps.events.types()).toContain("idle_finding_deduped");
    expect(secondDeps.events.types()).not.toContain("idle_ticket_created");
  });
});

describe("idle policy-pack threading", () => {
  function configWithPolicyPack(path: string, policyPack: string): CrewConfig {
    return crewConfigSchema.parse({
      factory: { name: "test-factory", mode: "local_strict" },
      dispatch: { default_policy_pack: policyPack },
      repos: [{ id: "demo", name: "demo", path, stack: "typescript", package_manager: "pnpm" }],
    });
  }

  it("stamps config.default_policy_pack onto a draft created by an idle scan", () => {
    const repo = tempRepo("fg-pp-strict-");
    writeFileSync(join(repo, "thing.test.ts"), `it.skip("x", () => { expect(1).toBe(1); });\n`);
    const wg = new FakeDispatchClient();
    const outcome = runIdleTestQualityLoop(deps(configWithPolicyPack(repo, "factory_strict"), wg));
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");

    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.policyPack).toBe("factory_strict");
  });

  it("defaults the draft policy pack to solo_loose", () => {
    const repo = tempRepo("fg-pp-default-");
    writeFileSync(join(repo, "thing.test.ts"), `it.skip("x", () => { expect(1).toBe(1); });\n`);
    const wg = new FakeDispatchClient();
    const outcome = runIdleTestQualityLoop(deps(configForRepo(repo), wg));
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");

    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.policyPack).toBe("solo_loose");
  });
});

describe("scan loops default OFF", () => {
  it("the registry runs no scan loops on a fresh (default) config", () => {
    const repo = tempRepo("fg-off-");
    // A finding exists (smelly test + no README) — but with every scan loop at
    // its default (enabled: false), the registry must run nothing.
    writeFileSync(join(repo, "bad.test.ts"), `it.only("focus", () => { const a = 1; });\n`);
    const config = crewConfigSchema.parse({
      factory: { name: "test-factory", mode: "local_strict" },
      repos: [{ id: "demo", name: "demo", path: repo, stack: "typescript" }],
    });
    // Sanity: defaults really are off.
    expect(config.loops.idle_coverage.enabled).toBe(false);
    expect(config.loops.idle_test_quality.enabled).toBe(false);
    expect(config.loops.idle_documentation.enabled).toBe(false);
    expect(config.loops.idle_dependencies.enabled).toBe(false);
    expect(config.loops.idle_security_hotspot.enabled).toBe(false);

    const wg = new FakeDispatchClient();
    const report = runIdleLoops(deps(config, wg));

    expect(report.loops).toHaveLength(0);
    expect(report.totalDrafts).toBe(0);
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(0);
  });

  it("an explicitly-enabled loop still runs", () => {
    const repo = tempRepo("fg-on-");
    writeFileSync(join(repo, "bad.test.ts"), `it.skip("x", () => { expect(1).toBe(1); });\n`);
    const config = crewConfigSchema.parse({
      factory: { name: "test-factory", mode: "local_strict" },
      repos: [{ id: "demo", name: "demo", path: repo, stack: "typescript" }],
    });
    config.loops.idle_test_quality.enabled = true; // only this one opted in

    const wg = new FakeDispatchClient();
    const report = runIdleLoops(deps(config, wg));

    const ran = report.loops.map((l) => l.id);
    expect(ran).toContain("test_quality");
    expect(ran).not.toContain("documentation");
    expect(ran).not.toContain("security_hotspot");
    expect(report.totalDrafts).toBeGreaterThanOrEqual(1);
  });
});

describe("per-repo delivered-ticket threshold", () => {
  /** A repo whose test-quality scan yields exactly one finding. */
  function smellyRepo(prefix = "fg-thresh-"): string {
    const repo = tempRepo(prefix);
    writeFileSync(join(repo, "smelly.test.ts"), `it.skip("x", () => { expect(1).toBe(1); });\n`);
    return repo;
  }

  /** Seed `n` delivered (`done`) tickets referencing `repoName`. */
  function seedDelivered(wg: FakeDispatchClient, repoName: string, n: number): void {
    for (let i = 0; i < n; i++) {
      wg.seedTicket({ title: `done ${i}`, status: "done", repositories: [{ name: repoName }] });
    }
  }

  it("counts only delivered (done) tickets for the repo", () => {
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "d1", status: "done", repositories: [{ name: "demo" }] });
    wg.seedTicket({ title: "d2", status: "done", repositories: [{ name: "demo" }] });
    wg.seedTicket({ title: "open", status: "ready", repositories: [{ name: "demo" }] });
    wg.seedTicket({ title: "other-repo", status: "done", repositories: [{ name: "elsewhere" }] });
    expect(wg.countDeliveredTickets("demo")).toBe(2);
    expect(wg.countDeliveredTickets("elsewhere")).toBe(1);
    expect(wg.countDeliveredTickets("unknown")).toBe(0);
  });

  it("SKIPS a repo below its threshold and records skipped_below_threshold", () => {
    const repo = smellyRepo("fg-thresh-under-");
    const config = configForRepo(repo);
    config.loops.idle_test_quality.min_delivered_tickets = 3;
    const wg = new FakeDispatchClient();
    seedDelivered(wg, "demo", 2); // 2 < 3 → under threshold

    const d = deps(config, wg);
    const outcome = runIdleTestQualityLoop(d);

    // No candidates remain → no_repos, and nothing was drafted.
    expect(outcome.status).toBe("no_repos");
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(0);
    const skip = d.events.events.find(
      (e) => e.type === "loop_finished" && e.payload?.result === "skipped_below_threshold",
    );
    expect(skip).toBeDefined();
    expect(skip!.payload).toMatchObject({
      loop: "test_quality",
      repoName: "demo",
      delivered: 2,
      minDelivered: 3,
    });
  });

  it("RUNS a repo at/above its threshold", () => {
    const repo = smellyRepo("fg-thresh-at-");
    const config = configForRepo(repo);
    config.loops.idle_test_quality.min_delivered_tickets = 3;
    const wg = new FakeDispatchClient();
    seedDelivered(wg, "demo", 3); // 3 >= 3 → at threshold, runs

    const d = deps(config, wg);
    const outcome = runIdleTestQualityLoop(d);

    expect(outcome.status).toBe("draft_created");
    expect(
      d.events.events.some(
        (e) => e.type === "loop_finished" && e.payload?.result === "skipped_below_threshold",
      ),
    ).toBe(false);
  });

  it("a per-loop value overrides the loops-level default", () => {
    const repo = smellyRepo("fg-thresh-override-");
    const config = configForRepo(repo);
    config.loops.default_min_delivered_tickets = 5; // factory default would skip
    config.loops.idle_test_quality.min_delivered_tickets = 1; // but this loop allows 1+
    const wg = new FakeDispatchClient();
    seedDelivered(wg, "demo", 1);

    expect(runIdleTestQualityLoop(deps(config, wg)).status).toBe("draft_created");
  });

  it("a loop with min_delivered_tickets null inherits the loops-level default", () => {
    const repo = smellyRepo("fg-thresh-inherit-");
    const config = configForRepo(repo);
    config.loops.default_min_delivered_tickets = 2;
    // idle_test_quality.min_delivered_tickets stays null → inherits 2.
    expect(config.loops.idle_test_quality.min_delivered_tickets).toBeNull();
    const wg = new FakeDispatchClient();
    seedDelivered(wg, "demo", 1); // 1 < 2 → skipped via inherited default

    expect(runIdleTestQualityLoop(deps(config, wg)).status).toBe("no_repos");
  });

  it("gates the coverage loop too (it uses its own candidate filter)", () => {
    const repo = tempRepo("fg-thresh-cov-");
    const config = configForRepo(repo, { coverage_command: "echo cov" });
    config.loops.idle_coverage.min_delivered_tickets = 2;
    const wg = new FakeDispatchClient();
    const runner = new FakeCommandRunner({ stdout: "TOTAL 100 40 60%", exitCode: 0 });
    // 0 delivered < 2 → repo gated out, command never runs.
    const d = deps(config, wg, runner);

    const outcome = runIdleCoverageLoop(d);

    expect(outcome.status).toBe("no_repos");
    expect(runner.calls).toHaveLength(0);
    expect(
      d.events.events.some(
        (e) => e.type === "loop_finished" && e.payload?.result === "skipped_below_threshold",
      ),
    ).toBe(true);
  });
});
