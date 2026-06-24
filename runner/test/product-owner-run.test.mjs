#!/usr/bin/env node
// =====================================================================
// `product-owner-run` helper (bin/product-owner-run.mjs) — argv/prompt + bounds +
// repo resolution, proven WITHOUT a live `claude -p` call.
// ---------------------------------------------------------------------
// Against the REAL helper (imported functions + a real --dry-run subprocess over a
// throwaway sqlite DB), proves:
//   AC1  resolveRepo maps a known repo NAME → its registered local_path
//   AC2  resolveRepo returns null for an unknown repo / missing db / blank name
//   AC3  buildPrompt pins the product-owner skill, draft-only + no-questions, repo + cap
//   AC4  buildClaudeArgv produces [-p, prompt, --mcp-config, <cfg>, ...flags] (skill+mcp+headless)
//   AC5  the --dry-run CLI resolves DISPATCH_PRODUCT_OWNER_REPO → a planned invocation
//   AC6  the run is BOUNDED: --max-tickets feeds the prompt, --timeout-ms is reported
//   AC7  an unknown repo is REFUSED (exit 1, error JSON) — no claude invocation planned
//   AC8  a missing DISPATCH_PRODUCT_OWNER_REPO is REFUSED (exit 1, error JSON)
//
// Zero deps (node:sqlite ships with Node 22+). Run: node test/product-owner-run.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
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
const HELPER = resolve(HERE, "..", "bin", "product-owner-run.mjs");
const { resolveRepo, buildPrompt, buildClaudeArgv, agentChildEnv } = await import(HELPER);

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

// --- Build a throwaway dispatch sqlite with the one table resolveRepo reads. ----
// Mirrors dispatch's repositories schema (name UNIQUE, local_path) — just enough to
// exercise name→path resolution offline, with no dispatch build.
const WORKDIR = mkdtempSync(resolve(tmpdir(), "po-run-test-"));
const DB_PATH = resolve(WORKDIR, "dispatch.sqlite");
const REPO_PATH = resolve(WORKDIR, "demo-repo");
{
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_PATH);
  db.exec(
    "CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, " +
      "local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main');",
  );
  // local_path points at a real dir so the live (non-dry) on-disk check would pass;
  // the dry-run path under test doesn't require it to exist, but keep it honest.
  require("node:fs").mkdirSync(REPO_PATH, { recursive: true });
  db.prepare("INSERT INTO repositories (id,name,local_path,default_branch) VALUES (?,?,?,?)").run(
    "r1",
    "demo",
    REPO_PATH,
    "main",
  );
  db.close();
}

// Run the helper as a CLI with --dry-run; return { code, out }.
function runCli(env = {}, extraArgs = []) {
  const res = spawnSync(process.execPath, [HELPER, "--dry-run", ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, DISPATCH_DB: DB_PATH, ...env },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }
  return { code: res.status, out };
}

console.log("== AC1: resolveRepo maps a known repo NAME → local_path ==");
{
  const r = resolveRepo(DB_PATH, "demo");
  if (r && r.name === "demo" && r.localPath === REPO_PATH && r.defaultBranch === "main") {
    ok("known repo resolved to its registered path");
  } else fail(`resolveRepo wrong: ${JSON.stringify(r)}`);
}

console.log("== AC2: resolveRepo null for unknown / missing db / blank ==");
{
  eq("unknown repo → null", resolveRepo(DB_PATH, "nope"), null);
  eq("blank name → null", resolveRepo(DB_PATH, "   "), null);
  eq("missing db → null", resolveRepo(resolve(WORKDIR, "absent.sqlite"), "demo"), null);
}

console.log("== AC3: buildPrompt pins skill + draft-only + no-questions + repo + cap ==");
{
  const p = buildPrompt({ repoName: "demo", repoPath: REPO_PATH, maxTickets: 4 });
  assert("names the product-owner skill", p.includes("product-owner skill"));
  assert("names the repo", p.includes('"demo"') && p.includes(REPO_PATH));
  assert(
    "is headless: forbids AskUserQuestion",
    p.includes("AskUserQuestion") && /NEVER ask/i.test(p),
  );
  assert("is draft-only", /DRAFT ONLY/.test(p) && p.includes("create_ticket"));
  assert("bounds the batch to the cap", p.includes("3 to 4 tickets"));
}

console.log(
  "== AC4: buildClaudeArgv = [-p, prompt, --output-format json, --mcp-config, cfg, ...flags] ==",
);
{
  const argv = buildClaudeArgv({
    prompt: "P",
    mcpConfig: "/tmp/mcp.json",
    flags: ["--permission-mode", "acceptEdits"],
  });
  // USAGE LEDGER: --output-format json is now part of every invocation so stdout
  // carries the real usage; it is non-breaking here (this run never parses stdout).
  eq("argv shape (json envelope + skill prompt + mcp + flags)", argv, [
    "-p",
    "P",
    "--output-format",
    "json",
    "--mcp-config",
    "/tmp/mcp.json",
    "--permission-mode",
    "acceptEdits",
  ]);
  const noMcp = buildClaudeArgv({ prompt: "P", mcpConfig: "", flags: ["--foo"] });
  eq("no mcp config → omitted", noMcp, ["-p", "P", "--output-format", "json", "--foo"]);
}

