#!/usr/bin/env node
// =====================================================================
// `onboard-run` helper (bin/onboard-run.mjs) — target resolution + crew argv
// + the unconfigured-target refusal, proven WITHOUT a live crew call.
// ---------------------------------------------------------------------
// The dashboard Memory view's "Onboard a repo" button (POST /repos/onboard) spawns
// DISPATCH_ONBOARD_CMD with DISPATCH_ONBOARD_REPO in the child env (a registered
// repo name/id OR a local path). THIS helper is that command; it resolves the target
// to an on-disk path and runs crew's real `repo onboard <path> --standalone`.
//
// Against the REAL helper (imported functions + a real --dry-run subprocess over a
// throwaway sqlite DB), proves:
//   AC1  resolveTarget takes an existing directory path straight through
//   AC2  resolveTarget maps a registered repo NAME → its local_path
//   AC3  resolveTarget maps a registered repo ID → its local_path
//   AC4  resolveTarget returns null for an unknown name + missing db + blank
//   AC5  buildCrewArgv = [<cli>, -c, <config>, repo, onboard, <path>, --standalone]
//   AC6  --dry-run resolves DISPATCH_ONBOARD_REPO (a path) → planned crew argv
//   AC7  --dry-run resolves a registered NAME → the repo's path
//   AC8  a missing DISPATCH_ONBOARD_REPO is REFUSED (exit 1, error JSON)
//   AC9  an unresolvable target is REFUSED (exit 1, error JSON)
//
// Zero deps (node:sqlite ships with Node 22+). Run: node test/onboard-run.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(HERE, "..", "bin", "onboard-run.mjs");
const { resolveTarget, resolveRepoPath, buildCrewArgv } = await import(HELPER);

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
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(label);
  else fail(`${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// --- Build a throwaway dispatch sqlite with the one table resolveRepoPath reads. ---
const WORKDIR = mkdtempSync(resolve(tmpdir(), "onboard-run-test-"));
const DB_PATH = resolve(WORKDIR, "dispatch.sqlite");
const REPO_PATH = resolve(WORKDIR, "demo-repo");
mkdirSync(REPO_PATH, { recursive: true });
{
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_PATH);
  db.exec(
    "CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, " +
      "local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main');",
  );
  db.prepare("INSERT INTO repositories (id,name,local_path,default_branch) VALUES (?,?,?,?)").run(
    "r1",
    "demo",
    REPO_PATH,
    "main",
  );
  db.close();
}

const CREW_DIR = resolve(WORKDIR, "crew");
const CREW_CONFIG = resolve(WORKDIR, "crew.yaml");
const CREW_CLI = resolve(CREW_DIR, "dist", "cli", "index.js");

// Run the helper as a CLI with --dry-run; return { code, out }.
function runCli(env = {}) {
  const res = spawnSync(process.execPath, [HELPER, "--dry-run"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DISPATCH_DB: DB_PATH,
      CREW_DIR,
      CREW_CONFIG,
      ...env,
    },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }
  return { code: res.status, out };
}

console.log("== AC1: resolveTarget takes an existing directory path straight through ==");
eq("existing dir → that path", resolveTarget(DB_PATH, REPO_PATH), REPO_PATH);

console.log("== AC2: resolveTarget maps a registered repo NAME → local_path ==");
eq("known name → its path", resolveTarget(DB_PATH, "demo"), REPO_PATH);

console.log("== AC3: resolveTarget maps a registered repo ID → local_path ==");
eq("known id → its path", resolveTarget(DB_PATH, "r1"), REPO_PATH);

console.log("== AC4: resolveTarget/resolveRepoPath null for unknown / missing db / blank ==");
eq("unknown name → null", resolveTarget(DB_PATH, "nope"), null);
eq("blank → null", resolveTarget(DB_PATH, "   "), null);
eq("missing db → null", resolveRepoPath(resolve(WORKDIR, "absent.sqlite"), "demo"), null);

console.log(
  "== AC5: buildCrewArgv = [<cli>, -c, <config>, repo, onboard, <path>, --standalone] ==",
);
{
  const argv = buildCrewArgv({
    crewDir: CREW_DIR,
    crewConfig: CREW_CONFIG,
    repoPath: REPO_PATH,
  });
  eq("crew onboard argv shape", argv, [
    CREW_CLI,
    "-c",
    CREW_CONFIG,
    "repo",
    "onboard",
    REPO_PATH,
    "--standalone",
  ]);
}

console.log("== AC6: --dry-run resolves a PATH target → planned crew argv ==");
{
  const { code, out } = runCli({ DISPATCH_ONBOARD_REPO: REPO_PATH });
  if (
    code === 0 &&
    out &&
    out.phase === "dry-run" &&
    out.repoPath === REPO_PATH &&
    Array.isArray(out.argv) &&
    out.argv.includes("onboard") &&
    out.argv.includes("--standalone") &&
    out.argv[0] === CREW_CLI
  ) {
    ok("dry-run path target → exit 0 + planned crew onboard argv");
  } else fail(`dry-run path wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC7: --dry-run resolves a registered NAME → the repo's path ==");
{
  const { code, out } = runCli({ DISPATCH_ONBOARD_REPO: "demo" });
  if (
    code === 0 &&
    out &&
    out.phase === "dry-run" &&
    out.repo === "demo" &&
    out.repoPath === REPO_PATH
  ) {
    ok("dry-run name target → resolved to its registered path");
  } else fail(`dry-run name wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC8: a missing DISPATCH_ONBOARD_REPO is REFUSED ==");
{
  const { code, out } = runCli({ DISPATCH_ONBOARD_REPO: "" });
  if (code !== 0 && out && out.phase === "error" && /required/i.test(out.error)) {
    ok("missing target → exit 1 + error JSON");
  } else fail(`missing-target refusal wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("== AC9: an unresolvable target is REFUSED ==");
{
  const { code, out } = runCli({ DISPATCH_ONBOARD_REPO: "definitely-not-a-repo" });
  if (code !== 0 && out && out.phase === "error" && /resolve/i.test(out.error)) {
    ok("unresolvable target → exit 1 + error JSON");
  } else fail(`unresolvable refusal wrong (code=${code}, out=${JSON.stringify(out)})`);
}

console.log("");
if (failures.length === 0) {
  console.log(`onboard-run: all ${passed} checks passed`);
  process.exit(0);
}
console.log(`onboard-run: ${failures.length} FAILED of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
