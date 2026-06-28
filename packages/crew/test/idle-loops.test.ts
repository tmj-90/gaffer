import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FakeCommandRunner,
  systemCommandRunner,
  type CommandRunner,
} from "../src/adapters/commandRunner.js";
import { EventLog } from "../src/events/eventLog.js";
import { runIdleCoverageLoop } from "../src/loops/idleLoop.js";
import { runIdleTestQualityLoop, scanTestQuality } from "../src/loops/idleTestQuality.js";
import { runIdleTypeQualityLoop, scanTypeQuality } from "../src/loops/idleTypeQuality.js";
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
  isLikelyFalsePositive,
} from "../src/loops/idleSecurityHotspot.js";
import { runIdleTechDebtLoop, scanTechDebt } from "../src/loops/idleTechDebt.js";
import { runIdleLoops, runMaintenanceLane } from "../src/loops/idleRegistry.js";
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
  config.loops.idle_type_quality.enabled = true;
  config.loops.idle_documentation.enabled = true;
  config.loops.idle_dependencies.enabled = true;
  config.loops.idle_security_hotspot.enabled = true;
  config.loops.idle_tech_debt.enabled = true;
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
  runner: CommandRunner = new FakeCommandRunner({ stdout: "", exitCode: 0 }),
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

describe("security-hotspot three-lens + adversarial verify (A4)", () => {
  it("attributes each finding to one of the three security lenses + skills", () => {
    const src = [
      `const apiKey = "sk_live_abcdef0123456789";`, // secret_handling
      `const q = \`SELECT * FROM users WHERE id = \${userId}\`;`, // input_validation
      `const agent = new https.Agent({ rejectUnauthorized: false });`, // authz
    ].join("\n");
    const findings = scanSecurityHotspots(src, "app.ts");
    const lenses = new Set(findings.map((f) => f.lens));
    expect(lenses).toContain("secret_handling");
    expect(lenses).toContain("input_validation");
    expect(lenses).toContain("authz");
  });

  it("the verify gate refutes commented-out matches (default-refute false positives)", () => {
    // The same eval that would file on a live line is dropped when commented.
    expect(scanSecurityHotspots(`eval(payload);`, "a.ts")).not.toHaveLength(0);
    expect(scanSecurityHotspots(`// eval(payload);`, "a.ts")).toHaveLength(0);
    expect(isLikelyFalsePositive('  // const apiKey = "sk_live_aaaaaaaaaaaaaaaa";')).toBe(true);
    expect(isLikelyFalsePositive(`const apiKey = "sk_live_aaaaaaaaaaaaaaaa";`)).toBe(false);
  });

  it("the verify gate refutes a RegExp .exec (not code execution)", () => {
    expect(scanSecurityHotspots(`const m = /foo/.exec(input);`, "a.ts")).toHaveLength(0);
    // A real child_process exec still files.
    expect(
      scanSecurityHotspots(`child_process.exec(userCmd);`, "a.ts").some(
        (f) => f.kind === "unsafe_api",
      ),
    ).toBe(true);
  });

  it("the verify gate refutes a test-only disabled control", () => {
    expect(
      scanSecurityHotspots(
        `const opt = { verify: false }; // mock transport for unit test`,
        "a.ts",
      ),
    ).toHaveLength(0);
    // A production rejectUnauthorized:false still files as an authz gap.
    expect(
      scanSecurityHotspots(`new https.Agent({ rejectUnauthorized: false });`, "a.ts").some(
        (f) => f.lens === "authz",
      ),
    ).toBe(true);
  });

  it("still drafts a ticket on a real finding, naming the lens skill (no code edits)", () => {
    const repo = tempRepo("fg-sec-lens-");
    writeFileSync(join(repo, "handler.ts"), `eval(req.body);\n`);
    const wg = new FakeDispatchClient();
    const outcome = runIdleSecurityHotspotLoop(deps(configForRepo(repo), wg));
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");
    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.description).toMatch(/security-input-validation/);
    expect(ticket.ticket.description).toMatch(/no code was changed/i);
    expect(wg.evidence).toHaveLength(0);
  });

  it("files nothing when every candidate is refuted by the verify gate", () => {
    const repo = tempRepo("fg-sec-allrefuted-");
    // All matches are commented out → every candidate refuted → no_findings.
    writeFileSync(join(repo, "x.ts"), `// eval(x);\n// el.innerHTML = userInput;\n`);
    const wg = new FakeDispatchClient();
    expect(runIdleSecurityHotspotLoop(deps(configForRepo(repo), wg)).status).toBe("no_findings");
  });

  it("dedups a re-found hotspot across ticks (one draft only)", () => {
    const repo = tempRepo("fg-sec-dedup-");
    writeFileSync(join(repo, "h.ts"), `eval(req.body);\n`);
    const wg = new FakeDispatchClient();
    const first = runIdleSecurityHotspotLoop(deps(configForRepo(repo), wg));
    expect(first.status).toBe("draft_created");
    const secondDeps = deps(configForRepo(repo), wg);
    const second = runIdleSecurityHotspotLoop(secondDeps);
    expect(second.status).toBe("no_findings");
    expect(secondDeps.events.types()).toContain("idle_finding_deduped");
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);
  });
});

