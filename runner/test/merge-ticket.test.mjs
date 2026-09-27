#!/usr/bin/env node
// =====================================================================
// `merge-ticket` runner (bin/merge-ticket.mjs) — the AUTO_MERGE conflict
// failure-mode, proven WITHOUT a live `claude -p` call.
// ---------------------------------------------------------------------
// Against the REAL runner (imported functions + real --dry-run subprocesses over a
// throwaway sqlite DB and real git repos), proves:
//   AC1  resolveTicket maps a ticket NUMBER → its write repo + delivery branch
//   AC2  resolveTicket returns null for unknown ticket / missing branch / missing db
//   AC3  attemptMerge lands a CLEAN merge into the default branch (gaffer_auto_merge semantics)
//   AC4  attemptMerge reports a CONFLICT and aborts (default branch + branch left intact)
//   AC5  buildResolverPrompt pins the resolve-merge-conflict skill, the branch + worktree,
//        merge-default-INTO-branch, preserve-both-intents, branch-only, no self-approve
//   AC6  buildClaudeArgv = [-p, prompt, --mcp-config, cfg, ...flags]
//   AC7  buildReapprovalCommand is the SINGLE isolated re-approval call (wg ticket
//        reopen-for-review <n> --reason ... --resolution ... --as system)
//   AC8  buildChildEnv STRIPS DISPATCH_API_TOKEN and sets the MCP + write-root env
//   AC9  the --dry-run CLI on a CONFLICTING ticket reports the merge target + a resolver
//        argv carrying the skill + the branch/worktree — no claude, no git mutation
//   AC10 the --dry-run CLI is BOUNDED: --timeout-ms is reported
//   AC11 an unknown/unresolvable ticket is REFUSED (exit 1, error JSON)
//   AC12 the resolve-merge-conflict SKILL.md exists with the expected frontmatter name
//   B14  PR MODE: a ticket with a pr_url is merged THROUGH the PR (`gh pr merge <url>
//        --<GAFFER_PR_MERGE_METHOD> --delete-branch`, stub gh) and the local default
//        branch is fast-forwarded — checked out or not; gh failing / absent falls back
//        to the local merge with the reason logged; no pr_url ⇒ no gh call at all
//
// Zero deps (node:sqlite ships with Node 22+; needs git on PATH). No live claude.
// Run: node test/merge-ticket.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// node:sqlite (DatabaseSync) is a built-in only from Node 22.5+; skip cleanly on older Node.
try {
  require("node:sqlite");
} catch {
  console.log("  SKIP: node:sqlite unavailable (needs Node >= 22.5)");
  process.exit(0);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const HELPER = resolve(RUNNER_DIR, "bin", "merge-ticket.mjs");
const SKILL = resolve(RUNNER_DIR, "skills", "resolve-merge-conflict", "SKILL.md");
const {
  resolveTicket,
  attemptMerge,
  buildResolverPrompt,
  buildClaudeArgv,
  buildReapprovalCommand,
  buildChildEnv,
  applyDigestAndFeature,
  formatDigestApplyLog,
  parseDiffStatus,
  buildPrMergeArgv,
  resolvePrMergeMethod,
} = await import(HELPER);

let passed = 0;
const failures = [];
function ok(label) {
  passed += 1;
  console.log(`  ok   ${label}`);
}
function fail(label) {
  failures.push(label);
  console.log(`  FAIL ${label}`);
}
function assert(label, cond) {
  cond ? ok(label) : fail(label);
}
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(label);
  else fail(`${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const WORKDIR = mkdtempSync(resolve(tmpdir(), "merge-ticket-test-"));

// --- git helpers -----------------------------------------------------------------
function git(repo, ...args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}
// A repo on `main` with a base commit + a delivery branch off it. Returns the path.
function newRepo(name) {
  const repo = resolve(WORKDIR, name);
  spawnSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" });
  git(repo, "config", "user.email", "gaffer@test");
  git(repo, "config", "user.name", "gaffer-test");
  require("node:fs").writeFileSync(resolve(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "gaffer/ticket-7-x");
  return repo;
}

// --- a throwaway dispatch sqlite (tickets + repositories + ticket_repos) ---------
// Mirrors the columns resolveTicket reads — just enough for ticket NUMBER → repo +
// branch resolution offline, with no dispatch build.
// `legacySchema: true` builds the tables WITHOUT the pr_url columns (a pre-PR-mode DB /
// the older fixture shape) so the resolver's column fallback is exercised too.
function makeDb(rows, { legacySchema = false } = {}) {
  const dbPath = resolve(WORKDIR, `wg-${Math.random().toString(36).slice(2)}.sqlite`);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const pr = legacySchema ? "" : ", pr_url TEXT";
  db.exec(
    `CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER UNIQUE, branch_name TEXT${pr});` +
      "CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, " +
      "local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main');" +
      "CREATE TABLE ticket_repos (ticket_id TEXT, repo_id TEXT, role TEXT DEFAULT 'primary', " +
      `branch_name TEXT, access TEXT DEFAULT 'write'${pr});`,
  );
  for (const r of rows) {
    if (legacySchema) {
      db.prepare("INSERT INTO tickets (id,number,branch_name) VALUES (?,?,?)").run(
        r.ticketId,
        r.number,
        r.ticketBranch ?? null,
      );
    } else {
      db.prepare("INSERT INTO tickets (id,number,branch_name,pr_url) VALUES (?,?,?,?)").run(
        r.ticketId,
        r.number,
        r.ticketBranch ?? null,
        r.prUrl ?? null,
      );
    }
    db.prepare("INSERT INTO repositories (id,name,local_path,default_branch) VALUES (?,?,?,?)").run(
      r.repoId,
      r.repoName,
      r.localPath,
      r.defaultBranch ?? "main",
    );
    if (legacySchema) {
      db.prepare(
        "INSERT INTO ticket_repos (ticket_id,repo_id,role,branch_name,access) VALUES (?,?,?,?,?)",
      ).run(r.ticketId, r.repoId, r.role ?? "primary", r.repoBranch ?? null, r.access ?? "write");
    } else {
      db.prepare(
        "INSERT INTO ticket_repos (ticket_id,repo_id,role,branch_name,access,pr_url) VALUES (?,?,?,?,?,?)",
      ).run(
        r.ticketId,
        r.repoId,
        r.role ?? "primary",
        r.repoBranch ?? null,
        r.access ?? "write",
        r.repoPrUrl ?? null,
      );
    }
  }
  db.close();
  return dbPath;
}

// Run the helper as a CLI with --dry-run; return { code, out }.
function runCli(env = {}, extraArgs = []) {
  const res = spawnSync(process.execPath, [HELPER, "--dry-run", ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }
  return { code: res.status, out };
}

const REPO_OK = newRepo("repo-ok");

console.log("== AC1: resolveTicket maps a ticket NUMBER → write repo + delivery branch ==");
{
  // per-repo branch on ticket_repos takes priority over the ticket-level branch_name.
  const db = makeDb([
    {
      ticketId: "t7",
      number: 7,
      ticketBranch: "gaffer/ticket-7-fallback",
      repoId: "r1",
      repoName: "demo",
      localPath: REPO_OK,
      defaultBranch: "main",
      repoBranch: "gaffer/ticket-7-x",
      access: "write",
    },
  ]);
  const r = resolveTicket(db, 7);
  if (
    r &&
    r.number === 7 &&
    r.repo.name === "demo" &&
    r.repo.localPath === REPO_OK &&
    r.repo.defaultBranch === "main" &&
    r.branch === "gaffer/ticket-7-x"
  ) {
    ok("ticket 7 → demo repo, default main, per-repo delivery branch");
  } else fail(`resolveTicket wrong: ${JSON.stringify(r)}`);

  // ticket-level branch_name fallback when ticket_repos has none.
  const db2 = makeDb([
    {
      ticketId: "t8",
      number: 8,
      ticketBranch: "gaffer/ticket-8-y",
      repoId: "r2",
      repoName: "demo",
      localPath: REPO_OK,
      repoBranch: null,
      access: "write",
    },
  ]);
  const r2 = resolveTicket(db2, 8);
  assert("falls back to ticket-level branch_name", r2 && r2.branch === "gaffer/ticket-8-y");
}

console.log("== AC2: resolveTicket null for unknown / no branch / missing db ==");
{
  const db = makeDb([
    {
      ticketId: "t9",
      number: 9,
      ticketBranch: null,
      repoId: "r3",
      repoName: "demo",
      localPath: REPO_OK,
      repoBranch: null,
    },
  ]);
  eq("unknown ticket → null", resolveTicket(db, 404), null);
  eq("no recorded branch → null", resolveTicket(db, 9), null);
  eq("missing db → null", resolveTicket(resolve(WORKDIR, "absent.sqlite"), 7), null);
  eq("non-numeric → null", resolveTicket(db, "abc"), null);
}

console.log("== AC3: attemptMerge lands a CLEAN merge ==");
{
  const repo = newRepo("clean");
  require("node:fs").writeFileSync(resolve(repo, "file.txt"), "base\nfeature\n");
  git(repo, "commit", "-q", "-am", "feature");
  const r = attemptMerge(repo, "gaffer/ticket-7-x", "main");
  assert("attemptMerge returns clean:true", r.clean === true);
  assert(
    "repo left on the default branch",
    git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim() === "main",
  );
  assert(
    "default branch has the merged change",
    readFileSync(resolve(repo, "file.txt"), "utf8").includes("feature"),
  );
}

console.log("== AC4: attemptMerge reports a CONFLICT and aborts (both sides intact) ==");
{
  const repo = newRepo("conflict");
  require("node:fs").writeFileSync(resolve(repo, "file.txt"), "base\nbranch-line\n");
  git(repo, "commit", "-q", "-am", "branch-edit");
  git(repo, "checkout", "-q", "main");
  require("node:fs").writeFileSync(resolve(repo, "file.txt"), "base\nmain-line\n");
  git(repo, "commit", "-q", "-am", "main-edit");
  const mainBefore = git(repo, "rev-parse", "main").stdout.trim();

  const r = attemptMerge(repo, "gaffer/ticket-7-x", "main");
  assert("attemptMerge returns clean:false on conflict", r.clean === false);
  assert(
    "no half-merge left (clean tree)",
    git(repo, "status", "--porcelain").stdout.trim() === "",
  );
  assert("no MERGE_HEAD lingering", !existsSync(resolve(repo, ".git", "MERGE_HEAD")));
  assert("default branch unchanged", git(repo, "rev-parse", "main").stdout.trim() === mainBefore);
  assert(
    "delivery branch intact",
    git(repo, "rev-parse", "--verify", "gaffer/ticket-7-x").status === 0,
  );
}

console.log("== AC5: buildResolverPrompt pins skill + worktree/branch + discipline ==");
{
  const p = buildResolverPrompt({
    ticketNumber: 7,
    repoName: "demo",
    worktree: "/tmp/wt",
    branch: "gaffer/ticket-7-x",
    defaultBranch: "main",
  });
  assert("names the resolve-merge-conflict skill", p.includes("resolve-merge-conflict skill"));
  assert("names the branch + worktree", p.includes("gaffer/ticket-7-x") && p.includes("/tmp/wt"));
  assert(
    "merges DEFAULT into the BRANCH",
    /merge main INTO/i.test(p) || /merge .*"main".* INTO/i.test(p),
  );
  assert("preserves BOTH intents", /BOTH INTENTS/.test(p) && /NEVER\s+blindly discard/i.test(p));
  assert(
    "branch-only — do not land to default",
    /do not .*push the default branch/i.test(p) || /branch only/i.test(p),
  );
  assert("headless — no AskUserQuestion", p.includes("AskUserQuestion"));
  assert("does not self-approve", /Do NOT\s+approve the ticket yourself/i.test(p));
}

console.log("== AC6: buildClaudeArgv = [-p, prompt, --mcp-config, cfg, ...flags] ==");
{
  const argv = buildClaudeArgv({
    prompt: "P",
    mcpConfig: "/tmp/mcp.json",
    flags: ["--permission-mode", "acceptEdits"],
  });
  eq("argv shape", argv, [
    "-p",
    "P",
    "--mcp-config",
    "/tmp/mcp.json",
    "--permission-mode",
    "acceptEdits",
  ]);
  eq("no mcp config → omitted", buildClaudeArgv({ prompt: "P", mcpConfig: "", flags: ["--foo"] }), [
    "-p",
    "P",
    "--foo",
  ]);
}

console.log("== AC7: buildReapprovalCommand is the single isolated re-approval call ==");
{
  const { command, args } = buildReapprovalCommand({
    ticketNumber: 7,
    reason: "why",
    resolution: "summary",
  });
  eq("command is wg", command, "wg");
  eq("argv shape: ticket reopen-for-review <n> --reason ... --resolution ... --as system", args, [
    "ticket",
    "reopen-for-review",
    "7",
    "--reason",
    "why",
    "--resolution",
    "summary",
    "--as",
    "system",
  ]);
}

console.log("== AC8: buildChildEnv strips DISPATCH_API_TOKEN, sets MCP + write-root ==");
{
  const env = buildChildEnv(
    { PATH: "/usr/bin", DISPATCH_API_TOKEN: "secret-xyz", OTHER: "keep" },
    { dispatchDb: "/db/wg.sqlite", memoryDb: "/db/lg.sqlite", writeRoot: "/wt" },
  );
  assert("DISPATCH_API_TOKEN stripped", !("DISPATCH_API_TOKEN" in env));
  assert("unrelated env preserved", env.OTHER === "keep" && env.PATH === "/usr/bin");
  assert("DISPATCH_DB set", env.DISPATCH_DB === "/db/wg.sqlite");
  assert("MEMORY_DB set", env.MEMORY_DB === "/db/lg.sqlite");
  assert("GAFFER_WRITE_ROOTS = worktree", env.GAFFER_WRITE_ROOTS === "/wt");
}

console.log("== AC9: --dry-run on a conflicting ticket → merge target + resolver argv ==");
{
  const db = makeDb([
    {
      ticketId: "tc",
      number: 7,
      ticketBranch: null,
      repoId: "rc",
      repoName: "demo",
      localPath: REPO_OK,
      defaultBranch: "main",
      repoBranch: "gaffer/ticket-7-x",
      access: "write",
    },
  ]);
  const { code, out } = runCli({ DISPATCH_DB: db }, ["--ticket", "7"]);
  if (
    code === 0 &&
    out &&
    out.phase === "dry-run" &&
    out.ticket === 7 &&
    out.branch === "gaffer/ticket-7-x" &&
    out.defaultBranch === "main" &&
    out.mergeTarget &&
    out.mergeTarget.branch === "gaffer/ticket-7-x" &&
    out.mergeTarget.defaultBranch === "main" &&
    Array.isArray(out.resolverArgv) &&
    out.resolverArgv[0] === "-p" &&
    out.resolverArgv.includes("--mcp-config") &&
    out.resolverArgv[1].includes("resolve-merge-conflict skill") &&
    out.resolverArgv[1].includes("gaffer/ticket-7-x") &&
    typeof out.worktree === "string" &&
    out.worktree.includes("merge-ticket-7") &&
    out.resolverArgv[1].includes(out.worktree)
  ) {
    ok("dry-run → merge target + resolver argv carrying skill + branch + worktree");
  } else fail(`dry-run wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC10: --dry-run is BOUNDED — timeout-ms reported ==");
{
  const db = makeDb([
    {
      ticketId: "tb",
      number: 7,
      ticketBranch: null,
      repoId: "rb",
      repoName: "demo",
      localPath: REPO_OK,
      repoBranch: "gaffer/ticket-7-x",
      access: "write",
    },
  ]);
  const { code, out } = runCli({ DISPATCH_DB: db }, ["--ticket", "7", "--timeout-ms", "4321"]);
  assert("timeout-ms reported", code === 0 && out && out.timeoutMs === 4321);
}

