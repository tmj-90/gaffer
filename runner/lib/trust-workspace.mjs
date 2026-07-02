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
//   • never write if the existing file can't be parsed (refuse, don't clobber);
//   • preserve every existing key — only touch projects[<path>] + prune stale
//     worktree entries whose directory no longer exists;
//   • write to a temp file + atomic rename (the real file is never half-written);
//   • a one-time backup (~/.claude.json.gaffer-bak) guards against a logic slip;
//   • an O_EXCL lock serialises concurrent factory deliveries.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = process.argv[2];
if (!target || !target.startsWith("/")) {
  console.error("usage: trust-workspace.mjs <absolute-path>");
  process.exit(2);
}

const CONF = join(homedir(), ".claude.json");
const LOCK = CONF + ".gaffer-trust.lock";
const TMP = CONF + ".gaffer-trust.tmp";
const BAK = CONF + ".gaffer-bak";

/** Sleep synchronously (no deps) so the lock can spin without a busy loop. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Best-effort exclusive lock; proceed after a bounded wait rather than block a delivery. */
function acquireLock() {
  for (let i = 0; i < 60; i++) {
    try {
      return openSync(LOCK, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") return undefined;
      sleepMs(50);
    }
  }
  return undefined; // stale/contended lock — proceed anyway (atomic rename keeps the file valid)
}

function releaseLock(fd) {
  if (fd !== undefined) closeSync(fd);
  try {
    unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
}

const fd = acquireLock();
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