describe("type-quality scan", () => {
  it("flags `as` casts, non-null `!`, @ts-* suppressions and bare any", () => {
    const src = [
      `const a = value as Widget;`,
      `const b = config!.timeout;`,
      `// @ts-ignore legacy`,
      `function f(x: any): void {}`,
      `const ok: number = 1;`,
    ].join("\n");

    const findings = scanTypeQuality(src, "app.ts");
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("cast");
    expect(kinds).toContain("non_null");
    expect(kinds).toContain("ts_suppression");
    expect(kinds).toContain("any");
    // Every finding carries a file location and a non-zero severity for ranking.
    for (const f of findings) {
      expect(f.file).toBe("app.ts");
      expect(f.line).toBeGreaterThan(0);
      expect(f.severity).toBeGreaterThan(0);
    }
  });

  it("detects skipLibCheck:true in a tsconfig and ranks it highest", () => {
    const findings = scanTypeQuality(
      `{ "compilerOptions": { "skipLibCheck": true } }`,
      "tsconfig.json",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("skip_lib_check");
    // skipLibCheck outranks `as`/`!`/any.
    const cast = scanTypeQuality(`const a = b as C;`, "x.ts")[0]!;
    expect(findings[0]!.severity).toBeGreaterThan(cast.severity);
  });

  it("does not flag `!=` / logical-not or `import ... as` as findings", () => {
    const src = [`if (a != b) return;`, `if (!ready) return;`, `import { x as y } from "z";`].join(
      "\n",
    );
    const findings = scanTypeQuality(src, "clean.ts");
    expect(findings.filter((f) => f.kind === "non_null")).toHaveLength(0);
    expect(findings.filter((f) => f.kind === "cast")).toHaveLength(0);
  });

  it("creates a DRAFT ticket whose description carries the skill + acceptance criteria (no code edits)", () => {
    const repo = tempRepo("fg-typ-");
    writeFileSync(
      join(repo, "thing.ts"),
      `const a = value as Widget;\nconst b = config!.timeout;\n`,
    );
    const wg = new FakeDispatchClient();
    const d = deps(configForRepo(repo), wg);

    const outcome = runIdleTypeQualityLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");

    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.status).toBe("draft");
    expect(ticket.ticket.description).toMatch(/no code was changed/i);
    // AC: ticket names the typescript-conventions skill and the objective oracle.
    expect(ticket.ticket.description).toMatch(/typescript-conventions/);
    expect(ticket.ticket.description).toMatch(/pnpm typecheck/);
    expect(ticket.ticket.description).toMatch(/no public API change/i);
    expect(ticket.ticket.description).toMatch(/hotspot/i);
    expect(ticket.repositories[0]!.name).toBe("demo");
    expect(wg.evidence).toHaveLength(0);
    expect(d.events.types()).toContain("type_quality_scanned");
    expect(d.events.types()).toContain("idle_ticket_created");
  });

  it("reports no_findings when source is type-clean", () => {
    const repo = tempRepo("fg-typ-clean-");
    writeFileSync(
      join(repo, "clean.ts"),
      `export const add = (a: number, b: number): number => a + b;\n`,
    );
    const wg = new FakeDispatchClient();
    expect(runIdleTypeQualityLoop(deps(configForRepo(repo), wg)).status).toBe("no_findings");
  });

  it("skips when ready tickets exist (an idle tick only fires with no ready work)", () => {
    const repo = tempRepo("fg-typ-skip-");
    writeFileSync(join(repo, "x.ts"), `const a = b as C;\n`);
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "ready", status: "ready" });
    expect(runIdleTypeQualityLoop(deps(configForRepo(repo), wg)).status).toBe(
      "skipped_tickets_ready",
    );
  });

  it("creates ONE draft when the same finding recurs across ticks (dedup)", () => {
    const repo = tempRepo("fg-typ-dedup-");
    writeFileSync(join(repo, "thing.ts"), `const a = value as Widget;\n`);
    const wg = new FakeDispatchClient();

    const first = runIdleTypeQualityLoop(deps(configForRepo(repo), wg));
    expect(first.status).toBe("draft_created");
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);

    const secondDeps = deps(configForRepo(repo), wg);
    const second = runIdleTypeQualityLoop(secondDeps);
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);
    expect(second.status).toBe("no_findings");
    expect(secondDeps.events.types()).toContain("idle_finding_deduped");
    expect(secondDeps.events.types()).not.toContain("idle_ticket_created");
  });
});