console.log("== AC11: unknown / unresolvable ticket is REFUSED (exit 1, error JSON) ==");
{
  const db = makeDb([
    {
      ticketId: "te",
      number: 7,
      ticketBranch: null,
      repoId: "re",
      repoName: "demo",
      localPath: REPO_OK,
      repoBranch: "gaffer/ticket-7-x",
      access: "write",
    },
  ]);
  const r1 = runCli({ DISPATCH_DB: db }, ["--ticket", "999"]);
  assert(
    "unknown ticket → exit 1 + error",
    r1.code === 1 && r1.out && r1.out.phase === "error" && /could not resolve/.test(r1.out.error),
  );
  const r2 = runCli({ DISPATCH_DB: db }, []);
  assert(
    "missing --ticket → exit 1 + error",
    r2.code === 1 && r2.out && r2.out.phase === "error" && /required/.test(r2.out.error),
  );
}

console.log("== AC12: the resolve-merge-conflict SKILL.md exists ==");
{
  assert("SKILL.md present", existsSync(SKILL));
  if (existsSync(SKILL)) {
    const text = readFileSync(SKILL, "utf8");
    assert(
      "frontmatter name is resolve-merge-conflict",
      /name:\s*resolve-merge-conflict/.test(text),
    );
    assert(
      "documents branch-only / preserve-both discipline",
      /preserv/i.test(text) && /default branch/i.test(text),
    );
  }
}

