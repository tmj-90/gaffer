// CHANGE IMPACT (Release A, A5 M subset): the Behavioural surface of a delivery, read
// deterministically from the review diff's lines and the tree at the head commit. Every fact
// names its method; what is not computed is said as "not analysed"; nothing gates on it.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { computeRepoImpact, type ImpactFact } from "../src/services/changeImpact.js";
import { observedRisk } from "../src/services/observedRisk.js";

const human: Actor = { type: "human", id: "tom" };

/** A unified diff of one file: `+`/`-` lines in one hunk starting at line 1. */
function fileDiff(
  path: string,
  lines: string[],
  opts: { added?: boolean; deleted?: boolean } = {},
): string {
  const head = [
    `diff --git a/${path} b/${path}`,
    opts.added
      ? "new file mode 100644"
      : opts.deleted
        ? "deleted file mode 100644"
        : "index 1..2 100644",
    `--- ${opts.added ? "/dev/null" : `a/${path}`}`,
    `+++ ${opts.deleted ? "/dev/null" : `b/${path}`}`,
    `@@ -1,${lines.length} +1,${lines.length} @@`,
  ];
  return [...head, ...lines].join("\n");
}

const kinds = (facts: ImpactFact[], kind: string) =>
  facts.filter((f) => f.kind === kind).map((f) => f.text);