describe("tech-debt scan", () => {
  /** A source line that won't be flagged by any other detector. */
  const filler = (n: number): string =>
    Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");

  it("flags a god-file whose LOC exceeds the threshold", () => {
    const repo = tempRepo("fg-td-god-");
    // 30 LOC core.ts with a low god_file_lines threshold; no churn (runner "").
    writeFileSync(join(repo, "core.ts"), `${filler(30)}\n`);
    const config = configForRepo(repo, { coverage_command: null });
    config.loops.idle_tech_debt.god_file_lines = 20;
    config.loops.idle_tech_debt.churn_size_product_threshold = 1_000_000; // out of reach

    const wg = new FakeDispatchClient();
    const d = deps(config, wg); // default runner → stdout "" → churn 0
    const root = d.repoRegistry.absolutePath(d.repoRegistry.list()[0]!);
    const findings = scanTechDebt(d, root, [join(root, "core.ts")], 20, 1_000_000);
    expect(findings.map((f) => f.kind)).toContain("god_file");
    expect(findings.find((f) => f.kind === "god_file")!.loc).toBeGreaterThan(20);
  });

  it("flags a churn×size hotspot when commit-count × LOC exceeds the threshold", () => {
    const repo = tempRepo("fg-td-churn-");
    writeFileSync(join(repo, "app.js"), `${filler(10)}\n`); // 10 LOC, small (not a god-file)
    const config = configForRepo(repo, { coverage_command: null });
    config.loops.idle_tech_debt.god_file_lines = 500; // app.js stays under
    config.loops.idle_tech_debt.churn_size_product_threshold = 50; // 10 LOC × 6 commits = 60 > 50

    const wg = new FakeDispatchClient();
    // FakeCommandRunner supplies the commit count: 6 hashes on stdout.
    const runner = new FakeCommandRunner({
      stdout: ["a1", "b2", "c3", "d4", "e5", "f6"].join("\n"),
      exitCode: 0,
    });
    const d = deps(config, wg, runner);
    const root = d.repoRegistry.absolutePath(d.repoRegistry.list()[0]!);
    const findings = scanTechDebt(d, root, [join(root, "app.js")], 500, 50);

    const hotspot = findings.find((f) => f.kind === "churn_size");
    expect(hotspot).toBeDefined();
    expect(hotspot!.churn).toBe(6);
    expect(hotspot!.product).toBeGreaterThan(50);
    // The churn lookup went through the injected command runner (git log).
    expect(runner.calls.some((c) => c.command.startsWith("git log"))).toBe(true);
  });

  it("does NOT execute shell metacharacters in a scanned filename (no injection)", () => {
    // FIX-2: a malicious filename must never be interpolated into a shell string.
    // The churn lookup runs `git log` over the REAL systemCommandRunner; a file
    // literally named `$(touch PWNED).ts` would, under shell interpolation, run
    // `touch PWNED` during the scan. With the no-shell argv path it is inert.
    const repo = tempRepo("fg-td-inject-");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@e"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);

    const evil = "$(touch PWNED).ts";
    writeFileSync(join(repo, evil), "const x = 1;\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);

    const config = configForRepo(repo, { coverage_command: null });
    const wg = new FakeDispatchClient();
    // REAL runner — this is the security boundary under test, not the fake.
    const d = deps(config, wg, systemCommandRunner);
    const root = d.repoRegistry.absolutePath(d.repoRegistry.list()[0]!);

    const findings = scanTechDebt(d, root, [join(root, evil)], 500, 1_000_000);

    // The injection payload must NOT have run: no PWNED file anywhere it could land.
    expect(existsSync(join(repo, "PWNED"))).toBe(false);
    expect(existsSync(join(root, "PWNED"))).toBe(false);
    expect(existsSync(join(process.cwd(), "PWNED"))).toBe(false);
    // And the scan still produced a sane result (1 real commit touched the file).
    expect(Array.isArray(findings)).toBe(true);
  });

  it("detects a lexical-duplication cluster shared across two files", () => {
    const repo = tempRepo("fg-td-dup-");
    // A 10-line identical block present in BOTH files.
    const block = Array.from({ length: 10 }, (_, i) => `  doThing(${i}, payload);`).join("\n");
    writeFileSync(join(repo, "a.ts"), `export function a() {\n${block}\n}\n`);
    writeFileSync(join(repo, "b.ts"), `export function b() {\n${block}\n}\n`);
    const config = configForRepo(repo, { coverage_command: null });

    const wg = new FakeDispatchClient();
    const d = deps(config, wg); // churn 0, files small
    const root = d.repoRegistry.absolutePath(d.repoRegistry.list()[0]!);
    const findings = scanTechDebt(
      d,
      root,
      [join(root, "a.ts"), join(root, "b.ts")],
      500,
      1_000_000,
    );
    const dupFiles = findings.filter((f) => f.kind === "duplication").map((f) => f.file);
    expect(dupFiles).toContain("a.ts");
    expect(dupFiles).toContain("b.ts");
  });

  it("reports nothing on small, clean, non-duplicated files", () => {
    const repo = tempRepo("fg-td-clean-");
    writeFileSync(join(repo, "small.ts"), `export const add = (a: number, b: number) => a + b;\n`);
    const wg = new FakeDispatchClient();
    expect(
      runIdleTechDebtLoop(deps(configForRepo(repo, { coverage_command: null }), wg)).status,
    ).toBe("no_findings");
  });

  it("creates a DRAFT ticket carrying both refactor skills and a behaviour-preserving AC (no code edits)", () => {
    const repo = tempRepo("fg-td-draft-");
    writeFileSync(join(repo, "god.ts"), `${filler(40)}\n`);
    const config = configForRepo(repo, { coverage_command: null });
    config.loops.idle_tech_debt.god_file_lines = 20;

    const wg = new FakeDispatchClient();
    const d = deps(config, wg);
    const outcome = runIdleTechDebtLoop(d);
    expect(outcome.status).toBe("draft_created");
    if (outcome.status !== "draft_created") throw new Error("unreachable");

    const ticket = wg.getTicket(outcome.drafts[0]!.ticketId);
    expect(ticket.ticket.status).toBe("draft");
    expect(ticket.ticket.description).toMatch(/no code was changed/i);
    expect(ticket.ticket.description).toMatch(/refactor-module/);
    expect(ticket.ticket.description).toMatch(/minimalism/);
    // Behaviour-preserving oracle: tests green before & after, no public API change.
    expect(ticket.ticket.description).toMatch(/green BEFORE and AFTER/i);
    expect(ticket.ticket.description).toMatch(/no public API change/i);
    expect(ticket.ticket.description).toMatch(/no behaviour change/i);
    expect(ticket.ticket.description).toMatch(/hotspot/i);
    expect(ticket.repositories[0]!.name).toBe("demo");
    expect(wg.evidence).toHaveLength(0);
    expect(d.events.types()).toContain("tech_debt_scanned");
    expect(d.events.types()).toContain("idle_ticket_created");
  });

  it("skips when ready tickets exist (an idle tick only fires with no ready work)", () => {
    const repo = tempRepo("fg-td-ready-");
    writeFileSync(join(repo, "x.ts"), `${filler(40)}\n`);
    const config = configForRepo(repo, { coverage_command: null });
    config.loops.idle_tech_debt.god_file_lines = 20;
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "ready", status: "ready" });
    expect(runIdleTechDebtLoop(deps(config, wg)).status).toBe("skipped_tickets_ready");
  });

  it("creates ONE draft when the same repo is scanned twice (dedup)", () => {
    const repo = tempRepo("fg-td-dedup-");
    writeFileSync(join(repo, "god.ts"), `${filler(40)}\n`);
    const config = configForRepo(repo, { coverage_command: null });
    config.loops.idle_tech_debt.god_file_lines = 20;

    const wg = new FakeDispatchClient();
    const first = runIdleTechDebtLoop(deps(config, wg));
    expect(first.status).toBe("draft_created");
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);

    const secondDeps = deps(configForRepo(repo, { coverage_command: null }), wg);
    secondDeps.config.loops.idle_tech_debt.god_file_lines = 20;
    const second = runIdleTechDebtLoop(secondDeps);
    expect(wg.events.filter((e) => e.type === "draft_ticket.created")).toHaveLength(1);
    expect(second.status).toBe("no_findings");
    expect(secondDeps.events.types()).toContain("idle_finding_deduped");
    expect(secondDeps.events.types()).not.toContain("idle_ticket_created");
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
    expect(ran).toContain("type_quality");
    expect(ran).toContain("dependency_hygiene");
    expect(ran).toContain("security_hotspot");
    expect(ran).toContain("tech_debt");
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
    config.loops.idle_type_quality.enabled = false;
    config.loops.idle_dependencies.enabled = false;
    config.loops.idle_coverage.enabled = false;
    config.loops.idle_security_hotspot.enabled = false;
    config.loops.idle_tech_debt.enabled = false;
    const report = runIdleLoops(deps(config, wg));
    expect(report.loops).toHaveLength(0);
  });
});