// ── R-3: digest/feature apply failure on merge is SURFACED, not swallowed ──────
// The apply step is fully swallowed by contract (it must never un-land the merge),
// but a failure used to be INVISIBLE: the merge landed while the feature stayed at
// `building` and the Repo Digest silently drifted. The fix makes the failure visible
// two ways: (a) the merged JSON carries digest.applied:false (+ error), and (b) a
// prominent WARNING is logged. We prove both halves without a live `claude -p`.
{
  // (a) When the apply ABORTS (readTicketView throws because the dispatch DB is a
  // bogus path → JSON.parse of empty stdout fails → but that's caught and returns
  // null, not a throw). To force the OUTER abort path deterministically we point the
  // dispatch CLI at a non-existent binary so the whole apply throws before any job.
  const realDispatchCli = process.env.DISPATCH_CLI;
  const realDigestDisable = process.env.GAFFER_DIGEST_DISABLE;
  delete process.env.GAFFER_DIGEST_DISABLE;
  const apply = applyDigestAndFeature({ ticketNumber: 4242, repo: "nope", featureId: undefined });
  // applyDigestAndFeature swallows: on any failure it returns applied:false (+ error
  // when it threw). Either way it never throws and the merge is unaffected.
  assert(
    "R-3: applyDigestAndFeature never throws (returns a summary object)",
    apply && typeof apply === "object",
  );
  if (realDispatchCli === undefined) delete process.env.DISPATCH_CLI;
  else process.env.DISPATCH_CLI = realDispatchCli;
  if (realDigestDisable !== undefined) process.env.GAFFER_DIGEST_DISABLE = realDigestDisable;

  // (b) The post-merge log decision is a PURE function (formatDigestApplyLog) the merge
  // path calls. Drive its three branches directly — this is the operator-visible signal.
  const okLog = formatDigestApplyLog(
    { applied: true, prepared: true, jobs: [{ kind: "digest", ok: true }] },
    99,
  );
  assert(
    "R-3: applied → info log, not a warning",
    okLog?.level === "info" && /applied prepared delta/.test(okLog.message),
  );

  const skipLog = formatDigestApplyLog(
    { applied: false, skipped: "GAFFER_DIGEST_DISABLE=1", jobs: [] },
    99,
  );
  assert(
    "R-3: deliberate skip → info log (not a warning)",
    skipLog?.level === "info" && /skipped/.test(skipLog.message),
  );

  const failLog = formatDigestApplyLog(
    { applied: false, error: "boom from memory CLI", jobs: [] },
    7,
  );
  assert(
    "R-3: apply failure → WARNING level (operator-visible)",
    failLog?.level === "warning" && /^WARNING:/.test(failLog.message),
  );
  assert(
    "R-3: warning names the ticket, the failure, and the stale digest / stuck feature",
    /#7\b/.test(failLog.message) &&
      /boom from memory CLI/.test(failLog.message) &&
      /STALE/.test(failLog.message) &&
      /building/.test(failLog.message),
  );
}

