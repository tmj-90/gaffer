#!/usr/bin/env node
// trust-workspace.mjs — mark a factory worktree as a TRUSTED Claude Code
// workspace so headless `claude -p` honours the project `.claude/settings.json`
// permission allowlist.
//
// WHY: Claude Code IGNORES a project's `.claude/settings.json` permissions in a
// directory that has not been "trusted" (the interactive "Do you trust the files
// in this folder?" dialog). Each delivery runs in a fresh, never-seen worktree →
// untrusted → the broad allowlist the factory installs is ignored → the agent
// hits a permission prompt on its first MCP tool call and, being headless, hangs
// forever. This marks the worktree trusted the same way the dialog would, so the
// allowlist is honoured. The PreToolUse safety-hook remains THE real boundary —
// this only stops the agent deadlocking on a prompt no one can answer.
//
// This is the operator-endorsed fix (configure ~/.claude.json) rather than
// `--dangerously-skip-permissions`.
//
// SAFETY (this file is the operator's global Claude config, with real credentials):
//   • ONLY trust a path that is an ACTUAL git worktree UNDER an expected factory
//     root (not just any absolute path) — a caller/injection can't hand us an
//     arbitrary directory to bless (see validateTarget);
//   • neutralize a repo-committed `.claude/settings.local.json` in the target so a
//     malicious target repo cannot widen the agent's (non-filesystem) tool perms;
//   • never write if the existing file can't be parsed (refuse, don't clobber);
//   • preserve every existing key — only touch projects[<path>] + prune stale
//     worktree entries whose directory no longer exists;
//   • write to a temp file + atomic rename (the real file is never half-written);
//   • a one-time backup (~/.claude.json.gaffer-bak) guards against a logic slip;
//   • an O_EXCL lock SERIALISES concurrent factory deliveries — on lock contention
//     we FAIL SAFE (skip the write) rather than race last-writer-wins.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
  copyFileSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const target = process.argv[2];
if (!target || !target.startsWith("/")) {
  console.error("usage: trust-workspace.mjs <absolute-path>");
  process.exit(2);
}

const CONF = join(homedir(), ".claude.json");
const LOCK = CONF + ".gaffer-trust.lock";
const TMP = CONF + ".gaffer-trust.tmp";
const BAK = CONF + ".gaffer-bak";

// Lock spin bounds — env-tunable so tests can force fast contention. Defaults keep
// the historical ~3s ceiling (60 × 50ms).
const LOCK_TRIES =
  Number(process.env.GAFFER_TRUST_LOCK_TRIES) > 0
    ? Number(process.env.GAFFER_TRUST_LOCK_TRIES)
    : 60;
const LOCK_SLEEP_MS =
  Number(process.env.GAFFER_TRUST_LOCK_SLEEP_MS) > 0
    ? Number(process.env.GAFFER_TRUST_LOCK_SLEEP_MS)
    : 50;

/**
 * The roots under which a path is allowed to be trusted. An explicit
 * GAFFER_TRUST_WORKTREE_ROOT wins (tests / non-standard layouts); GAFFER_DATA (when
 * exported) contributes its `worktrees/` subtree. Both are best-effort — a path is
 * ALSO accepted by the deterministic factory layout convention below, so real runs
 * (where neither var is exported to this child) still validate.
 */
function expectedRoots() {
  const roots = [];
  const push = (p) => {
    if (!p) return;
    try {
      roots.push(resolve(p));
    } catch {
      /* ignore an unresolvable root */
    }
  };
  push(process.env.GAFFER_TRUST_WORKTREE_ROOT);
  if (process.env.GAFFER_DATA) push(join(process.env.GAFFER_DATA, "worktrees"));
  return roots;
}

/** True iff `norm` sits under an explicit expected root OR matches the factory's
 *  deterministic throwaway-worktree layout (.../worktrees/ticket-<id>/...). */