describe("CHANGE IMPACT from the diff's lines (no git)", () => {
  const diff = [
    fileDiff("src/invoice.ts", [
      "+export function calculateInvoice(total: number) {",
      "-export function legacyTotal() {",
      "-export const RATE = 1;",
      "+export const RATE = 2;",
      " const x = 1;",
      "+  const key = process.env.INVOICE_API_KEY;",
      "-  const old = process.env.OLD_FLAG;",
      "+app.post('/invoice', handler);",
    ]),
    fileDiff("tools/report.py", ["+def build_report(rows):", "+class Report:", "+def _private():"]),
    fileDiff("db/migrations/0042_add_total.sql", ["+ALTER TABLE invoices ADD COLUMN total INT;"], {
      added: true,
    }),
    fileDiff("src/schema.ts", [
      "+  CREATE TABLE IF NOT EXISTS ledger (",
      "+  // create table later",
    ]),
    fileDiff("README.md", ["+CREATE TABLE in prose does not count"]),
    fileDiff("tsconfig.json", ['+  "strict": true,']),
    fileDiff(".env.example", ["+PAYMENTS_URL=http://localhost", "-LEGACY_URL=x"]),
    fileDiff("package.json", [
      '+    "zod": "^4.1.0",',
      '-    "zod": "^3.22.0",',
      '+    "left-pad": "1.3.0",',
      '-    "moment": "2.29.4",',
      '+  "version": "1.2.0",',
      '+    "test": "vitest run",',
    ]),
    fileDiff("requirements.txt", ["+requests>=2.31", "-flask==2.0.0", "+flask==3.0.0"]),
    fileDiff("go.mod", ["+require github.com/pkg/errors v0.9.1"]),
    fileDiff("pnpm-lock.yaml", ["+lockfileVersion: '9.0'"]),
    fileDiff("dist/index.js", ["+export const built = 1;"]),
  ].join("\n");

  const impact = computeRepoImpact({
    diff,
    truncated: false,
    headSha: null,
    downstream: [{ repo: "billing-ui", via: "billing-ui depends_on invoices" }],
  });

  it("exports added, removed and changed, labelled from the diff's lines", () => {
    expect(kinds(impact.facts, "export_added")).toEqual([
      "export function calculateInvoice added",
      "def build_report added",
      "class Report added",
    ]);
    expect(kinds(impact.facts, "export_removed")).toEqual(["export function legacyTotal removed"]);
    expect(kinds(impact.facts, "export_changed")).toEqual([
      "export const RATE: declaration line changed",
    ]);
    const f = impact.facts.find((x) => x.text === "export function calculateInvoice added")!;
    expect(f).toMatchObject({ path: "src/invoice.ts", line: 1, method: "from the diff's lines" });
    // A generated file's exports are not the delivery's API.
    expect(impact.facts.some((x) => x.text.includes("built"))).toBe(false);
  });

  it("migration files by path and DDL statements from the diff's lines", () => {
    expect(kinds(impact.facts, "migration")).toEqual([
      "Migration file added: db/migrations/0042_add_total.sql",
    ]);
    expect(kinds(impact.facts, "ddl")).toEqual([
      "DDL added: ALTER TABLE invoices ADD COLUMN total INT",
      "DDL added: CREATE TABLE IF NOT EXISTS ledger",
    ]);
  });

  it("config files by path, environment variables and .env example keys", () => {
    expect(kinds(impact.facts, "config")).toEqual([
      "Config file changed: tsconfig.json",
      "Config file changed: .env.example",
    ]);
    expect(kinds(impact.facts, "env_added")).toEqual([
      "Reads environment variable INVOICE_API_KEY (new in this change)",
      "PAYMENTS_URL added to .env.example",
    ]);
    expect(kinds(impact.facts, "env_removed")).toEqual([
      "No longer reads environment variable OLD_FLAG",
      "LEGACY_URL removed from .env.example",
    ]);
  });

  it("dependency entries added, removed and bumped from the manifest diff", () => {
    expect(kinds(impact.facts, "dependency_added")).toEqual([
      "Dependency added: left-pad 1.3.0",
      "Dependency added: requests >=2.31",
      "Dependency added: github.com/pkg/errors v0.9.1",
    ]);
    expect(kinds(impact.facts, "dependency_removed")).toEqual([
      "Dependency removed: moment 2.29.4",
    ]);
    expect(kinds(impact.facts, "dependency_bumped")).toEqual([
      "Dependency changed: zod ^3.22.0 → ^4.1.0",
      "Dependency changed: flask ==2.0.0 → ==3.0.0",
    ]);
    expect(impact.facts.find((x) => x.kind === "dependency_added")!.method).toBe(
      "from the manifest diff",
    );
  });

  it("generated files: lockfiles and dist/ by path", () => {
    expect(kinds(impact.facts, "generated")).toEqual([
      "Lockfile changed: pnpm-lock.yaml",
      "Generated file changed: dist/index.js",
    ]);
  });

  it("routes by pattern match, downstream repos from the scope graph", () => {
    expect(impact.facts.filter((f) => f.kind === "route")).toEqual([
      expect.objectContaining({ text: "Route POST /invoice added", method: "pattern match" }),
    ]);
    expect(impact.facts.filter((f) => f.kind === "downstream_repo")).toEqual([
      {
        kind: "downstream_repo",
        text: "billing-ui may be affected: billing-ui depends_on invoices",
        path: null,
        line: null,
        method: "scope graph depends_on",
      },
    ]);
  });

  it("says what it did not analyse, and never claims callers", () => {
    expect(impact.not_analysed).toContain(
      "Tests importing the changed modules: not analysed (the head commit could not be read).",
    );
    expect(impact.not_analysed).toContain(
      "Callers of changed symbols and their test coverage: not analysed.",
    );
    expect(impact.none).toEqual([]);
  });

  it("a plain source change finds no migration, config, env or dependency change and says so", () => {
    const quiet = computeRepoImpact({
      diff: fileDiff("src/a.ts", ["+const a = 2;", "-const a = 1;"]),
      truncated: true,
      headSha: null,
    });
    expect(quiet.facts).toEqual([]);
    expect(quiet.none).toEqual([
      "migration or DDL",
      "config",
      "environment variable",
      "dependency",
    ]);
    expect(quiet.not_analysed).toContain(
      "The diff was cut at its size cap: files past the cut are not analysed.",
    );
  });
});