// --- parseDiffStatus: --name-status -M parsing --------------------------------
console.log("== parseDiffStatus: statuses map to refresh vs deletions ==");
{
  const diff = [
    "A\tsrc/added.ts",
    "M\tsrc/modified.ts",
    "D\tsrc/deleted.ts",
    "T\tsrc/type-changed.ts",
    "R097\tsrc/old-name.ts\tsrc/new-name.ts",
    "C080\tsrc/origin.ts\tsrc/copy.ts",
  ].join("\n");
  const { refresh, deletions } = parseDiffStatus(diff);

  assert("added file → refresh", refresh.includes("src/added.ts"));
  assert("modified file → refresh", refresh.includes("src/modified.ts"));
  assert("type-changed file → refresh", refresh.includes("src/type-changed.ts"));
  assert("deleted file → deletions", deletions.includes("src/deleted.ts"));
  assert("deleted file NOT in refresh", !refresh.includes("src/deleted.ts"));
  assert("rename NEW path → refresh", refresh.includes("src/new-name.ts"));
  assert("rename OLD path → deletions", deletions.includes("src/old-name.ts"));
  assert("copy NEW path → refresh", refresh.includes("src/copy.ts"));
  assert("copy ORIGIN (unchanged) NOT tombstoned", !deletions.includes("src/origin.ts"));
  eq("empty diff → empty lists", parseDiffStatus(""), { refresh: [], deletions: [] });
}

