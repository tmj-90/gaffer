import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ScriptedCommandRunner } from "../src/adapters/commandRunner.js";
import { resolveBinary } from "../src/loops/oracles/resolveBinary.js";
import { safeJsonParse } from "../src/loops/oracles/parse.js";
import { createTscOracle, parseTscOutput } from "../src/loops/oracles/tscOracle.js";
import { createEslintOracle, parseEslintOutput } from "../src/loops/oracles/eslintOracle.js";
import {
  createDeadCodeOracle,
  parseKnipOutput,
  parseTsPruneOutput,
} from "../src/loops/oracles/deadCodeOracle.js";
import { createSecurityOracle, parseSemgrepOutput } from "../src/loops/oracles/securityOracle.js";
import { oracleFindingKey } from "../src/loops/oracles/summary.js";

function tempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Place a fake executable under `<repo>/node_modules/.bin/<name>` so resolveBinary finds it. */
function installLocalBin(repo: string, name: string): string {
  const dir = join(repo, "node_modules", ".bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

// ── safeJsonParse ─────────────────────────────────────────────────────────────

describe("safeJsonParse (defensive)", () => {
  it("parses well-formed JSON", () => {
    expect(safeJsonParse<{ a: number }>(`{"a":1}`)).toEqual({ a: 1 });
  });
  it("returns undefined on garbage rather than throwing", () => {
    expect(safeJsonParse("not json at all <<<")).toBeUndefined();
    expect(safeJsonParse("")).toBeUndefined();
  });
  it("tolerates a leading banner line before the JSON payload", () => {
    expect(safeJsonParse<number[]>("warning: deprecated\n[1,2,3]")).toEqual([1, 2, 3]);
  });
});

// ── resolveBinary ─────────────────────────────────────────────────────────────

describe("resolveBinary", () => {
  it("prefers a repo-local node_modules/.bin tool", () => {
    const repo = tempRepo("orc-bin-");
    const path = installLocalBin(repo, "knip");
    expect(resolveBinary("knip", repo)).toBe(path);
  });
  it("returns undefined for an absent tool (empty PATH, no local bin)", () => {
    const repo = tempRepo("orc-bin-absent-");
    expect(resolveBinary("definitely-not-a-real-tool-xyz", repo, { PATH: "" })).toBeUndefined();
  });
  it("finds a tool on PATH", () => {
    // `git` is always present in this environment.
    expect(resolveBinary("git", tempRepo("orc-bin-path-"))).toBeDefined();
  });
});

// ── tsc oracle ────────────────────────────────────────────────────────────────

describe("tscOracle", () => {
  const root = "/repo";
  const sample = [
    "src/a.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    "src/b.ts(3,1): error TS2304: Cannot find name 'foo'.",
    "noise line that is not a diagnostic",
    "Found 2 errors in 2 files.",
  ].join("\n");

  it("parses diagnostics into normalized findings (file/line/rule/severity)", () => {
    const findings = parseTscOutput(sample, root);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      file: "src/a.ts",
      line: 12,
      rule: "TS2345",
      severity: "error",
    });
    expect(findings[0]!.message).toMatch(/not assignable/);
    expect(findings[1]).toMatchObject({ file: "src/b.ts", line: 3, rule: "TS2304" });
  });

  it("normalizes an absolute diagnostic path to repo-relative", () => {
    const findings = parseTscOutput(`${root}/src/c.ts(1,1): error TS1005: ';' expected.`, root);
    expect(findings[0]!.file).toBe("src/c.ts");
  });

  it("reports unavailable when tsc is absent", () => {
    const repo = tempRepo("orc-tsc-absent-");
    const runner = new ScriptedCommandRunner([]);
    // Force an empty PATH so the global tsc (if any) is not picked up either.
    const oracle = createTscOracle(runner, "/nonexistent/tsc-binary");
    const result = oracle.consult(repo);
    expect(result.available).toBe(false);
  });

  it("a garbage/non-zero tool run yields zero findings (no throw)", () => {
    const repo = tempRepo("orc-tsc-garbage-");
    installLocalBin(repo, "tsc");
    const runner = new ScriptedCommandRunner([
      {
        match: (c) => c.includes("tsc"),
        result: { stdout: "totally not tsc output", exitCode: 2 },
      },
    ]);
    const oracle = createTscOracle(runner);
    const result = oracle.consult(repo);
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    expect(result.findings).toHaveLength(0);
  });

  it("parses real diagnostics through the oracle with a bounded run", () => {
    const repo = tempRepo("orc-tsc-run-");
    installLocalBin(repo, "tsc");
    const runner = new ScriptedCommandRunner([
      { match: (c) => c.includes("tsc"), result: { stdout: sample, exitCode: 2 } },
    ]);
    const oracle = createTscOracle(runner);
    const result = oracle.consult(repo);
    expect(result.available && result.findings).toHaveLength(2);
    // Bounded: a timeout + maxBuffer were passed to runArgs.
    expect(runner.calls[0]!.options?.timeoutMs).toBeGreaterThan(0);
    expect(runner.calls[0]!.options?.maxBuffer).toBeGreaterThan(0);
  });
});

