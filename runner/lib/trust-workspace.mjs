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
//   • an exclusive lock (lib/trust-lock.mjs) SERIALISES concurrent factory
//     deliveries. It records its holder's pid and start identity; a lock whose holder
//     is gone, that records no holder, or that is older than GAFFER_TRUST_LOCK_STALE_MS
//     (default 60 s) is stale and taken over atomically (one line is logged). A LIVE
//     holder is waited on for the bounded spin, then we skip the write rather than
//     race last-writer-wins.
//
// EXIT CODES: 0 trust written; 2 usage or a refused target; 3 trust NOT written (the
// lock stayed held, or ~/.claude.json could not be parsed). The runner treats any
// non-zero exit as "this workspace is untrusted" and launches no agent there
// (lib/tick-launch.sh gaffer_trust_workspace): an agent whose project permissions are
// ignored cannot read its ticket, run the tests or commit, so it must not run at all.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  copyFileSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { acquireTrustLock } from "./trust-lock.mjs";
import { UnsafePathError, checkPath, safeCopyFile, safeWriteFile } from "./safe-write.mjs";

const target = process.argv[2];
if (!target || !target.startsWith("/")) {
  console.error("usage: trust-workspace.mjs <absolute-path>");
  process.exit(2);
}

const CONF = join(homedir(), ".claude.json");
const LOCK = CONF + ".gaffer-trust.lock";
const TMP = CONF + ".gaffer-trust.tmp";
const BAK = CONF + ".gaffer-bak";

/** Exit code for "trust was NOT written": the caller must not launch an agent here. */
const EXIT_NOT_WRITTEN = 3;

// Lock spin bounds — env-tunable so tests can force fast contention. Defaults keep
// the historical ~3s ceiling (60 × 50ms). The stale bound: a lock older than this is
// a hung or dead holder's and is taken over.
const LOCK_TRIES =
  Number(process.env.GAFFER_TRUST_LOCK_TRIES) > 0
    ? Number(process.env.GAFFER_TRUST_LOCK_TRIES)
    : 60;
const LOCK_SLEEP_MS =
  Number(process.env.GAFFER_TRUST_LOCK_SLEEP_MS) > 0
    ? Number(process.env.GAFFER_TRUST_LOCK_SLEEP_MS)
    : 50;
const LOCK_STALE_MS =
  Number(process.env.GAFFER_TRUST_LOCK_STALE_MS) > 0
    ? Number(process.env.GAFFER_TRUST_LOCK_STALE_MS)
    : 60_000;

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
 *  deterministic throwaway-worktree layouts: the delivery worktree
 *  (.../worktrees/ticket-<id>/<key>) and the reviewer's (.../worktrees/review-wt-<id>). */
function isUnderExpectedRoot(norm) {
  for (const r of expectedRoots()) {
    if (norm === r || norm.startsWith(r + sep)) return true;
  }
  // The factory always lays worktrees out as `<data>/worktrees/ticket-<num>/<key>`
  // (tick.sh WORKTREES_BASE) or `<data>/worktrees/review-wt-<num>` (lib/review.sh's
  // throwaway reviewer worktree) — accept those shapes even when no root var reaches
  // us. GAFFER_DATA is not exported to this child on a live run, so before the
  // review shape was listed every review pass logged "refusing … not under an
  // expected factory worktree root" and the reviewer ran untrusted.
  return /[/\\]worktrees[/\\](ticket|review-wt)-[^/\\]+[/\\]/.test(norm + sep);
}

/** Upper bound on factory worktree trust entries kept in ~/.claude.json. Dead ones are
 *  always pruned; this caps LIVE ones too (orphaned worktrees a crash left behind), so
 *  the operator's global config stays bounded whatever happens on disk. Trust is read
 *  when `claude` starts and re-written before every agent call, so dropping the oldest
 *  live entry never affects a running agent. */
const MAX_FACTORY_WORKTREE_ENTRIES = 200;

/** True iff `p` is a trust entry the factory created for a throwaway worktree. */
function isFactoryWorktreeEntry(p) {
  if (typeof p !== "string" || !p.startsWith("/")) return false;
  return isUnderExpectedRoot(resolve(p));
}

/** Prune dead factory-worktree entries, then cap the survivors (oldest first — JSON
 *  object order is insertion order). `keep` (the path being trusted now) is never
 *  removed. Entries that are not the factory's are never touched. */