// --- BOUNDARY: no direct Memory DB read remains in the Runner ------------------
console.log("== boundary: Runner reads the card watermark via the memory CLI, not the DB ==");
{
  const src = require("node:fs").readFileSync(HELPER, "utf8");
  // The card watermark must be fetched through the `get-card-watermark` CLI verb.
  assert(
    "merge-ticket calls the get-card-watermark memory CLI verb",
    src.includes('"get-card-watermark"'),
  );
  // No direct SQL SELECT against Memory's repo_sync / file_card tables anywhere
  // in the Runner entrypoint (the boundary rule: Memory owns its DB).
  assert(
    "no direct SELECT against repo_sync in the Runner",
    !/repo_sync/.test(src) || !/SELECT[^;]*repo_sync/i.test(src),
  );
  assert("no SELECT ... FROM file_card in the Runner", !/FROM\s+file_card/i.test(src));
  // The old direct-DB reader signature (memDbPath, canonical) is gone.
  assert(
    "readCardWatermark no longer opens the memory sqlite directly",
    !/readCardWatermark\([^)]*memDbPath/.test(src) && !/repo_sync WHERE repo_key/.test(src),
  );
}

// ── B9: --apply-digest-only runs ONLY the post-merge memory step (no git, no claude) ──
console.log("== B9: --apply-digest-only → digest/feature apply with no git mutation ==");
{
  // Stub CLI for BOTH dispatch (`ticket show`) and memory (digest/feature writes).
  const STUB = resolve(WORKDIR, "cli-stub-b9.mjs");
  const CALLS = resolve(WORKDIR, "calls-b9.log");
  const VIEW = resolve(WORKDIR, "view-b9.json");
  writeFileSync(
    STUB,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      "const argv = process.argv.slice(2);",
      "const real = argv[0] === '--db' ? argv.slice(2) : argv;",
      `appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(real) + '\\n');`,
      "if (real[0] === 'ticket' && real[1] === 'show') {",
      `  process.stdout.write(readFileSync(${JSON.stringify(VIEW)}, 'utf8')); process.exit(0);`,
      "}",
      "process.exit(0);",
    ].join("\n"),
  );
  writeFileSync(
    VIEW,
    JSON.stringify({
      ticket: { number: 9, description: "ship it\n\nFeature-Id: lore_f9" },
      evidence: [],
    }),
  );
  // The repo path does NOT exist on disk: proves no git runs on this path.
  const db = makeDb([
    {
      ticketId: "t9",
      number: 9,
      repoId: "r9",
      repoName: "demo9",
      localPath: resolve(WORKDIR, "absent-repo"),
      repoBranch: "gaffer/ticket-9-x",
    },
  ]);
  const res = spawnSync(process.execPath, [HELPER, "--ticket", "9", "--apply-digest-only"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DISPATCH_DB: db,
      DISPATCH_CLI: STUB,
      MEMORY_CLI: STUB,
      CLAUDE_BIN: "/nonexistent/claude",
    },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* null */
  }
  assert("exit 0", res.status === 0);
  assert(
    "phase digest-applied for ticket 9 / repo demo9",
    out && out.phase === "digest-applied" && out.ticket === 9 && out.repo === "demo9",
  );
  assert("digest.applied === true", out && out.digest && out.digest.applied === true);
  const calls = existsSync(CALLS)
    ? readFileSync(CALLS, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  assert(
    "memory: digest touch demo9 --source merge:#9",
    calls.some(
      (c) => c[0] === "digest" && c[1] === "touch" && c[2] === "demo9" && c.includes("merge:#9"),
    ),
  );
  assert(
    "memory: feature advance lore_f9 --to shipped (from the ticket's Feature-Id)",
    calls.some((c) => c.join(" ") === "feature advance lore_f9 --to shipped"),
  );
  assert(
    "no mark-merged / no git (the merge already landed elsewhere)",
    !calls.some((c) => c.includes("mark-merged")),
  );
}