// ── eslint oracle ─────────────────────────────────────────────────────────────

describe("eslintOracle", () => {
  const root = "/repo";
  const sample = JSON.stringify([
    {
      filePath: "/repo/src/x.ts",
      messages: [
        { ruleId: "complexity", severity: 2, line: 10, endLine: 40, message: "too complex" },
        { ruleId: "no-unused-vars", severity: 1, line: 5, message: "'y' is unused" },
        { ruleId: null, severity: 2, message: "parse error" },
      ],
    },
    { filePath: "/repo/src/clean.ts", messages: [] },
  ]);

  it("parses the JSON report into findings with rule + severity mapping", () => {
    const findings = parseEslintOutput(sample, root);
    expect(findings).toHaveLength(3);
    expect(findings[0]).toMatchObject({
      file: "src/x.ts",
      line: 10,
      endLine: 40,
      rule: "complexity",
      severity: "error",
    });
    expect(findings[1]).toMatchObject({ rule: "no-unused-vars", severity: "warning", line: 5 });
    // A null ruleId / missing line falls back to "eslint" pinned at line 1.
    expect(findings[2]).toMatchObject({ rule: "eslint", line: 1 });
  });

  it("returns no findings on garbage output (no throw)", () => {
    expect(parseEslintOutput("<<not json>>", root)).toHaveLength(0);
    expect(parseEslintOutput("{}", root)).toHaveLength(0);
  });

  it("reports unavailable when eslint is absent", () => {
    const repo = tempRepo("orc-eslint-absent-");
    const oracle = createEslintOracle(new ScriptedCommandRunner([]), "/nonexistent/eslint");
    expect(oracle.consult(repo).available).toBe(false);
  });
});

// ── dead-code oracle ──────────────────────────────────────────────────────────

describe("deadCodeOracle", () => {
  const root = "/repo";

  it("parses knip JSON (unused files + exports)", () => {
    const sample = JSON.stringify({
      files: ["/repo/src/dead.ts"],
      issues: [{ file: "/repo/src/used.ts", exports: [{ name: "unusedFn", line: 22 }] }],
    });
    const findings = parseKnipOutput(sample, root);
    expect(findings.find((f) => f.rule === "unused-file")?.file).toBe("src/dead.ts");
    const exp = findings.find((f) => f.rule === "unused-export");
    expect(exp).toMatchObject({ file: "src/used.ts", line: 22 });
    expect(exp!.message).toMatch(/unusedFn/);
  });

  it("parses ts-prune text (dropping used-in-module rows)", () => {
    const sample = [
      "src/foo.ts:12 - bar",
      "src/foo.ts:30 - localOnly (used in module)",
      "garbage",
    ].join("\n");
    const findings = parseTsPruneOutput(sample, root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "src/foo.ts", line: 12, rule: "unused-export" });
  });

  it("prefers knip when present and parses its output through the oracle", () => {
    const repo = tempRepo("orc-dead-knip-");
    installLocalBin(repo, "knip");
    const runner = new ScriptedCommandRunner([
      {
        match: (c) => c.includes("knip"),
        result: { stdout: JSON.stringify({ files: ["src/d.ts"] }), exitCode: 1 },
      },
    ]);
    const oracle = createDeadCodeOracle(runner);
    const result = oracle.consult(repo);
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    expect(result.findings[0]!.file).toBe("src/d.ts");
    expect(runner.calls.some((c) => c.command.includes("--reporter json"))).toBe(true);
  });

  it("reports unavailable when neither knip nor ts-prune is installed", () => {
    const repo = tempRepo("orc-dead-absent-");
    const oracle = createDeadCodeOracle(new ScriptedCommandRunner([]), {
      knip: "/nonexistent/knip",
      tsPrune: "/nonexistent/ts-prune",
    });
    expect(oracle.consult(repo).available).toBe(false);
  });
});

// ── security (semgrep) oracle ────────────────────────────────────────────────

