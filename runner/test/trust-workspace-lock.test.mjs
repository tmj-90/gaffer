#!/usr/bin/env node
// =====================================================================
// TRUST-WORKSPACE LOCK: a stale lock is recovered, a live one is respected, and a
// skipped trust write is reported as a failure (runner/lib/trust-lock.mjs and
// runner/lib/trust-workspace.mjs).
// ---------------------------------------------------------------------
// The live run this pins: a ZERO-BYTE ~/.claude.json.gaffer-trust.lock left by an
// earlier run made every trust write give up as "contended" and exit 0, so every
// agent ran with its project permissions ignored. Now:
//   1. a stale EMPTY lock (old, no holder recorded) is taken over and trust is written;
//   2. a lock held by a LIVE process is waited on, then refused with a distinct
//      non-zero exit (3) and no write;
//   3. a lock whose holder pid is DEAD is taken over;
//   4. a lock whose pid now runs ANOTHER process (start identity differs) is taken over;
//   5. a lock older than GAFFER_TRUST_LOCK_STALE_MS is taken over even if its pid runs;
//   6. while held, the lock carries the holder's pid and start identity; the trust
//      run leaves no lock behind; a release never removes another holder's lock;
//   7. two concurrent takers of ONE stale lock: exactly one wins;
//   8. an unparseable ~/.claude.json is a skipped write too: exit 3, file untouched.
// Hermetic: every case has its own scratch HOME; nothing reads or writes the real
// ~/.claude.json or its lock. Run: node runner/test/trust-workspace-lock.test.mjs
// =====================================================================
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUST = resolve(HERE, "..", "lib", "trust-workspace.mjs");
const LOCKLIB = resolve(HERE, "..", "lib", "trust-lock.mjs");

let passed = 0;
const failures = [];
const assert = (m, cond) => {
  if (cond) {
    passed++;
    console.log(`  ok   ${m}`);
  } else {
    failures.push(m);
    console.log(`  FAIL ${m}`);
  }
};