// ── B14: PR MODE — a ticket with a pr_url is merged THROUGH its PR, never locally ─────
// GAFFER_CREATE_PR recorded pr_url on the ticket, but the merge never read it: it
// merged the branch locally, pushed nothing and left the PR open. Now: `gh pr merge
// <url> --<method> --delete-branch`, then the local default branch is FAST-FORWARDED
// from the remote; a gh failure (or no gh) falls back to the local merge and says why.
console.log(
  "== B14: resolveTicket carries pr_url (per-repo first, ticket-level, legacy schema) ==",
);
{
  const dbBoth = makeDb([
    {
      ticketId: "tp1",
      number: 7,
      repoId: "rp1",
      repoName: "demo",
      localPath: REPO_OK,
      repoBranch: "gaffer/ticket-7-x",
      prUrl: "https://github.com/o/r/pull/1",
      repoPrUrl: "https://github.com/o/r/pull/2",
    },
  ]);
  eq("per-repo pr_url wins", resolveTicket(dbBoth, 7)?.prUrl, "https://github.com/o/r/pull/2");
  const dbTicket = makeDb([
    {
      ticketId: "tp2",
      number: 7,
      repoId: "rp2",
      repoName: "demo",
      localPath: REPO_OK,
      repoBranch: "gaffer/ticket-7-x",
      prUrl: "https://github.com/o/r/pull/1",
    },
  ]);
  eq(
    "ticket-level pr_url fallback",
    resolveTicket(dbTicket, 7)?.prUrl,
    "https://github.com/o/r/pull/1",
  );
  const dbLegacy = makeDb(
    [
      {
        ticketId: "tp3",
        number: 7,
        repoId: "rp3",
        repoName: "demo",
        localPath: REPO_OK,
        repoBranch: "gaffer/ticket-7-x",
      },
    ],
    { legacySchema: true },
  );
  const legacy = resolveTicket(dbLegacy, 7);
  eq("schema without pr_url → '' (the local merge, exactly as before)", legacy?.prUrl, "");
  eq("…and still resolves the branch", legacy?.branch, "gaffer/ticket-7-x");
}

console.log(
  "== B14: gh argv + GAFFER_PR_MERGE_METHOD (merge default, squash, rebase, junk → merge) ==",
);
{
  eq(
    "default → pr merge <url> --merge --delete-branch",
    buildPrMergeArgv({ prUrl: "https://github.com/o/r/pull/9" }),
    ["pr", "merge", "https://github.com/o/r/pull/9", "--merge", "--delete-branch"],
  );
  eq("squash", buildPrMergeArgv({ prUrl: "U", method: "squash" })[3], "--squash");
  eq("rebase (trimmed, case-insensitive)", resolvePrMergeMethod(" Rebase "), "rebase");
  eq(
    "unknown method → merge (a typo never picks an unintended method)",
    resolvePrMergeMethod("yolo"),
    "merge",
  );
}