function isUnderExpectedRoot(norm) {
  for (const r of expectedRoots()) {
    if (norm === r || norm.startsWith(r + sep)) return true;
  }
  // The factory always lays worktrees out as `<data>/worktrees/ticket-<num>/<key>`
  // (tick.sh WORKTREES_BASE) — accept that shape even when no root var reaches us.
  return /[/\\]worktrees[/\\]ticket-[^/\\]+[/\\]/.test(norm + sep);
}

/** True iff `dir` is a LINKED git worktree: its `.git` is a FILE holding a
 *  `gitdir: …/.git/worktrees/<name>` pointer. A normal repo root (a `.git`
 *  DIRECTORY) or an arbitrary folder is rejected — only the factory's `git worktree
 *  add` products pass, so a malicious full clone handed to us can't be blessed. */
function isLinkedGitWorktree(dir) {
  const dotgit = join(dir, ".git");
  let st;
  try {
    st = lstatSync(dotgit);
  } catch {
    return false;
  }
  if (!st.isFile()) return false; // a real repo root has a .git DIRECTORY → reject
  let pointer;
  try {
    pointer = readFileSync(dotgit, "utf8");
  } catch {
    return false;
  }
  return /^gitdir:\s*\S.*[/\\]\.git[/\\]worktrees[/\\]\S+/m.test(pointer.trim());
}

/** True iff `dir` is a full git repository ROOT (a `.git` DIRECTORY) — as opposed to
 *  a linked worktree (`.git` FILE). The factory's onboarded repos (PRIMARY_REPO, the
 *  clarify clone) and greenfield bootstrap targets are these. */