console.log("== AC5: --dry-run resolves DISPATCH_PRODUCT_OWNER_REPO → planned invocation ==");
{
  const { code, out } = runCli({ DISPATCH_PRODUCT_OWNER_REPO: "demo" });
  if (
    code === 0 &&
    out &&
    out.phase === "dry-run" &&
    out.repo === "demo" &&
    out.repoPath === REPO_PATH &&
    Array.isArray(out.argv) &&
    out.argv[0] === "-p" &&
    out.argv.includes("--mcp-config") &&
    out.argv[1].includes("product-owner skill")
  ) {
    ok("dry-run env repo → exit 0 + planned claude -p argv with skill + mcp");
  } else fail(`dry-run wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC6: bounded — max-tickets feeds the prompt, timeout-ms is reported ==");
{
  const { code, out } = runCli({ DISPATCH_PRODUCT_OWNER_REPO: "demo" }, [
    "--max-tickets",
    "3",
    "--timeout-ms",
    "1234",
  ]);
  if (
    code === 0 &&
    out &&
    out.maxTickets === 3 &&
    out.timeoutMs === 1234 &&
    out.argv[1].includes("3 to 3 tickets")
  ) {
    ok("max-tickets bounds the prompt + timeout-ms reported");
  } else fail(`bounds wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC7: unknown repo is REFUSED (exit 1, error JSON, no plan) ==");
{
  const { code, out } = runCli({ DISPATCH_PRODUCT_OWNER_REPO: "ghost" });
  if (code === 1 && out && out.phase === "error" && /unknown repo/.test(out.error)) {
    ok("unknown repo → exit 1 + error (no invocation planned)");
  } else fail(`unknown-repo refusal wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC8: missing DISPATCH_PRODUCT_OWNER_REPO is REFUSED (exit 1) ==");
{
  // Pass an explicit empty repo env so it doesn't inherit one from the outer shell.
  const { code, out } = runCli({ DISPATCH_PRODUCT_OWNER_REPO: "" });
  if (code === 1 && out && out.phase === "error" && /required/.test(out.error)) {
    ok("missing repo env → exit 1 + error");
  } else fail(`missing-repo refusal wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== P2-A: DISPATCH_API_TOKEN is stripped from the agent child env ==");
{
  // Unit: the helper deletes the bearer token and any *_TOKEN / *_SECRET.
  const childEnv = agentChildEnv({
    PATH: "/usr/bin",
    DISPATCH_API_TOKEN: "super-secret-bearer",
    GITHUB_TOKEN: "gh-xxx",
    NPM_SECRET: "npm-yyy",
    DISPATCH_DB: "/tmp/wg.sqlite",
    // M2: broadened denylist coverage.
    AWS_ACCESS_KEY_ID: "AKIA-leak",
    AWS_SECRET_ACCESS_KEY: "aws-secret-leak",
    DB_PASSWORD: "hunter2",
    ANTHROPIC_API_KEY: "sk-ant-keepme",
  });
  assert("removes DISPATCH_API_TOKEN", !("DISPATCH_API_TOKEN" in childEnv));
  assert("removes other *_TOKEN keys", !("GITHUB_TOKEN" in childEnv));
  assert("removes other *_SECRET keys", !("NPM_SECRET" in childEnv));
  assert("M2: removes AWS_ACCESS_KEY_ID (*_KEY/ID)", !("AWS_ACCESS_KEY_ID" in childEnv));
  assert("M2: removes AWS_SECRET_ACCESS_KEY", !("AWS_SECRET_ACCESS_KEY" in childEnv));
  assert("M2: removes *_PASSWORD keys", !("DB_PASSWORD" in childEnv));
  assert(
    "M2: KEEPS ANTHROPIC_API_KEY (claude auth)",
    childEnv.ANTHROPIC_API_KEY === "sk-ant-keepme",
  );
  assert("keeps non-credential vars (PATH)", childEnv.PATH === "/usr/bin");
  assert("keeps the DB path var", childEnv.DISPATCH_DB === "/tmp/wg.sqlite");

  // Integration: a --dry-run with the token set reports it would NOT reach the child.
  const { code, out } = runCli({
    DISPATCH_PRODUCT_OWNER_REPO: "demo",
    DISPATCH_API_TOKEN: "leak-me",
  });
  if (code === 0 && out && out.childEnvHasApiToken === false) {
    ok("dry-run confirms the spawned child env would NOT carry DISPATCH_API_TOKEN");
  } else fail(`dry-run token-strip wrong (code=${code}, out=${JSON.stringify(out)})`);
}

// Cleanup the throwaway DB + repo dir.
try {
  rmSync(WORKDIR, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log();
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks passed (helper: ${HELPER})`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