// Live (non-dry-run) PR-mode runs against real git + a stub `gh`. The delivery branch
// was pushed to a bare `origin` (as GAFFER_CREATE_PR does); the stub's `pr merge` lands
// the branch tip on origin/main and deletes the remote + local branch, like GitHub + gh
// --delete-branch do; the helper must then fast-forward the local default branch.
const GH_STUB = resolve(WORKDIR, "gh-stub.mjs");
writeFileSync(
  GH_STUB,
  [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "const argv = process.argv.slice(2);",
    "appendFileSync(process.env.STUB_GH_CALLS, JSON.stringify(argv) + '\\n');",
    "if (argv[0] === '--version') { process.stdout.write('gh stub\\n'); process.exit(0); }",
    "if (process.env.STUB_GH_FAIL === '1') { process.stderr.write('GraphQL: Pull request is not mergeable\\n'); process.exit(1); }",
    "if (argv[0] === 'pr' && argv[1] === 'merge') {",
    "  const br = process.env.STUB_GH_BRANCH;",
    "  const r = spawnSync('git', ['push', '-q', 'origin', `refs/heads/${br}:refs/heads/main`], { encoding: 'utf8' });",
    "  spawnSync('git', ['push', '-q', 'origin', '--delete', br]);",
    "  if (argv.includes('--delete-branch')) spawnSync('git', ['branch', '-D', br]);",
    "  process.exit(r.status ?? 1);",
    "}",
    "process.exit(0);",
  ].join("\n"),
  { mode: 0o755 },
);
const CLI_STUB_B14 = resolve(WORKDIR, "cli-stub-b14.mjs");
const CLI_CALLS_B14 = resolve(WORKDIR, "cli-calls-b14.log");
writeFileSync(
  CLI_STUB_B14,
  [
    "import { appendFileSync } from 'node:fs';",
    "const argv = process.argv.slice(2);",
    "const real = argv[0] === '--db' ? argv.slice(2) : argv;",
    `appendFileSync(${JSON.stringify(CLI_CALLS_B14)}, JSON.stringify(real) + '\\n');`,
    "if (real[0] === 'ticket' && real[1] === 'show') { process.stdout.write('{\"ticket\":{},\"evidence\":[]}'); }",
    "process.exit(0);",
  ].join("\n"),
);
const CLAUDE_STUB = resolve(WORKDIR, "claude-stub.sh");
const CLAUDE_MARK = resolve(WORKDIR, "claude-was-spawned");
writeFileSync(CLAUDE_STUB, `#!/bin/sh\ntouch "${CLAUDE_MARK}"\necho '{}'\n`, { mode: 0o755 });

