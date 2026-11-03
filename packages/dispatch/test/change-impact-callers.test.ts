// CHANGE IMPACT, callers row (delta roadmap gap 1): for each changed exported symbol, the
// files that import it and the tests of it, from the code index (memory `index neighbours`).
// Labelled "by import text (index)"; listed only when the index describes the base tip;
// missing / stale / unreadable said as "not analysed" with the reason. Advisory: the risk
// read is unchanged.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { writeEvent } from "../src/events/eventWriter.js";
import { readReviewMeasures } from "../src/health/reviewMeasures.js";
import { computeRepoImpact, parseDiffFiles } from "../src/services/changeImpact.js";
import {
  resolveCodeIndexReader,
  type CodeIndexItem,
  type CodeIndexQuery,
  type CodeIndexReader,
  type CodeIndexResult,
} from "../src/services/codeIndexReader.js";
import { defaultGitRunner } from "../src/services/diffService.js";
import { observedRisk } from "../src/services/observedRisk.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system", id: "runner" };
const HERE = dirname(fileURLToPath(import.meta.url));
const MEMORY_BIN = resolve(HERE, "../../memory/dist/bin/memory.js");

const item = (over: Partial<CodeIndexItem>): CodeIndexItem => ({
  query: "",
  path: null,
  symbol: null,
  exportedAs: null,
  note: null,
  callers: [],
  callersTotal: 0,
  callersTested: 0,
  tests: [],
  testsTotal: 0,
  moduleTestsTotal: 0,
  ...over,
});
const fresh = (items: CodeIndexItem[], commit = "base1234"): CodeIndexResult => ({
  status: "fresh",
  method: "by import text (index)",
  build: { commit, builtAt: "2026-11-03T00:00:00Z", files: 10 },
  against: commit,
  items,
});

/** A body-only change to calculateInvoice: the hunk header names the declaration. */
const BODY_DIFF = [
  "diff --git a/src/invoice.ts b/src/invoice.ts",
  "index 1..2 100644",
  "--- a/src/invoice.ts",
  "+++ b/src/invoice.ts",
  "@@ -10,4 +10,4 @@ export function calculateInvoice(lines: number[]): number {",
  "   const sum = lines.reduce((a, b) => a + b, 0);",
  "-  return Math.round(sum);",
  "+  return Math.round(sum * 100) / 100;",
  " }",
  " ",
  "@@ -30,3 +30,3 @@ function helper() {",
  "-  return 1;",
  "+  return 2;",
  " }",
].join("\n");

describe("changed symbols: declaration lines and changed bodies", () => {
  it("attributes a changed body line to its enclosing top-level declaration", () => {
    const [f] = parseDiffFiles(BODY_DIFF);
    expect([...f!.touched.entries()]).toEqual([
      ["calculateInvoice", 11],
      ["helper", 30],
    ]);
  });

  it("follows the column-0 declarations a hunk passes, and ignores blank and comment lines", () => {
    const diff = [
      "diff --git a/m.py b/m.py",
      "--- a/m.py",
      "+++ b/m.py",
      "@@ -1,9 +1,10 @@",
      " def first():",
      "-    return 1",
      "+    return 2",
      " ",
      "+# a comment",
      "+",
      " class Second:",
      "     def method(self):",
      "+        pass",
      " x = 1",
      "+    y = 2",
    ].join("\n");
    const [f] = parseDiffFiles(diff);
    // `x = 1` ends Second; the indented line after it is under no declaration.
    expect([...f!.touched.keys()]).toEqual(["first", "Second"]);
  });
});