describe("CHANGE IMPACT against a real repo (the tree at the head)", () => {
  let dir: string;
  let wg: Dispatch;
  afterEach(() => {
    wg?.db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };

  function deliveredRepo(): string {
    dir = mkdtempSync(join(tmpdir(), "impact-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    write("src/tasks.ts", "export const a = 1;\n");
    write("src/other.ts", "export const o = 1;\n");
    write("src/lonely.ts", "export const l = 1;\n");
    write("test/tasks.test.ts", "import { a } from '../src/tasks.js';\n");
    write("test/other.test.ts", 'import { o } from "../src/other";\n');
    write(".gitattributes", "gen/** linguist-generated\n");
    write("gen/api.ts", "export const g = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feat/x");
    write("src/tasks.ts", "export const a = 1;\nexport function clearDone() {}\n");
    write("src/other.ts", "export const o = 2;\n");
    write("src/lonely.ts", "export const l = 2;\n");
    write("test/tasks.test.ts", "import { a, clearDone } from '../src/tasks.js';\n");
    write("gen/api.ts", "export const g = 2;\n");
    git("commit", "-qam", "deliver");
    git("checkout", "-q", "main");
    return dir;
  }

  function ticketOn(path: string): string {
    wg = Dispatch.open(":memory:");
    const repo = wg.registerRepository(
      { name: "svc", default_branch: "main", local_path: path },
      human,
    );
    const t = wg.createTicket({ title: "deliver", policy_pack: "solo_loose" }, human);
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
      human,
    );
    wg.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: "feat/x" }, human);
    return t.id;
  }

  it("changed modules no test in the change imports, by import text over the head's tests", () => {
    const id = ticketOn(deliveredRepo());
    const rd = wg.ticketDiff(id, { impact: true }).repos[0]!;
    const untested = rd.impact!.facts.filter((f) => f.kind === "untested_module");
    expect(untested.map((f) => [f.path, f.text, f.method])).toEqual([
      [
        "src/lonely.ts",
        "src/lonely.ts changed and no test file in this change imports it (no test file at the head imports it)",
        "by import text",
      ],
      [
        "src/other.ts",
        "src/other.ts changed and no test file in this change imports it (1 unchanged test file imports it)",
        "by import text",
      ],
    ]);
    // tasks.ts is imported by a test that changed with it: not listed.
    expect(untested.some((f) => f.path === "src/tasks.ts")).toBe(false);
    // The head's .gitattributes marks gen/ generated.
    expect(rd.impact!.facts.filter((f) => f.kind === "generated")).toEqual([
      expect.objectContaining({ path: "gen/api.ts", method: "by .gitattributes" }),
    ]);
    expect(
      rd.impact!.facts.find((f) => f.text === "export function clearDone added"),
    ).toMatchObject({ path: "src/tasks.ts", line: 2 });
  });

  it("is opt-in and advisory: the plain diff carries no impact and the risk read is unchanged", () => {
    const id = ticketOn(deliveredRepo());
    const plain = wg.ticketDiff(id);
    const withImpact = wg.ticketDiff(id, { impact: true });
    expect(plain.repos[0]!.impact).toBeUndefined();
    expect(withImpact.repos[0]!.riskAnnotations).toEqual(plain.repos[0]!.riskAnnotations);
    expect(observedRisk(withImpact.repos)).toEqual(observedRisk(plain.repos));
  });

  it("downstream repos come from the scope graph's depends_on edges", () => {
    const id = ticketOn(deliveredRepo());
    const ui = wg.registerRepository({ name: "tasks-ui", default_branch: "main" }, human);
    const api = wg.createScopeNode({ name: "tasks-api", type: "service" }, human);
    const web = wg.createScopeNode({ name: "tasks-web", type: "service" }, human);
    const svc = wg.repos.findByName("svc")!;
    wg.linkScopeRepo({ scope_node_id: api.id, repo_id: svc.id, relation: "owns" }, human);
    wg.linkScopeRepo({ scope_node_id: web.id, repo_id: ui.id, relation: "owns" }, human);
    wg.createScopeEdge({ from_node_id: web.id, to_node_id: api.id, relation: "depends_on" }, human);
    const facts = wg.ticketDiff(id, { impact: true }).repos[0]!.impact!.facts;
    expect(facts.filter((f) => f.kind === "downstream_repo").map((f) => f.text)).toEqual([
      "tasks-ui may be affected: tasks-web depends_on tasks-api",
    ]);
  });
});