const ROOT = gafferMkdtemp(join(tmpdir(), "trust-lock-"));
const kids = [];
process.on("exit", () => {
  for (const k of kids) {
    try {
      k.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(ROOT, { recursive: true, force: true });
});

// Never the operator's home: the scratch homes live under ROOT.
const REAL_HOME = homedir();
let seq = 0;
function freshHome() {
  const h = join(ROOT, `home-${seq++}`);
  mkdirSync(h, { recursive: true });
  if (resolve(h) === resolve(REAL_HOME)) throw new Error("scratch HOME resolved to the real HOME");
  return h;
}
const confPath = (home) => join(home, ".claude.json");
const lockPath = (home) => confPath(home) + ".gaffer-trust.lock";

function makeWorktree(leaf) {
  const base = join(ROOT, `wt-${seq++}`, "worktrees");
  const dir = join(base, "ticket-1", leaf);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: /somewhere/.git/worktrees/${leaf}\n`);
  return { dir, base };
}

function runTrust(home, extraEnv = {}) {
  const { dir, base } = makeWorktree("repo");
  const env = { ...process.env, HOME: home, GAFFER_TRUST_WORKTREE_ROOT: base, ...extraEnv };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [TRUST, dir], { encoding: "utf8", env, timeout: 30000 });
  return { ...r, ms: Date.now() - t0, target: dir };
}
const trusted = (home, target) => {
  try {
    const c = JSON.parse(readFileSync(confPath(home), "utf8"));
    return c.projects?.[target]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
};
const backdate = (p, secondsAgo) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(p, t, t);
};

/** A live process that is not this test (so killing it is safe). */
function sleeper() {
  const k = spawn("sleep", ["60"], { stdio: "ignore" });
  kids.push(k);
  return k;
}
/** A pid that has exited (and was reaped). */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(r.stdout);
}

const FAST = { GAFFER_TRUST_LOCK_TRIES: "4", GAFFER_TRUST_LOCK_SLEEP_MS: "50" };

// ---------------------------------------------------------------------
console.log("== 1) a stale EMPTY lock (left by an earlier run) is taken over ==");
{
  const home = freshHome();
  writeFileSync(confPath(home), JSON.stringify({ projects: {} }));
  writeFileSync(lockPath(home), "");
  backdate(lockPath(home), 5 * 24 * 3600); // the live run's lock was five days old
  const r = runTrust(home, FAST);
  assert(
    `exit 0 over a stale empty lock (got ${r.status}; ${r.stderr.trim().slice(0, 200)})`,
    r.status === 0,
  );
  assert("trust was written over the stale empty lock", trusted(home, r.target));
  assert(
    "one line says the stale lock was taken over",
    /stale/i.test(r.stderr) && /took over|taking over|taken over/i.test(r.stderr),
  );
  assert("no lock is left behind", !existsSync(lockPath(home)));
}

// ---------------------------------------------------------------------
console.log("== 2) a lock held by a LIVE process is waited on, then refused (exit 3, no write) ==");
{
  const home = freshHome();
  const before = JSON.stringify({ projects: { "/keep": { x: 1 } } });
  writeFileSync(confPath(home), before);
  const k = sleeper();
  writeFileSync(lockPath(home), JSON.stringify({ pid: k.pid }) + "\n");
  const r = runTrust(home, FAST);
  assert(`a live holder → exit 3 (got ${r.status})`, r.status === 3);
  assert(`it waited the bounded spin first (${r.ms} ms ≥ 150 ms)`, r.ms >= 150);
  assert("no write under a live holder", readFileSync(confPath(home), "utf8") === before);
  assert(
    "the live holder's lock is left alone",
    existsSync(lockPath(home)) && readFileSync(lockPath(home), "utf8").includes(String(k.pid)),
  );
  assert("stderr says trust was NOT written", /not written|could not acquire/i.test(r.stderr));
}

// ---------------------------------------------------------------------
console.log("== 3) a lock whose holder pid is DEAD is taken over ==");
{
  const home = freshHome();
  writeFileSync(confPath(home), JSON.stringify({ projects: {} }));
  writeFileSync(lockPath(home), JSON.stringify({ pid: deadPid() }) + "\n");
  const r = runTrust(home, FAST);
  assert(
    `exit 0 over a dead holder (got ${r.status}; ${r.stderr.trim().slice(0, 200)})`,
    r.status === 0,
  );
  assert("trust written over a dead holder's lock", trusted(home, r.target));
}

// ---------------------------------------------------------------------
console.log(
  "== 4) a lock whose pid now names ANOTHER process (start identity differs) is taken over ==",
);
{
  const home = freshHome();
  writeFileSync(confPath(home), JSON.stringify({ projects: {} }));
  const k = sleeper();
  writeFileSync(
    lockPath(home),
    JSON.stringify({ pid: k.pid, started: "linux:not-this-boot:1" }) + "\n",
  );
  const r = runTrust(home, FAST);
  if (process.platform === "linux") {
    assert(
      `exit 0 over a reused pid (got ${r.status}; ${r.stderr.trim().slice(0, 200)})`,
      r.status === 0,
    );
    assert("trust written over a reused pid's lock", trusted(home, r.target));
  } else {
    assert(
      "non-Linux: a reused-pid lock never yields a write without the lock",
      r.status === 0 || r.status === 3,
    );
  }
}

// ---------------------------------------------------------------------
console.log("== 5) a lock older than GAFFER_TRUST_LOCK_STALE_MS is taken over (a hung holder) ==");
{
  const home = freshHome();
  writeFileSync(confPath(home), JSON.stringify({ projects: {} }));
  const k = sleeper();
  writeFileSync(lockPath(home), JSON.stringify({ pid: k.pid }) + "\n");
  backdate(lockPath(home), 10);
  const r = runTrust(home, { ...FAST, GAFFER_TRUST_LOCK_STALE_MS: "2000" });
  assert(`exit 0 over an over-age lock (got ${r.status})`, r.status === 0);
  assert("trust written over an over-age lock", trusted(home, r.target));
  // And the same lock, fresh, under the default 60 s bound, is still a live holder.
  const home2 = freshHome();
  writeFileSync(confPath(home2), JSON.stringify({ projects: {} }));
  writeFileSync(lockPath(home2), JSON.stringify({ pid: k.pid }) + "\n");
  backdate(lockPath(home2), 10);
  const r2 = runTrust(home2, FAST);
  assert(
    `a 10 s old lock is NOT stale under the default 60 s bound (exit ${r2.status})`,
    r2.status === 3,
  );
}

// ---------------------------------------------------------------------
// Module-level cases (the lock library; absent on a tree without the fix).
let lib = null;
try {
  lib = await import(pathToFileURL(LOCKLIB).href);
} catch (e) {
  assert(`runner/lib/trust-lock.mjs loads (${String(e?.message || e).slice(0, 120)})`, false);
}

console.log("== 6) while held, the lock carries the holder pid and start identity ==");
if (lib) {
  const home = freshHome();
  const L = lockPath(home);
  const got = lib.acquireTrustLock(L, { tries: 2, sleepMs: 5 });
  assert("acquired a free lock", got.ok === true);
  let rec = {};
  try {
    rec = JSON.parse(readFileSync(L, "utf8"));
  } catch {
    /* asserted below */
  }
  assert(`the lock records this pid (${rec.pid})`, rec.pid === process.pid);
  if (process.platform === "linux") {
    assert(
      `the lock records this process's start identity (${rec.started})`,
      typeof rec.started === "string" && rec.started === lib.processStartId(process.pid),
    );
  }
  got.release();
  assert("release removes our own lock", !existsSync(L));
  // A release never removes someone else's lock (we were taken over meanwhile).
  const again = lib.acquireTrustLock(L, { tries: 2, sleepMs: 5 });
  writeFileSync(L, JSON.stringify({ pid: 1, started: "other" }) + "\n");
  again.release();
  assert("release leaves another holder's lock in place", existsSync(L));
}