describe("CALLERS from the code index (fake reader)", () => {
  const asked: CodeIndexQuery[] = [];
  const reader =
    (answer: ReturnType<CodeIndexReader>): CodeIndexReader =>
    (q) => {
      asked.push(q);
      return answer;
    };
  afterEach(() => {
    asked.length = 0;
  });

  it("lists callers with counts, in-change and tested flags, and the module's tests", () => {
    const r = computeRepoImpact({
      diff: BODY_DIFF,
      truncated: false,
      headSha: null,
      localPath: "/repo",
      baseBranch: "main",
      baseSha: "base1234",
      paths: ["src/invoice.ts", "src/api.ts"],
      codeIndex: reader({
        ok: true,
        result: fresh([
          item({ query: "src/invoice.ts", path: "src/invoice.ts", testsTotal: 1 }),
          item({
            query: "src/invoice.ts#calculateInvoice",
            path: "src/invoice.ts",
            symbol: "calculateInvoice",
            exportedAs: "calculateInvoice",
            callers: [
              {
                path: "src/api.ts",
                via: "barrel",
                through: "src/index.ts",
                line: 1,
                tested: false,
              },
              { path: "src/report.ts", via: "name", through: null, line: 3, tested: true },
            ],
            callersTotal: 2,
            callersTested: 1,
            tests: [{ path: "test/invoice.test.ts", via: "import", through: null }],
            testsTotal: 1,
            moduleTestsTotal: 1,
          }),
          item({
            query: "src/invoice.ts#helper",
            path: "src/invoice.ts",
            symbol: "helper",
            note: "not exported (no other module can import it by name)",
          }),
        ]),
      }),
    });
    expect(asked).toEqual([
      {
        localPath: "/repo",
        paths: ["src/invoice.ts"],
        symbols: ["src/invoice.ts#calculateInvoice", "src/invoice.ts#helper"],
        commit: "base1234",
        perItem: 10,
      },
    ]);
    const facts = r.facts.filter((f) => f.kind === "symbol_callers");
    expect(facts).toEqual([
      {
        kind: "symbol_callers",
        text: "calculateInvoice changed: 2 files on main import it, 1 not changed here; 1 of the 2 has a test that imports it; 1 test imports it or is named for it",
        path: "src/invoice.ts",
        line: 11,
        method: "by import text (index)",
        refs: [
          {
            path: "src/api.ts",
            role: "caller",
            in_change: true,
            tested: false,
            through: "src/index.ts",
            line: 1,
          },
          {
            path: "src/report.ts",
            role: "caller",
            in_change: false,
            tested: true,
            through: null,
            line: 3,
          },
          {
            path: "test/invoice.test.ts",
            role: "test",
            in_change: false,
            tested: null,
            through: null,
            line: null,
          },
        ],
      },
    ]);
    expect(r.callers).toEqual({ status: "listed", reason: null, index_commit: "base1234" });
    expect(r.not_analysed.join("\n")).not.toMatch(/Callers of changed symbols/);
    // No test in the change imports invoice.ts: the rule adds the index's count at the base.
    expect(r.facts.find((f) => f.kind === "untested_module")).toBeUndefined(); // no head to grep
  });

  it("a removed export lists the files that still import it", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,1 @@",
      "-export function gone() {}",
      " export const kept = 1;",
    ].join("\n");
    const r = computeRepoImpact({
      diff,
      truncated: false,
      headSha: null,
      localPath: "/repo",
      baseBranch: "main",
      baseSha: "b",
      codeIndex: reader({
        ok: true,
        result: fresh(
          [
            item({
              query: "src/a.ts#gone",
              path: "src/a.ts",
              symbol: "gone",
              exportedAs: "gone",
              callers: [{ path: "src/b.ts", via: "name", through: null, line: 2, tested: false }],
              callersTotal: 1,
            }),
          ],
          "b",
        ),
      }),
    });
    expect(r.facts.find((f) => f.kind === "symbol_callers")?.text).toBe(
      "gone removed: 1 file on main imports it, none changed here; it has no test that imports it; no test imports it",
    );
  });

  it("not configured, missing, stale and unreadable are each said, and nothing is guessed", () => {
    const base = {
      diff: BODY_DIFF,
      truncated: false,
      headSha: null,
      localPath: "/repo",
      baseBranch: "main",
      baseSha: "tip99999",
    };
    const none = computeRepoImpact(base);
    expect(none.not_analysed).toEqual(
      expect.arrayContaining([
        "Callers of changed symbols and their test coverage: not analysed.",
        "Code index: not configured for this server (Memory is not set up).",
      ]),
    );
    expect(none.callers?.status).toBe("not_analysed");
    const missing = computeRepoImpact({
      ...base,
      codeIndex: reader({
        ok: true,
        result: { status: "missing", method: "", build: null, against: null, items: [] },
      }),
    });
    expect(missing.not_analysed).toContain(
      "Code index: none for this repo yet (it is built at onboard and refreshed after each merge).",
    );
    const stale = computeRepoImpact({
      ...base,
      codeIndex: reader({
        ok: true,
        result: {
          ...fresh(
            [
              item({
                query: "src/invoice.ts#calculateInvoice",
                exportedAs: "calculateInvoice",
                callersTotal: 3,
              }),
            ],
            "old11111",
          ),
          status: "stale",
        },
      }),
    });
    expect(stale.facts.some((f) => f.kind === "symbol_callers")).toBe(false);
    expect(stale.not_analysed).toContain(
      "Code index: stale (built at old11111; main is at tip99999), so callers are not listed.",
    );
    expect(stale.callers).toEqual({
      status: "not_analysed",
      reason: expect.any(String),
      index_commit: "old11111",
    });
    const broken = computeRepoImpact({
      ...base,
      codeIndex: reader({ ok: false, reason: "the memory CLI exited 1" }),
    });
    expect(broken.not_analysed).toContain("Code index: not read (the memory CLI exited 1).");
    const noTip = computeRepoImpact({
      ...base,
      baseSha: null,
      codeIndex: reader({ ok: true, result: fresh([]) }),
    });
    expect(noTip.not_analysed.join("\n")).toMatch(/could not be resolved/);
  });

  it("a change with no TS/JS/Python module says so; other languages stay not analysed", () => {
    const docs = computeRepoImpact({
      diff: [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
      truncated: false,
      headSha: null,
    });
    expect(docs.callers).toEqual({
      status: "none_changed",
      reason: "No TypeScript, JavaScript or Python module changed.",
      index_commit: null,
    });
    expect(docs.not_analysed.join("\n")).not.toMatch(/Callers of changed symbols/);
    const go = computeRepoImpact({
      diff: [
        "diff --git a/main.go b/main.go",
        "--- a/main.go",
        "+++ b/main.go",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n"),
      truncated: false,
      headSha: null,
    });
    expect(go.not_analysed).toContain(
      "Exports, callers and test imports outside TypeScript, JavaScript and Python: not analysed.",
    );
  });
});