describe("maintenance lane (A4) — registry wiring", () => {
  function cursorPath(): string {
    return join(tempRepo("fg-maint-cursor-"), "cursor.json");
  }

  it("runs only the ONE scheduler-chosen loop and logs the choice", () => {
    const repo = tempRepo("fg-maint-run-");
    // A real security finding so the chosen lane has something to draft.
    writeFileSync(join(repo, "h.ts"), `eval(req.body);\n`);
    const wg = new FakeDispatchClient();
    // Only security + documentation enabled → security wins on priority/first-run.
    const config = configForRepo(repo, { coverage_command: null });
    config.loops.idle_coverage.enabled = false;
    config.loops.idle_test_quality.enabled = false;
    config.loops.idle_type_quality.enabled = false;
    config.loops.idle_dependencies.enabled = false;
    config.loops.idle_tech_debt.enabled = false;
    // security_hotspot + documentation remain enabled by configForRepo.
    const d = deps(config, wg);

    const report = runMaintenanceLane(d, cursorPath());
    expect(report.chosen).toBe("security_hotspot");
    expect(report.outcome?.status).toBe("draft_created");
    // The choice is logged (auditable) + only the chosen loop ran.
    expect(d.events.types()).toContain("maintenance_lane_chosen");
    expect(d.events.types()).toContain("security_hotspot_scanned");
    // The documentation loop was NOT run this tick (single-lane per idle tick).
    expect(d.events.types()).not.toContain("documentation_scanned");
  });

  it("persists the rotation cursor so consecutive ticks pick different lanes", () => {
    const repo = tempRepo("fg-maint-rotate-");
    const wg = new FakeDispatchClient();
    const config = configForRepo(repo, { coverage_command: null });
    config.loops.idle_coverage.enabled = false;
    config.loops.idle_test_quality.enabled = false;
    config.loops.idle_type_quality.enabled = false;
    config.loops.idle_dependencies.enabled = false;
    config.loops.idle_tech_debt.enabled = false;
    // security_hotspot + documentation enabled.
    const path = cursorPath();

    const first = runMaintenanceLane(deps(config, wg), path);
    const second = runMaintenanceLane(deps(config, wg), path);
    expect(first.chosen).toBe("security_hotspot");
    expect(second.chosen).toBe("documentation"); // rotated, cursor persisted
  });

  it("reports chosen:null when no maintenance lane is enabled", () => {
    const repo = tempRepo("fg-maint-none-");
    const wg = new FakeDispatchClient();
    const config = configForRepo(repo, { coverage_command: null });
    config.loops.idle_documentation.enabled = false;
    config.loops.idle_test_quality.enabled = false;
    config.loops.idle_type_quality.enabled = false;
    config.loops.idle_dependencies.enabled = false;
    config.loops.idle_coverage.enabled = false;
    config.loops.idle_security_hotspot.enabled = false;
    config.loops.idle_tech_debt.enabled = false;

    const d = deps(config, wg);
    const report = runMaintenanceLane(d, cursorPath());
    expect(report.chosen).toBeNull();
    expect(report.outcome).toBeNull();
    expect(d.events.types()).toContain("maintenance_lane_finished");
  });

  it("skips when ready tickets exist (the chosen loop's own guard fires)", () => {
    const repo = tempRepo("fg-maint-ready-");
    writeFileSync(join(repo, "h.ts"), `eval(req.body);\n`);
    const wg = new FakeDispatchClient();
    wg.seedTicket({ title: "ready", status: "ready" });
    const config = configForRepo(repo, { coverage_command: null });
    const report = runMaintenanceLane(deps(config, wg), cursorPath());
    // A lane is still chosen, but its own queue-skip guard short-circuits it.
    expect(report.outcome?.status).toBe("skipped_tickets_ready");
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
    expect(config.loops.idle_type_quality.enabled).toBe(false);
    expect(config.loops.idle_tech_debt.enabled).toBe(false);

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
    expect(ran).not.toContain("tech_debt");
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
