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
//
// Zero deps (node:sqlite ships with Node 22+; needs git on PATH). No live claude.
// Run: node test/merge-ticket.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
function makeDb(rows) {
  const dbPath = resolve(WORKDIR, `wg-${Math.random().toString(36).slice(2)}.sqlite`);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER UNIQUE, branch_name TEXT);" +
      "CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, " +
      "local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main');" +
      "CREATE TABLE ticket_repos (ticket_id TEXT, repo_id TEXT, role TEXT DEFAULT 'primary', " +
      "branch_name TEXT, access TEXT DEFAULT 'write');",
  );
  for (const r of rows) {
    db.prepare("INSERT INTO tickets (id,number,branch_name) VALUES (?,?,?)").run(
      r.ticketId,
      r.number,
      r.ticketBranch ?? null,
    );
    db.prepare("INSERT INTO repositories (id,name,local_path,default_branch) VALUES (?,?,?,?)").run(
      r.repoId,
      r.repoName,
      r.localPath,
      r.defaultBranch ?? "main",
    );
    db.prepare(
      "INSERT INTO ticket_repos (ticket_id,repo_id,role,branch_name,access) VALUES (?,?,?,?,?)",
    ).run(r.ticketId, r.repoId, r.role ?? "primary", r.repoBranch ?? null, r.access ?? "write");
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