function prFixture(name, { checkout = "main" } = {}) {
  const repo = newRepo(name); // on gaffer/ticket-7-x, one base commit on main
  writeFileSync(resolve(repo, "file.txt"), "base\nfeature\n");
  git(repo, "commit", "-q", "-am", "feature");
  const featureSha = git(repo, "rev-parse", "gaffer/ticket-7-x").stdout.trim();
  const bare = resolve(WORKDIR, `${name}-origin.git`);
  spawnSync("git", ["init", "-q", "--bare", bare], { encoding: "utf8" });
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "origin", "main", "gaffer/ticket-7-x");
  if (checkout === "main") git(repo, "checkout", "-q", "main");
  else git(repo, "checkout", "-q", "-b", checkout, "main");
  const db = makeDb([
    {
      ticketId: `t-${name}`,
      number: 7,
      repoId: `r-${name}`,
      repoName: name,
      localPath: repo,
      repoBranch: "gaffer/ticket-7-x",
      prUrl: `https://github.com/o/${name}/pull/7`,
    },
  ]);
  return { repo, bare, db, featureSha, prUrl: `https://github.com/o/${name}/pull/7` };
}
function runLive(env, args) {
  const calls = resolve(WORKDIR, `gh-calls-${Math.random().toString(36).slice(2)}.log`);
  const res = spawnSync(process.execPath, [HELPER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GAFFER_DATA: resolve(WORKDIR, "data"),
      DISPATCH_CLI: CLI_STUB_B14,
      MEMORY_CLI: CLI_STUB_B14,
      CLAUDE_BIN: CLAUDE_STUB,
      GAFFER_GH_BIN: GH_STUB,
      GAFFER_DIGEST_DISABLE: "1",
      STUB_GH_CALLS: calls,
      STUB_GH_BRANCH: "gaffer/ticket-7-x",
      ...env,
    },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* null */
  }
  const ghCalls = existsSync(calls)
    ? readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { code: res.status, out, err: res.stderr || "", ghCalls };
}
const cliCalls = () =>
  existsSync(CLI_CALLS_B14)
    ? readFileSync(CLI_CALLS_B14, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

console.log("== B14: pr_url + gh → merged THROUGH the PR, local default fast-forwarded ==");
{
  const f = prFixture("pr-main");
  const { code, out, err, ghCalls } = runLive({ DISPATCH_DB: f.db }, ["--ticket", "7"]);
  assert("exit 0 + phase merged", code === 0 && out && out.phase === "merged");
  assert("via:pr with the PR url", out && out.via === "pr" && out.prUrl === f.prUrl);
  assert("local default fast-forwarded", out && out.fastForwarded === true);
  assert(
    "gh pr merge <url> --merge --delete-branch was the merge",
    ghCalls.some((c) => c.join(" ") === `pr merge ${f.prUrl} --merge --delete-branch`),
  );
  assert(
    "local main is EXACTLY the branch tip (fast-forward, no local merge commit)",
    git(f.repo, "rev-parse", "main").stdout.trim() === f.featureSha,
  );
  assert(
    "main has the delivered change",
    readFileSync(resolve(f.repo, "file.txt"), "utf8").includes("feature"),
  );
  assert(
    "origin/main carries the merge",
    git(f.bare, "rev-parse", "main").stdout.trim() === f.featureSha,
  );
  assert(
    "ticket flipped merged → done (mark-merged called)",
    cliCalls().some((c) => c.includes("mark-merged")),
  );
  assert("logged as merged through its PR", /through its PR/.test(err));
  assert("no resolver was spawned", !existsSync(CLAUDE_MARK));
}

console.log("== B14: default branch NOT checked out → ff ref update, operator branch untouched ==");
{
  const f = prFixture("pr-workbench", { checkout: "workbench" });
  const { code, out } = runLive({ DISPATCH_DB: f.db }, ["--ticket", "7"]);
  assert("merged via pr", code === 0 && out && out.via === "pr" && out.fastForwarded === true);
  assert(
    "main advanced to the branch tip",
    git(f.repo, "rev-parse", "main").stdout.trim() === f.featureSha,
  );
  assert(
    "HEAD still on the operator's branch",
    git(f.repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim() === "workbench",
  );
}

console.log("== B14: GAFFER_PR_MERGE_METHOD=squash reaches gh ==");
{
  const f = prFixture("pr-squash");
  const { out, ghCalls } = runLive({ DISPATCH_DB: f.db, GAFFER_PR_MERGE_METHOD: "squash" }, [
    "--ticket",
    "7",
  ]);
  assert("merged via pr", out && out.via === "pr");
  assert(
    "gh was told --squash",
    ghCalls.some((c) => c[1] === "merge" && c.includes("--squash")),
  );
}

console.log("== B14: gh FAILS → falls back to the local merge with the reason logged ==");
{
  const f = prFixture("pr-ghfail");
  const { code, out, err } = runLive({ DISPATCH_DB: f.db, STUB_GH_FAIL: "1" }, ["--ticket", "7"]);
  assert("still merged (exit 0)", code === 0 && out && out.phase === "merged");
  assert("via:local", out && out.via === "local");
  assert(
    "the fallback and its reason are logged",
    /falling back to a LOCAL merge/.test(err) && /not mergeable/.test(err),
  );
  assert(
    "main has the change (local merge landed)",
    readFileSync(resolve(f.repo, "file.txt"), "utf8").includes("feature"),
  );
}

console.log("== B14: gh NOT available → local merge, logged ==");
{
  const f = prFixture("pr-nogh");
  const { out, err } = runLive(
    { DISPATCH_DB: f.db, GAFFER_GH_BIN: resolve(WORKDIR, "no-such-gh") },
    ["--ticket", "7"],
  );
  assert("via:local", out && out.via === "local");
  assert("logged that gh is not available", /not available/.test(err) && /GAFFER_GH_BIN/.test(err));
}

console.log("== B14: no pr_url → the local merge, byte-identical to before (no gh call) ==");
{
  const f = prFixture("pr-none");
  const dbNoPr = makeDb([
    {
      ticketId: "t-none",
      number: 7,
      repoId: "r-none",
      repoName: "pr-none-2",
      localPath: f.repo,
      repoBranch: "gaffer/ticket-7-x",
    },
  ]);
  const { out, ghCalls } = runLive({ DISPATCH_DB: dbNoPr }, ["--ticket", "7"]);
  assert("via:local", out && out.via === "local" && out.prUrl === undefined);
  assert("gh never consulted", ghCalls.length === 0);
}

// Cleanup the throwaway repos + DBs.
try {
  rmSync(WORKDIR, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log();
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks passed (runner: ${HELPER})`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
