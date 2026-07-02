#!/usr/bin/env node
// =====================================================================
// TRUST-WORKSPACE containment tests (runner/lib/trust-workspace.mjs).
// ---------------------------------------------------------------------
// trust-workspace.mjs writes hasTrustDialogAccepted:true into the operator's REAL
// global ~/.claude.json, so its containment surface matters. This suite pins the
// tightened behaviour AND the existing safety invariants:
//   1. VALID factory worktree → trusted; the 22→23→22 project-count invariant
//      (trust adds one, the stale-worktree prune removes one) still holds, and
//      unrelated existing keys are preserved.
//   2. INVALID target (not a git worktree / not under an expected root) → REFUSED,
//      the config is left byte-identical.
//   3. LOCK CONTENTION → FAIL SAFE: no write (does not race last-writer-wins).
//   4. A committed `.claude/settings.local.json` in the target is NEUTRALIZED
//      (regular file → {} with a .gaffer-orig backup; symlink → unlinked).
//   5. UNPARSEABLE ~/.claude.json → refused, left untouched.
//
// Hermetic: HOME is redirected to a temp dir so the "global" config is a throwaway
// file; GAFFER_TRUST_WORKTREE_ROOT scopes the expected root; fake linked-worktree
// dirs (.git FILE with a gitdir: pointer) satisfy validation without real git.
// Run: node test/trust-workspace.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUST = resolve(HERE, "..", "lib", "trust-workspace.mjs");

let passed = 0;
const failures = [];
const ok = (m) => {
  passed++;
  console.log(`  ok   ${m}`);
};
const bad = (m) => {
  failures.push(m);
  console.log(`  FAIL ${m}`);
};
const assert = (m, cond) => (cond ? ok(m) : bad(m));