function pruneFactoryWorktreeEntries(projects, keep) {
  const live = [];
  for (const p of Object.keys(projects)) {
    if (p === keep || !isFactoryWorktreeEntry(p)) continue;
    if (!existsSync(p)) delete projects[p];
    else live.push(p);
  }
  // The entry about to be (re)written counts toward the cap.
  const excess = live.length + 1 - MAX_FACTORY_WORKTREE_ENTRIES;
  for (let i = 0; i < excess; i++) delete projects[live[i]];
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
 * A symlink AT settings.local.json is unlinked (never followed: it could point at the
 * operator's real settings); a regular file is backed up (.gaffer-orig, best-effort)
 * then overwritten with an empty `{}` so Claude Code reads no widened permissions.
 * Every write goes through lib/safe-write.mjs: a `.claude` that is a symlink (or not a
 * directory) is never written through, and neither is a committed `.gaffer-orig` link.
 * Returns an UnsafePathError when `.claude` (or the file) cannot be written safely: the
 * caller refuses to trust the workspace, so no agent runs there (fail closed). Other
 * failures stay best-effort, as before.
 */
function neutralizeCommittedLocalSettings(dir) {
  try {
    checkPath(dir, ".claude", "dir");
  } catch (err) {
    if (err instanceof UnsafePathError) return err;
    return null;
  }
  const localSettings = join(dir, ".claude", "settings.local.json");
  let st;
  try {
    st = lstatSync(localSettings);
  } catch {
    return null; // absent → nothing to neutralize
  }
  try {
    if (st.isSymbolicLink()) {
      unlinkSync(localSettings);
      console.error(
        `trust-workspace: neutralized a SYMLINKED .claude/settings.local.json in ${dir}`,
      );
      return null;
    }
    try {
      safeCopyFile(dir, ".claude/settings.local.json.gaffer-orig", localSettings);
    } catch {
      /* backup is best-effort (a committed .gaffer-orig link is refused, not followed) */
    }
    safeWriteFile(dir, ".claude/settings.local.json", "{}\n");
    console.error(`trust-workspace: neutralized committed .claude/settings.local.json in ${dir}`);
  } catch (err) {
    if (err instanceof UnsafePathError) return err;
    /* neutralization is best-effort — a failure must not block trusting */
  }
  return null;
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
  const unsafe = neutralizeCommittedLocalSettings(target);
  if (unsafe) {
    console.error(`trust-workspace: ${unsafe.message}; trust NOT written for ${target}`);
    process.exit(2);
  }
}

// 3) Acquire the lock (taking a stale one over); a LIVE holder for the whole spin means
// we skip the write rather than race, and say so with EXIT_NOT_WRITTEN.
const lock = acquireTrustLock(LOCK, {
  tries: LOCK_TRIES,
  sleepMs: LOCK_SLEEP_MS,
  staleMs: LOCK_STALE_MS,
});
if (!lock.ok) {
  const who = lock.holder?.pid ? `held by live pid ${lock.holder.pid}` : "held";
  console.error(
    `trust-workspace: could not acquire lock ${LOCK} (${who}); trust NOT written for ${target}. If no factory run is writing trust right now, remove the stale lock.`,
  );
  process.exit(EXIT_NOT_WRITTEN);
}

class NotWritten extends Error {}

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
      console.error(
        `trust-workspace: ${CONF} is not valid JSON; refusing to modify it, trust NOT written for ${target}`,
      );
      process.exitCode = EXIT_NOT_WRITTEN; // the finally below releases the lock first
      throw new NotWritten();
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
  // (worktrees are torn down after each delivery). An entry is the factory's when it
  // sits under an expected worktree root ($GAFFER_DATA/worktrees,
  // GAFFER_TRUST_WORKTREE_ROOT) or has the factory's throwaway-worktree shape — NOT
  // only when its path contains `/.gaffer/worktrees/`: that literal missed every
  // worktree made under a non-default GAFFER_DATA (containers, tests, custom data
  // dirs), and one operator config reached 3,700 dead entries.
  pruneFactoryWorktreeEntries(conf.projects, target);

  const cur =
    conf.projects[target] && typeof conf.projects[target] === "object" ? conf.projects[target] : {};
  conf.projects[target] = {
    ...cur,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };

  writeFileSync(TMP, JSON.stringify(conf, null, 2));
  renameSync(TMP, CONF); // atomic on the same filesystem
} catch (e) {
  if (!(e instanceof NotWritten)) throw e;
} finally {
  lock.release();
}
