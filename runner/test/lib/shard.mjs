// Shard assignment for runner/test/run.sh (`--shard K/N` / GAFFER_RUN_SHARD=K/N).
//
//   node shard.mjs K N WEIGHTS FILE...   → prints shard K's FILEs, one per line,
//                                          in the order they were given
//
// The N shards PARTITION the given files exactly: every file lands in exactly one
// shard, and which one depends only on the set of basenames and the weights table,
// never on the machine (glob order, locale collation, CPU count). Balanced by
// expected duration with LPT: heaviest file first, each onto the currently lightest
// shard (ties: the lower shard number); files of equal weight go in basename order.
// Shard 1 starts with a head start (SHARD1_HEAD_START, below).
//
// WEIGHTS is a TSV of `seconds<TAB>basename` (# comments allowed) — observed CI
// durations on macOS, the slowest platform. A file missing from it weighs
// DEFAULT_WEIGHT; a stale entry for a deleted file is ignored.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const DEFAULT_WEIGHT = 10;
// Shard 1 (when N > 1) starts with this many weight-seconds already on it: in CI,
// shard 1 of each macOS cell also runs the package tests (~2 min of wall before its
// runner tests start), so it takes ~100s x 3 cores less of the suite. Capped at half
// a shard's mean load, so a small FILE set never leaves shard 1 empty. Fixed, never
// per machine: every shard of one K/N must compute the same split.
const SHARD1_HEAD_START = 300;

function die(msg) {
  process.stderr.write(`shard.mjs: ${msg}\n`);
  process.exit(2);
}

const [kArg, nArg, weightsPath, ...files] = process.argv.slice(2);
const k = Number(kArg);
const n = Number(nArg);
if (!Number.isInteger(n) || n < 1) die(`N must be a positive integer (got '${nArg}')`);
if (!Number.isInteger(k) || k < 1 || k > n) die(`K must be in 1..${n} (got '${kArg}')`);
if (!weightsPath) die("usage: shard.mjs K N WEIGHTS FILE...");

const weights = new Map();
for (const line of readFileSync(weightsPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const [sec, name] = t.split("\t");
  const s = Number(sec);
  if (!name || !Number.isFinite(s) || s < 0) die(`bad weights line: '${line}'`);
  weights.set(name, s);
}

const names = files.map((f) => basename(f));
if (new Set(names).size !== names.length) die("duplicate test basenames: cannot shard");

// Code-point order, not localeCompare: the same on every machine.
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const order = names
  .map((name, i) => ({ name, i, w: weights.get(name) ?? DEFAULT_WEIGHT }))
  .sort((a, b) => b.w - a.w || byName(a.name, b.name));

const load = new Array(n).fill(0);
const total = order.reduce((sum, t) => sum + t.w, 0);
if (n > 1) load[0] = Math.min(SHARD1_HEAD_START, total / n / 2);
const shardOf = new Array(files.length);
for (const t of order) {
  let best = 0;
  for (let s = 1; s < n; s++) if (load[s] < load[best]) best = s;
  load[best] += t.w;
  shardOf[t.i] = best + 1;
}

const out = files.filter((_, i) => shardOf[i] === k);
if (out.length) process.stdout.write(out.join("\n") + "\n");