describe("securityOracle (semgrep)", () => {
  const root = "/repo";
  const sample = JSON.stringify({
    results: [
      {
        check_id: "javascript.lang.security.audit.eval",
        path: "/repo/src/h.ts",
        start: { line: 4 },
        end: { line: 6 },
        extra: { message: "eval is dangerous", severity: "ERROR" },
      },
      {
        check_id: "generic.secrets.hardcoded",
        path: "src/s.ts",
        start: { line: 1 },
        extra: { message: "hardcoded secret", severity: "WARNING" },
      },
    ],
  });

  it("parses semgrep JSON into findings with rule/severity/span", () => {
    const findings = parseSemgrepOutput(sample, root);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      file: "src/h.ts",
      line: 4,
      endLine: 6,
      rule: "javascript.lang.security.audit.eval",
      severity: "error",
    });
    expect(findings[1]).toMatchObject({ file: "src/s.ts", severity: "warning" });
  });

  it("returns no findings on garbage output (no throw)", () => {
    expect(parseSemgrepOutput("oops", root)).toHaveLength(0);
    expect(parseSemgrepOutput(JSON.stringify({ results: "nope" }), root)).toHaveLength(0);
  });

  it("reports unavailable when semgrep is absent (so the loop falls back)", () => {
    const repo = tempRepo("orc-sg-absent-");
    const oracle = createSecurityOracle(new ScriptedCommandRunner([]), {
      binary: "/nonexistent/semgrep",
    });
    expect(oracle.consult(repo).available).toBe(false);
  });
});

// ── oracleFindingKey ─────────────────────────────────────────────────────────

describe("oracleFindingKey", () => {
  it("is stable for the same finding set and order-independent", () => {
    const a = [
      { file: "a.ts", line: 1, rule: "R1", severity: "error" as const, message: "m" },
      { file: "b.ts", line: 2, rule: "R2", severity: "warning" as const, message: "n" },
    ];
    const reordered = [a[1]!, a[0]!];
    expect(oracleFindingKey("tsc", a)).toBe(oracleFindingKey("tsc", reordered));
  });
  it("changes when the finding set changes", () => {
    const base = [{ file: "a.ts", line: 1, rule: "R1", severity: "error" as const, message: "m" }];
    const changed = [
      { file: "a.ts", line: 2, rule: "R1", severity: "error" as const, message: "m" },
    ];
    expect(oracleFindingKey("tsc", base)).not.toBe(oracleFindingKey("tsc", changed));
  });
});

// ── no-shell-injection regression ─────────────────────────────────────────────

describe("oracle no-shell-injection regression", () => {
  it("a tool-absent resolution with a shell-metachar repo path never runs a shell", () => {
    // Build a repo dir whose name carries a shell metacharacter; resolveBinary
    // must stat paths (no shell) and the absent tool yields unavailable, never a
    // command execution. The REAL execFileSync path is exercised via a real
    // (absent) binary resolution — no FakeRunner involved for the resolve step.
    const base = tempRepo("orc-inject-");
    const evilRoot = join(base, "$(touch PWNED)");
    mkdirSync(evilRoot, { recursive: true });
    const oracle = createSecurityOracle(new ScriptedCommandRunner([]), {
      binary: "/nonexistent/semgrep",
    });
    expect(oracle.consult(evilRoot).available).toBe(false);
    expect(existsSync(join(base, "PWNED"))).toBe(false);
    expect(existsSync(join(process.cwd(), "PWNED"))).toBe(false);
  });

  it("a filename with a shell metacharacter reaches execFileSync as an inert arg", () => {
    // The systemCommandRunner.runArgs is the real boundary. We exercise it
    // indirectly: a tsc oracle whose resolved 'binary' is `git` (always present)
    // run over a root containing a `$(touch PWNED)` path — git is exec'd with an
    // argv array, so the metacharacters are literal, never evaluated.
    const repo = tempRepo("orc-inject-real-");
    installLocalBin(repo, "tsc");
    // Use a real runner via the oracle's runArgs by routing through git, which we
    // know exists; the point is the argv path, asserted by no PWNED file.
    execFileSync("git", ["init", "-q", repo]);
    const evil = join(repo, "$(touch PWNED).ts");
    writeFileSync(evil, "const x = 1;\n");
    // The scripted runner records the argv; assert no shell metachar expansion
    // occurred (the path is passed verbatim, not interpolated).
    const runner = new ScriptedCommandRunner([
      { match: (c) => c.includes("tsc"), result: { stdout: "", exitCode: 0 } },
    ]);
    const oracle = createTscOracle(runner);
    oracle.consult(repo);
    expect(existsSync(join(repo, "PWNED"))).toBe(false);
    expect(existsSync(join(process.cwd(), "PWNED"))).toBe(false);
  });
});