console.log("== 7) two concurrent takers of ONE stale lock: exactly one wins ==");
if (lib) {
  for (const shape of ["empty", "dead-pid"]) {
    const home = freshHome();
    const L = lockPath(home);
    writeFileSync(L, shape === "empty" ? "" : JSON.stringify({ pid: deadPid() }) + "\n");
    backdate(L, 300);
    const bar = join(home, "barrier");
    mkdirSync(bar);
    // Each taker reads the stale lock, waits at a barrier until both have read it,
    // then races to take it over; the winner holds until both have reported.
    const taker = join(home, "taker.mjs");
    writeFileSync(
      taker,
      `import { acquireTrustLock } from ${JSON.stringify(pathToFileURL(LOCKLIB).href)};
import { writeFileSync, readdirSync, existsSync } from "node:fs";
const [L, bar, me] = process.argv.slice(2);
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let met = false;
const r = acquireTrustLock(L, { tries: 6, sleepMs: 20, log: () => {}, afterStaleRead: () => {
  if (met) return; met = true;
  writeFileSync(bar + "/" + me, "");
  for (let i = 0; i < 200 && readdirSync(bar).length < 2; i++) wait(10);
} });
console.log(r.ok ? "WON" : "LOST");
for (let i = 0; i < 300 && !existsSync(bar + "/done"); i++) wait(10);
if (r.ok) r.release();
`,
    );
    const procs = ["a", "b"].map((me) => {
      const out = { text: "" };
      const p = spawn(process.execPath, [taker, L, bar, me], { stdio: ["ignore", "pipe", "pipe"] });
      kids.push(p);
      p.stdout.on("data", (d) => (out.text += d));
      p.stderr.on("data", (d) => (out.text += d));
      return { p, out, done: new Promise((res) => p.on("exit", res)) };
    });
    // Poll until both have printed a verdict (bounded), then let the winner go.
    for (let i = 0; i < 500; i++) {
      if (procs.every((x) => /WON|LOST/.test(x.out.text))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    writeFileSync(join(bar, "done"), "");
    await Promise.race([
      Promise.all(procs.map((x) => x.done)),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
    const won = procs.filter((x) => /WON/.test(x.out.text)).length;
    const lost = procs.filter((x) => /LOST/.test(x.out.text)).length;
    assert(
      `${shape}: exactly one taker won (won=${won}, lost=${lost}; ${procs
        .map((x) => x.out.text.trim())
        .join(" | ")
        .slice(0, 200)})`,
      won === 1 && lost === 1,
    );
  }
}

// ---------------------------------------------------------------------
console.log("== 8) an unparseable ~/.claude.json is a skipped write: exit 3, untouched ==");
{
  const home = freshHome();
  const junk = "{ not json ,,, ";
  writeFileSync(confPath(home), junk);
  const r = runTrust(home, FAST);
  assert(`unparseable config → exit 3 (got ${r.status})`, r.status === 3);
  assert("unparseable config left byte-identical", readFileSync(confPath(home), "utf8") === junk);
  assert("no lock left behind after the refusal", !existsSync(lockPath(home)));
}

console.log("");
if (failures.length === 0) {
  console.log(`PASS: ${passed} checks (trust-workspace lock)`);
  process.exit(0);
}
console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