describe("CALLERS against a real repo and the real memory CLI", () => {
  let dir: string;
  let mem: string;
  let wg: Dispatch;
  afterEach(() => {
    wg?.db.close();
    for (const d of [dir, mem]) if (d) rmSync(d, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const memoryEnv = () => ({
    ...process.env,
    MEMORY_CLI_BIN: MEMORY_BIN,
    MEMORY_DB: join(mem, "memory.sqlite"),
  });
  const buildIndex = () =>
    execFileSync(process.execPath, [MEMORY_BIN, "index", "build", `--repo-root=${dir}`, "--json"], {
      encoding: "utf8",
      env: memoryEnv(),
    });

  function setup(): string {
    dir = mkdtempSync(join(tmpdir(), "impact-callers-"));
    mem = mkdtempSync(join(tmpdir(), "impact-callers-mem-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    write(
      "src/invoice.ts",
      "export function calculateInvoice(lines: number[]): number {\n  const sum = lines.reduce((a, b) => a + b, 0);\n  return Math.round(sum);\n}\n\nexport const TAX = 0.2;\n",
    );
    write("src/index.ts", "export { calculateInvoice } from './invoice';\n");
    write(
      "src/api.ts",
      "import { calculateInvoice } from './index';\nexport const api = (l: number[]) => calculateInvoice(l);\n",
    );
    write(
      "src/report.ts",
      "import { calculateInvoice } from './invoice.js';\nexport const report = calculateInvoice([1]);\n",
    );
    write("src/tax.ts", "import { TAX } from './invoice';\nexport const t = TAX;\n");
    write("test/report.test.ts", "import { report } from '../src/report';\nreport;\n");
    write(
      "test/invoice.test.ts",
      "import { calculateInvoice } from '../src/invoice';\ncalculateInvoice([]);\n",
    );
    git("add", "-A");
    git("commit", "-qm", "base");
    buildIndex();
    git("checkout", "-qb", "feat/x");
    write(
      "src/invoice.ts",
      "export function calculateInvoice(lines: number[]): number {\n  const sum = lines.reduce((a, b) => a + b, 0);\n  return Math.round(sum * 100) / 100;\n}\n\nexport const TAX = 0.2;\n",
    );
    write(
      "src/api.ts",
      "import { calculateInvoice } from './index';\nexport const api = (l: number[]) => calculateInvoice(l) + 0;\n",
    );
    git("commit", "-qam", "deliver");
    git("checkout", "-q", "main");
    wg = Dispatch.open(":memory:", undefined, defaultGitRunner, {
      codeIndex: resolveCodeIndexReader(memoryEnv()),
    });
    const repo = wg.registerRepository(
      { name: "svc", default_branch: "main", local_path: dir },
      human,
    );
    const t = wg.createTicket({ title: "rounding", policy_pack: "solo_loose" }, human);
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
      human,
    );
    wg.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: "feat/x" }, human);
    return t.id;
  }

  it("lists the changed symbol's callers through a barrel, and the module's tests", () => {
    expect(existsSync(MEMORY_BIN)).toBe(true);
    const id = setup();
    const rd = wg.ticketDiff(id, { impact: true }).repos[0]!;
    const facts = rd.impact!.facts.filter((f) => f.kind === "symbol_callers");
    expect(facts.map((f) => f.text)).toEqual([
      // api.ts's changed line is in the body of `export const api` (files in diff order).
      "api changed: no file on main imports it; no test imports it",
      "calculateInvoice changed: 2 files on main import it, 1 not changed here; 1 of the 2 has a test that imports it; 1 test imports it or is named for it",
    ]);
    expect(
      facts[1]!.refs!.map(
        (r) =>
          `${r.role} ${r.path}${r.in_change ? " (changed)" : ""}${r.through ? ` via ${r.through}` : ""}`,
      ),
    ).toEqual([
      "caller src/api.ts (changed) via src/index.ts",
      "caller src/report.ts",
      "test test/invoice.test.ts",
    ]);
    expect(rd.impact!.callers).toMatchObject({
      status: "listed",
      index_commit: git("rev-parse", "main"),
    });
    // No test in the change imports either module; at the base invoice.ts has one, api.ts none.
    const untested = rd.impact!.facts.filter((f) => f.kind === "untested_module");
    expect(untested.map((f) => [f.path, f.index_tests])).toEqual([
      ["src/api.ts", 0],
      ["src/invoice.ts", 1],
    ]);
    expect(untested[1]!.text).toMatch(/; 1 test on main imports it or is named for it \(index\)$/);
    expect(untested[0]!.text).toMatch(
      /and no test on main imports it or is named for it \(index\)$/,
    );
    // Advisory: the risk read does not see the new facts.
    expect(observedRisk(wg.ticketDiff(id, { impact: true }).repos)).toEqual(
      observedRisk(wg.ticketDiff(id).repos),
    );
  });

  it("a base that moved past the index says stale and lists nothing", () => {
    const id = setup();
    write("src/late.ts", "export const late = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "outside the factory");
    const rd = wg.ticketDiff(id, { impact: true }).repos[0]!;
    expect(rd.impact!.facts.some((f) => f.kind === "symbol_callers")).toBe(false);
    expect(rd.impact!.not_analysed.join("\n")).toMatch(
      /Code index: stale \(built at \w{8}; main is at \w{8}\)/,
    );
    // Refreshing the index (as the runner does after a merge) makes it fresh again.
    buildIndex();
    const again = wg.ticketDiff(id, { impact: true }).repos[0]!;
    // Only a fresh answer is cached, so the refreshed index is read at once.
    expect(again.impact!.callers?.status).toBe("listed");
  });

  it("the review open records what the callers row showed", () => {
    const id = setup();
    wg.db.prepare("UPDATE tickets SET status='in_review' WHERE id=?").run(id);
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: id,
      actor: system,
      event_type: "ticket.transitioned",
      payload: { from: "in_progress", to: "in_review", reason: "submitted" },
    });
    wg.ticketDiff(id, { impact: true });
    expect(wg.recordReviewOpened(id, human).recorded).toBe(true);
    const row = wg.db
      .prepare(
        "SELECT payload_json FROM work_events WHERE entity_id = ? AND event_type = 'ticket.review_opened'",
      )
      .get(id) as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({ impact_callers: "listed" });
    // Health's share counts only the opens that recorded it.
    expect(readReviewMeasures(wg.db).impact_callers).toEqual({
      opens: 1,
      known: 1,
      listed: 1,
      none_changed: 0,
      not_analysed: 0,
      listed_pct: 100,
    });
  });
});