const ROOT = mkdtempSync(join(tmpdir(), "trust-ws-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

let homeSeq = 0;
/** Fresh temp HOME (so ~/.claude.json, its lock + backup never leak across cases). */
function freshHome() {
  const h = join(ROOT, `home-${homeSeq++}`);
  mkdirSync(h, { recursive: true });
  return h;
}

/** Create a fake LINKED git worktree under `base`: a dir whose `.git` is a FILE
 *  holding a gitdir pointer into a `.git/worktrees/…` path (the `git worktree add`
 *  shape trust-workspace validates), without needing real git. */
function makeWorktree(base, leaf) {
  const dir = join(base, leaf);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: /somewhere/.git/worktrees/${leaf}\n`);
  return dir;
}

function runTrust(target, { home, root, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [TRUST, target], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      GAFFER_TRUST_WORKTREE_ROOT: root,
      GAFFER_TRUST_LOCK_TRIES: "2",
      GAFFER_TRUST_LOCK_SLEEP_MS: "5",
      ...extraEnv,
    },
  });
}

const confPath = (home) => join(home, ".claude.json");
const readConf = (home) => JSON.parse(readFileSync(confPath(home), "utf8"));
const projectCount = (home) => Object.keys(readConf(home).projects || {}).length;

// ---------------------------------------------------------------------
console.log("== 1) valid worktree trusted + 22→23→22 project-count invariant ==");
{
  const home = freshHome();
  const wtBase = join(ROOT, "wt1", "worktrees");
  // Seed 22 projects: 21 unrelated (preserved) + 1 STALE worktree entry (pruned).
  const projects = {};
  for (let i = 0; i < 21; i++) projects[`/home/dev/project-${i}`] = { hasTrustDialogAccepted: true };
  const stale = "/tmp/does-not-exist/.gaffer/worktrees/ticket-99/repo";
  projects[stale] = { hasTrustDialogAccepted: true };
  writeFileSync(confPath(home), JSON.stringify({ numStartups: 7, projects }, null, 2));
  assert("seeded with 22 projects", projectCount(home) === 22);

  const target = makeWorktree(join(wtBase, "ticket-1"), "repo");
  const r = runTrust(target, { home, root: wtBase });
  assert("trust exited 0 for a valid worktree", r.status === 0);

  const conf = readConf(home);
  assert(
    "target marked trusted (hasTrustDialogAccepted:true)",
    conf.projects[target] && conf.projects[target].hasTrustDialogAccepted === true,
  );
  assert("22 → 23 (add) → 22 (prune stale) invariant holds", projectCount(home) === 22);
  assert("stale worktree entry pruned", !(stale in conf.projects));
  assert("unrelated project entry preserved", conf.projects["/home/dev/project-0"] != null);
  assert("unrelated top-level key preserved", conf.numStartups === 7);
}

// ---------------------------------------------------------------------
console.log("== 2) invalid target refused, config left byte-identical ==");
{
  // 2a: a real directory that is NOT a git worktree (no .git) and not under root.
  const home = freshHome();
  const seed = JSON.stringify({ projects: { "/home/dev/x": {} } }, null, 2);
  writeFileSync(confPath(home), seed);
  const plainDir = join(ROOT, "not-a-worktree");
  mkdirSync(plainDir, { recursive: true });
  const r = runTrust(plainDir, { home, root: join(ROOT, "wt2", "worktrees") });
  assert("refused a non-worktree path (exit != 0)", r.status !== 0);
  assert("config unchanged after refusal", readFileSync(confPath(home), "utf8") === seed);

  // 2b: a valid worktree but OUTSIDE the expected root and off the ticket-layout
  //     convention → refused too.
  const home2 = freshHome();
  writeFileSync(confPath(home2), seed);
  const outside = makeWorktree(join(ROOT, "elsewhere", "plainbase"), "repo");
  const r2 = runTrust(outside, { home: home2, root: join(ROOT, "wt2b", "worktrees") });
  assert("refused a worktree outside the expected root (exit != 0)", r2.status !== 0);
  assert("config unchanged after out-of-root refusal", readFileSync(confPath(home2), "utf8") === seed);
}

// ---------------------------------------------------------------------
console.log("== 3) lock contention → FAIL SAFE (no write) ==");
{
  const home = freshHome();
  const seed = JSON.stringify({ projects: {} }, null, 2);
  writeFileSync(confPath(home), seed);
  // Hold the lock so acquireLock can never win within the bounded spin.
  writeFileSync(confPath(home) + ".gaffer-trust.lock", "");
  const wtBase = join(ROOT, "wt3", "worktrees");
  const target = makeWorktree(join(wtBase, "ticket-1"), "repo");
  const r = runTrust(target, { home, root: wtBase });
  assert("lock-contended run exits 0 (best-effort, no crash)", r.status === 0);
  assert("lock-contended run did NOT write (config unchanged)", readFileSync(confPath(home), "utf8") === seed);
  assert("target was NOT trusted under contention", !(target in (readConf(home).projects || {})));
}

// ---------------------------------------------------------------------
console.log("== 4) committed .claude/settings.local.json neutralized ==");
{
  // 4a: a regular committed file → overwritten with {} + .gaffer-orig backup.
  const home = freshHome();
  writeFileSync(confPath(home), JSON.stringify({ projects: {} }, null, 2));
  const wtBase = join(ROOT, "wt4", "worktrees");
  const target = makeWorktree(join(wtBase, "ticket-1"), "repo");
  const claudeDir = join(target, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const localSettings = join(claudeDir, "settings.local.json");
  const dangerous = JSON.stringify({ permissions: { allow: ["Bash(*)", "WebFetch(*)"] } });
  writeFileSync(localSettings, dangerous);
  const r = runTrust(target, { home, root: wtBase });
  assert("trust still succeeds with a committed local settings", r.status === 0);
  assert("committed settings.local.json neutralized to {}", readFileSync(localSettings, "utf8").trim() === "{}");
  assert(
    "original committed settings backed up to .gaffer-orig",
    existsSync(localSettings + ".gaffer-orig") &&
      readFileSync(localSettings + ".gaffer-orig", "utf8") === dangerous,
  );

  // 4b: a SYMLINK settings.local.json is unlinked, never followed.
  const home2 = freshHome();
  writeFileSync(confPath(home2), JSON.stringify({ projects: {} }, null, 2));
  const wtBase2 = join(ROOT, "wt4b", "worktrees");
  const target2 = makeWorktree(join(wtBase2, "ticket-1"), "repo");
  const claudeDir2 = join(target2, ".claude");
  mkdirSync(claudeDir2, { recursive: true });
  const secret = join(ROOT, "operator-secret.json");
  writeFileSync(secret, JSON.stringify({ permissions: { allow: ["*"] } }));
  const link = join(claudeDir2, "settings.local.json");
  symlinkSync(secret, link);
  const r2 = runTrust(target2, { home: home2, root: wtBase2 });
  assert("trust succeeds with a symlinked local settings", r2.status === 0);
  let stillLink;
  try {
    stillLink = lstatSync(link).isSymbolicLink();
  } catch {
    stillLink = false;
  }
  assert("symlinked settings.local.json unlinked (not followed)", !stillLink);
  assert("symlink target (operator secret) left intact", readFileSync(secret, "utf8").includes('"*"'));
}

// ---------------------------------------------------------------------
console.log("== 5) unparseable ~/.claude.json → refused, left untouched ==");
{
  const home = freshHome();
  const junk = "{ this is : not json ,,, ";
  writeFileSync(confPath(home), junk);
  const wtBase = join(ROOT, "wt5", "worktrees");
  const target = makeWorktree(join(wtBase, "ticket-1"), "repo");
  const r = runTrust(target, { home, root: wtBase });
  assert("unparseable config → soft-fail exit 0", r.status === 0);
  assert("unparseable config left byte-identical", readFileSync(confPath(home), "utf8") === junk);
}

console.log();
if (failures.length === 0) {
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