function isGitRepoRoot(dir) {
  try {
    return lstatSync(join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}

/** Validate the target before touching any config. Returns true when the path is one
 *  the factory is allowed to trust; logs + returns false otherwise. Two shapes pass:
 *  (1) a LINKED delivery worktree strictly under the factory's worktree root (the
 *  high-frequency path); (2) a FULL git repo the factory itself named and vouches for
 *  via GAFFER_TRUST_ALLOW_REPO=1 (PRIMARY_REPO, the clarify clone, or a greenfield
 *  bootstrap it just created) — never an arbitrary path. A committed
 *  settings.local.json is neutralized (below) for either shape. */
function validateTarget(dir) {
  const norm = resolve(dir);
  if (!existsSync(dir)) {
    console.error(`trust-workspace: refusing — ${dir} does not exist`);
    return false;
  }
  // (1) linked delivery worktree — strictly under the factory's worktree root.
  if (isLinkedGitWorktree(dir)) {
    if (!isUnderExpectedRoot(norm)) {
      console.error(
        `trust-workspace: refusing — ${dir} is not under an expected factory worktree root`,
      );
      return false;
    }
    return true;
  }
  // (2) full git repo the factory named + vouches for (PRIMARY_REPO / clarify clone /
  // greenfield bootstrap). Only with the explicit vouch, and only a real git repo.
  if (process.env.GAFFER_TRUST_ALLOW_REPO === "1" && isGitRepoRoot(dir)) {
    return true;
  }
  console.error(
    `trust-workspace: refusing — ${dir} is neither a factory worktree nor a vouched git repo`,
  );
  return false;
}

/**
 * Neutralize a repo-committed `.claude/settings.local.json` in the target worktree.
 * A malicious target repo could commit one to widen the agent's (non-filesystem)
 * tool permissions; filesystem writes stay hook-gated, but we close this anyway.
 * Best-effort: a symlink is unlinked (never followed — it could point at the
 * operator's real settings); a regular file is backed up (.gaffer-orig) then
 * overwritten with an empty `{}` so Claude Code reads no widened permissions.
 */
function neutralizeCommittedLocalSettings(dir) {
  const localSettings = join(dir, ".claude", "settings.local.json");
  let st;
  try {
    st = lstatSync(localSettings);
  } catch {
    return; // absent → nothing to neutralize
  }
  try {
    if (st.isSymbolicLink()) {
      unlinkSync(localSettings);
      console.error(
        `trust-workspace: neutralized a SYMLINKED .claude/settings.local.json in ${dir}`,
      );
      return;
    }
    try {
      copyFileSync(localSettings, localSettings + ".gaffer-orig");
    } catch {
      /* backup is best-effort */
    }
    writeFileSync(localSettings, "{}\n");
    console.error(`trust-workspace: neutralized committed .claude/settings.local.json in ${dir}`);
  } catch {
    /* neutralization is best-effort — a failure must not block trusting */
  }
}

/** Sleep synchronously (no deps) so the lock can spin without a busy loop. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Exclusive O_EXCL lock. Returns the fd on success, or undefined if it could not be
 * acquired (contended for the whole window, or an open error). Callers FAIL SAFE on
 * undefined — they must NOT proceed to write (no last-writer-wins race on the
 * operator's real config).
 */
function acquireLock() {
  for (let i = 0; i < LOCK_TRIES; i++) {
    try {
      return openSync(LOCK, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") return undefined;
      sleepMs(LOCK_SLEEP_MS);
    }
  }
  return undefined; // contended → caller fails safe (does NOT write)
}

function releaseLock(fd) {
  if (fd !== undefined) closeSync(fd);
  try {
    unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
}

// 1) VALIDATE before touching anything — refuse a path that isn't a factory worktree.
if (!validateTarget(target)) process.exit(2);

// 2) Neutralize any committed local settings in the (validated) worktree. Skipped
// under GAFFER_TRUST_KEY_ONLY: when the caller ALSO trusts a worktree's MAIN repo
// root (Claude keys a worktree's trust on the main repo, so the allowlist is only
// honoured when THAT path is trusted), the live agent still runs in the WORKTREE —
// whose own settings.local.json was neutralized by the worktree's trust pass — so
// mutating the onboarded repo's working tree here would be a gratuitous, surprising
// change to the user's repo. Only the trust-key write is needed for the main root.
if (process.env.GAFFER_TRUST_KEY_ONLY !== "1") {
  neutralizeCommittedLocalSettings(target);
}

// 3) Acquire the lock; FAIL SAFE (skip the write) on contention rather than racing.
const fd = acquireLock();
if (fd === undefined) {
  console.error(
    "trust-workspace: could not acquire lock (contended) — skipping the write to avoid a racy last-writer-wins update of ~/.claude.json",
  );
  process.exit(0); // best-effort: a possible prompt-hang beats a corrupted config
}

try {
  // Missing file → we may create it. Present-but-unparseable → REFUSE (never
  // destroy an operator config we don't understand).
  let raw = null;
  try {
    raw = readFileSync(CONF, "utf8");
  } catch {
    raw = null;
  }
  let conf;
  if (raw === null) {
    conf = {};
  } else {
    try {
      conf = JSON.parse(raw);
    } catch {
      console.error("trust-workspace: ~/.claude.json is not valid JSON — refusing to modify it");
      process.exit(0); // soft-fail: the delivery may prompt, but the config is safe
    }
    if (!existsSync(BAK)) {
      try {
        copyFileSync(CONF, BAK);
      } catch {
        /* backup is best-effort */
      }
    }
  }

  if (!conf.projects || typeof conf.projects !== "object") conf.projects = {};

  // Prune stale factory-worktree trust entries so the config doesn't grow forever
  // (worktrees are torn down after each delivery).
  for (const p of Object.keys(conf.projects)) {
    if (p.includes("/.gaffer/worktrees/") && p !== target && !existsSync(p)) {
      delete conf.projects[p];
    }
  }

  const cur =
    conf.projects[target] && typeof conf.projects[target] === "object" ? conf.projects[target] : {};
  conf.projects[target] = {
    ...cur,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };

  writeFileSync(TMP, JSON.stringify(conf, null, 2));
  renameSync(TMP, CONF); // atomic on the same filesystem
} finally {
  releaseLock(fd);
}
