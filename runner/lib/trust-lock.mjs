// trust-lock.mjs: the exclusive lock trust-workspace.mjs holds while it rewrites
// ~/.claude.json, with recovery from a lock its holder left behind.
//
// WHY: the lock used to be a bare O_EXCL file with nothing in it, and any lock that
// existed was "contended". A zero-byte lock left by a killed run (or a test run in the
// operator's HOME) therefore made every later trust write give up, and every agent ran
// with its project permissions ignored until someone deleted the file by hand.
//
// Now the lock is created WITH its content in one step (a temp file hard-linked into
// place, so no reader ever sees a half-written lock from this code) and records the
// holder's pid and start identity (as runner/bin/merge-ticket.mjs's ticket locks do).
// A lock is STALE, and taken over, when:
//   • its holder pid is gone, or now runs another process (the start identity differs);
//   • it records no holder (empty or unreadable) and is past a short grace (a writer
//     from an older version creates the file before it is filled);
//   • it is older than `staleMs` (GAFFER_TRUST_LOCK_STALE_MS, default 60 s): a trust
//     write takes milliseconds, so a holder that old is hung.
// A takeover runs under a second, short-lived O_EXCL lock (`<lock>.takeover`) and
// re-reads the lock inside it, then renames the stale file aside and takes the lock
// with the same exclusive create: two takers that both saw one stale lock cannot both
// win (the second finds the takeover lock held, or the first one's live lock).
// A live holder is waited on for the bounded spin and then reported, never broken.

import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";

const EMPTY_GRACE_MS = 2000;
const TAKEOVER_STALE_MS = 10_000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A process's start identity: on Linux the boot id and the start time in clock ticks
 * from /proc; elsewhere the start time `ps` reports. Null when it cannot be read.
 * Mirrors processStartId in runner/bin/merge-ticket.mjs (not imported: that module
 * pulls in the whole merge path, and this runs before every agent launch).
 */
export function processStartId(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = fields[19]; // field 22 of /proc/<pid>/stat: starttime
    let boot = "";
    try {
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      /* no boot id: the start time alone */
    }
    if (ticks && /^[0-9]+$/.test(ticks)) return `linux:${boot}:${ticks}`;
  } catch {
    /* not Linux, or the process is gone */
  }
  if (process.platform === "linux") return null;
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
    });
    const out = String(r.stdout ?? "").trim();
    return r.status === 0 && out ? `ps:${out}` : null;
  } catch {
    return null;
  }
}

/** The lock as it is on disk now: null when absent. */
function readLock(lockPath) {
  let st;
  try {
    st = statSync(lockPath);
  } catch {
    return null;
  }
  let raw = "";
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    /* unreadable: judged as recording no holder */
  }
  let pid = 0;
  let started = "";
  try {
    const rec = JSON.parse(raw);
    pid = Number.isInteger(rec?.pid) && rec.pid > 0 ? rec.pid : 0;
    started = typeof rec?.started === "string" ? rec.started : "";
  } catch {
    /* empty or not ours */
  }
  return { ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs, raw, pid, started };
}

/** Why `h` is stale, or "" when its holder may still be using it. */
function staleReason(h, staleMs) {
  const age = Date.now() - h.mtimeMs;
  if (age > staleMs)
    return `older than ${Math.round(staleMs / 1000)}s (${Math.round(age / 1000)}s)`;
  if (!h.pid) return age >= Math.min(EMPTY_GRACE_MS, staleMs) ? "it records no holder" : "";
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    if (e?.code !== "EPERM") return `holder pid ${h.pid} is gone`;
  }
  if (h.started) {
    const now = processStartId(h.pid);
    if (now && now !== h.started) return `pid ${h.pid} now runs another process`;
  }
  return "";
}

/**
 * acquireTrustLock(lockPath, opts) → { ok: true, release } | { ok: false, holder }
 * opts: tries, sleepMs (the bounded spin), staleMs, log (one line per takeover),
 * pid (the holder recorded; default this process), afterStaleRead (tests only: runs
 * between judging a lock stale and taking it over, the window a racing taker uses).
 */
export function acquireTrustLock(lockPath, opts = {}) {
  const tries = opts.tries > 0 ? opts.tries : 60;
  const sleep = opts.sleepMs > 0 ? opts.sleepMs : 50;
  const staleMs = opts.staleMs > 0 ? opts.staleMs : 60_000;
  const log = opts.log || ((m) => console.error(m));
  const pid = opts.pid || process.pid;
  const content =
    JSON.stringify({ pid, started: processStartId(pid) || "", at: new Date().toISOString() }) +
    "\n";
  let seq = 0;

  // Create the lock with its content in one step: a filled temp file hard-linked into
  // place (link fails if the lock exists). A filesystem without hard links falls back
  // to an exclusive create followed by the write.
  const take = () => {
    const tmp = `${lockPath}.${pid}.${seq++}.new`;
    try {
      writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
    } catch {
      return takeByOpen();
    }
    try {
      linkSync(tmp, lockPath);
      return true;
    } catch (e) {
      if (e?.code === "EEXIST") return false;
      return takeByOpen();
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* gone */
      }
    }
  };
  const takeByOpen = () => {
    let fd;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch {
      return false;
    }
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return true;
  };
  const release = () => {
    try {
      if (readFileSync(lockPath, "utf8") === content) unlinkSync(lockPath);
    } catch {
      /* already gone, or another holder's now */
    }
  };

  // Take a stale lock over: under the takeover lock, re-read it (it must still be the
  // same stale file), rename it aside, then take the lock like any acquirer.
  const takeover = (seen, why) => {
    const mutex = `${lockPath}.takeover`;
    try {
      closeSync(openSync(mutex, "wx", 0o600));
    } catch {
      try {
        if (Date.now() - statSync(mutex).mtimeMs > TAKEOVER_STALE_MS) unlinkSync(mutex);
      } catch {
        /* gone */
      }
      return false;
    }
    try {
      const now = readLock(lockPath);
      if (!now) return take();
      if (now.ino !== seen.ino || now.dev !== seen.dev || !staleReason(now, staleMs)) return false;
      const aside = `${lockPath}.stale.${pid}.${Date.now()}`;
      try {
        renameSync(lockPath, aside);
      } catch {
        return false;
      }
      let moved = null;
      try {
        moved = statSync(aside);
      } catch {
        /* checked below */
      }
      if (!moved || moved.ino !== seen.ino || moved.dev !== seen.dev) {
        // Not the file we judged: put it back and leave it to its holder.
        try {
          linkSync(aside, lockPath);
        } catch {
          /* a new lock is already in place */
        }
        try {
          unlinkSync(aside);
        } catch {
          /* gone */
        }
        return false;
      }
      try {
        unlinkSync(aside);
      } catch {
        /* best-effort */
      }
      if (!take()) return false;
      log(`trust-workspace: took over a stale lock (${why}) at ${lockPath}`);
      return true;
    } finally {
      try {
        unlinkSync(mutex);
      } catch {
        /* gone */
      }
    }
  };

  let last = null;
  for (let i = 0; i < tries; i++) {
    if (take()) return { ok: true, release };
    const seen = readLock(lockPath);
    if (!seen) continue; // released between our create and our read: try again now
    last = seen;
    const why = staleReason(seen, staleMs);
    if (why) {
      if (opts.afterStaleRead) opts.afterStaleRead();
      if (takeover(seen, why)) return { ok: true, release };
    }
    sleepMs(sleep);
  }
  return { ok: false, holder: last ? { pid: last.pid, raw: last.raw.slice(0, 200) } : null };
}
