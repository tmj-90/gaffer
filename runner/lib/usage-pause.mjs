#!/usr/bin/env node
// Gaffer factory — the USAGE-WINDOW PAUSE (the usage-window-aware scheduler).
// =====================================================================
// When a model call comes back refused by the plan's usage window or a rate limit
// (lib/worker.mjs detectUsageLimit — the ONE table of matched strings), the factory
// stops admitting paid work until the window resets instead of spinning through
// ticks that each burn an attempt and eventually park good tickets.
//
// STATE: one small JSON file, $GAFFER_DATA/usage-pause.json (override the path with
// GAFFER_USAGE_PAUSE_FILE), in the same durability domain as the usage ledger:
//   { "paused_until": "<ISO>", "until_ms": <epoch ms>, "kind": "usage_limit"|"rate_limit",
//     "basis": "reset"|"default", "message": "<what the CLI said>", "ticket": <n>|null,
//     "lane": "delivery"|…, "recorded_at": "<ISO>" }
// Readers: tick.sh (pre-claim gate), loop.sh + worker.sh (sleep, stop admitting),
// lib/daemon.sh (sleep between passes), status.sh, and the dashboard Health view
// (packages/dispatch/src/health/usagePause.ts reads the same file).
//
// WHEN THE PAUSE ENDS (fail closed toward a longer wait):
//   • a reset time the CLI printed ("· resets 3pm (Europe/London)", a unix epoch,
//     a retry-after) → that instant + RESET_GRACE_MS, but never sooner than
//     PAUSE_FLOOR_MIN from now and never later than PAUSE_MAX_MIN;
//   • no reset → GAFFER_USAGE_PAUSE_DEFAULT_MIN (default 60), never below the floor;
//   • an existing later pause is never shortened (two workers that hit the limit
//     keep the longer wait);
//   • a pause file that exists but does not parse is read as ACTIVE until its mtime
//     + the default, so a corrupted file never silently re-opens the floodgates.
// The pause clears itself when the time passes. A human can lift it early with
// `node runner/lib/usage-pause.mjs clear` (or delete the file).
//
// LEFTOVER-WINDOW SEAM (deliberately NOT built in this slice): spending the time
// before a window resets on maintenance work. Whether headless/SDK usage shares the
// 5-hour window at all is uncertain, so nothing here schedules work into it. A
// future lane would read readPause() and decide; it must stay opt-in.
//
// CLI:
//   node usage-pause.mjs record --json-file <f> [--ticket N] [--lane <lane>]
//        → exit 10 (writes nothing) unless the envelope is a usage/rate-limit refusal;
//          otherwise writes the pause and prints one TSV line:
//          <until epoch s>\t<paused_until ISO>\t<kind>\t<basis>\t<message>
//   node usage-pause.mjs status [--json]
//        → active: prints "paused until <time>: usage limit" (or the JSON) and exits 0;
//          not active: prints nothing (or {"active":false}) and exits 1
//   node usage-pause.mjs until   → active: prints the until epoch SECONDS, exit 0; else exit 1
//   node usage-pause.mjs clear   → removes the pause file; exit 0
// =====================================================================
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseResult } from "./worker.mjs";

export const PAUSE_FILENAME = "usage-pause.json";
/** The shortest pause the factory will take, whatever the setting or the reset says. */
export const PAUSE_FLOOR_MIN = 10;
/** The default when the CLI printed no reset time (GAFFER_USAGE_PAUSE_DEFAULT_MIN). */
export const PAUSE_DEFAULT_MIN = 60;
/** A parsed reset beyond this is clamped: the weekly window is the longest there is. */
export const PAUSE_MAX_MIN = 8 * 24 * 60;
/** Wake a minute after the printed reset, not on the boundary itself. */
export const RESET_GRACE_MS = 60_000;

const KIND_LABEL = { usage_limit: "usage limit", rate_limit: "rate limit" };

/** The pause file path: GAFFER_USAGE_PAUSE_FILE, else $GAFFER_DATA/usage-pause.json; null without either. */
export function pauseFile(env = process.env) {
  const explicit = String(env.GAFFER_USAGE_PAUSE_FILE ?? "").trim();
  if (explicit) return explicit;
  const dir = String(env.GAFFER_DATA ?? "").trim();
  return dir ? join(dir, PAUSE_FILENAME) : null;
}

/**
 * The default pause in minutes: GAFFER_USAGE_PAUSE_DEFAULT_MIN as a whole number,
 * raised to PAUSE_FLOOR_MIN when set lower; empty/junk → PAUSE_DEFAULT_MIN.
 */
export function pauseDefaultMin(env = process.env) {
  const raw = String(env.GAFFER_USAGE_PAUSE_DEFAULT_MIN ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) return PAUSE_DEFAULT_MIN;
  const n = parseInt(raw, 10);
  return Math.min(PAUSE_MAX_MIN, Math.max(PAUSE_FLOOR_MIN, n));
}

/**
 * When a pause for `limit` (a detectUsageLimit result) ends, from `nowMs`.
 *   → { untilMs, basis: "reset"|"default" }
 */
export function computePausedUntil(limit, nowMs = Date.now(), env = process.env) {
  const floor = nowMs + PAUSE_FLOOR_MIN * 60_000;
  const max = nowMs + PAUSE_MAX_MIN * 60_000;
  const r = limit && Number.isFinite(limit.resetsAtMs) ? limit.resetsAtMs : null;
  if (r != null) {
    return { untilMs: Math.min(max, Math.max(floor, r + RESET_GRACE_MS)), basis: "reset" };
  }
  return { untilMs: nowMs + pauseDefaultMin(env) * 60_000, basis: "default" };
}

/** "2026-10-31 15:01 UTC" — the one display form (status, logs, the daemon line). */
export function formatUntil(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** "paused until 2026-10-31 15:01 UTC: usage limit" */
export function pauseLine(rec) {
  return `paused until ${formatUntil(rec.until_ms)}: ${KIND_LABEL[rec.kind] || "usage limit"}`;
}

/**
 * The pause as it stands at `nowMs`, or null when there is none (no file, or it has
 * expired). A file that exists but does not parse is ACTIVE until mtime + the default.
 */
export function readPause(env = process.env, nowMs = Date.now()) {
  const f = pauseFile(env);
  if (!f) return null;
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    text = "";
  }
  let rec = null;
  try {
    const j = JSON.parse(text);
    const until = Number.isFinite(j.until_ms) ? j.until_ms : Date.parse(j.paused_until);
    if (j && typeof j === "object" && Number.isFinite(until)) {
      rec = {
        paused_until: new Date(until).toISOString(),
        until_ms: until,
        kind: KIND_LABEL[j.kind] ? j.kind : "usage_limit",
        basis: j.basis === "reset" ? "reset" : "default",
        message: typeof j.message === "string" ? j.message.slice(0, 300) : "",
        ticket: Number.isInteger(j.ticket) ? j.ticket : null,
        lane: typeof j.lane === "string" ? j.lane : null,
        recorded_at: typeof j.recorded_at === "string" ? j.recorded_at : null,
      };
    }
  } catch {
    /* unreadable — handled below */
  }
  if (!rec) {
    let mtime = nowMs;
    try {
      mtime = statSync(f).mtimeMs;
    } catch {
      /* gone between the read and the stat */
    }
    const until = mtime + pauseDefaultMin(env) * 60_000;
    rec = {
      paused_until: new Date(until).toISOString(),
      until_ms: until,
      kind: "usage_limit",
      basis: "default",
      message: `the pause file ${f} could not be read; holding for the default pause`,
      ticket: null,
      lane: null,
      recorded_at: null,
      unreadable: true,
    };
  }
  if (rec.until_ms <= nowMs) return null;
  return { active: true, ...rec };
}

/**
 * Record a pause for `limit`. Keeps an existing LATER pause (never shortens one).
 * Atomic (temp file + rename). Returns the record now in force.
 */
export function recordPause(
  { limit, ticket = null, lane = null },
  env = process.env,
  nowMs = Date.now(),
) {
  const f = pauseFile(env);
  if (!f) throw new Error("usage-pause: GAFFER_DATA is not set; cannot record a pause");
  const { untilMs, basis } = computePausedUntil(limit, nowMs, env);
  const existing = readPause(env, nowMs);
  if (existing && !existing.unreadable && existing.until_ms >= untilMs) return existing;
  const rec = {
    paused_until: new Date(untilMs).toISOString(),
    until_ms: untilMs,
    kind: limit && KIND_LABEL[limit.kind] ? limit.kind : "usage_limit",
    basis,
    message: limit && typeof limit.message === "string" ? limit.message.slice(0, 300) : "",
    ticket: Number.isInteger(ticket) ? ticket : null,
    lane: lane || null,
    recorded_at: new Date(nowMs).toISOString(),
  };
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + "\n");
  renameSync(tmp, f);
  return { active: true, ...rec };
}

/** Lift the pause (operator action). */
export function clearPause(env = process.env) {
  const f = pauseFile(env);
  if (f) rmSync(f, { force: true });
}

/** `record`'s exit status for an ordinary result (distinct from a failed write). */
const NOT_A_REFUSAL = 10;

function cli(argv) {
  const cmd = argv[0];
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (cmd === "record") {
    const jf = opt("--json-file");
    let text;
    try {
      text = jf ? readFileSync(jf, "utf8") : "";
    } catch {
      text = "";
    }
    const { usageLimit } = parseResult(text);
    if (!usageLimit) process.exit(NOT_A_REFUSAL);
    const t = parseInt(String(opt("--ticket") ?? ""), 10);
    const rec = recordPause({
      limit: usageLimit,
      ticket: Number.isInteger(t) ? t : null,
      lane: opt("--lane") || null,
    });
    const msg = String(rec.message || "").replace(/[\t\n\r]+/g, " ");
    process.stdout.write(
      `${Math.ceil(rec.until_ms / 1000)}\t${rec.paused_until}\t${rec.kind}\t${rec.basis}\t${msg}\n`,
    );
    process.exit(0);
  }
  if (cmd === "status") {
    const rec = readPause();
    if (argv.includes("--json")) {
      process.stdout.write(JSON.stringify(rec || { active: false }) + "\n");
    } else if (rec) {
      process.stdout.write(pauseLine(rec) + "\n");
    }
    process.exit(rec ? 0 : 1);
  }
  if (cmd === "until") {
    const rec = readPause();
    if (!rec) process.exit(1);
    process.stdout.write(String(Math.ceil(rec.until_ms / 1000)) + "\n");
    process.exit(0);
  }
  if (cmd === "clear") {
    clearPause();
    process.exit(0);
  }
  process.stderr.write("usage: usage-pause.mjs record|status|until|clear\n");
  process.exit(2);
}

// Run as a CLI when invoked directly — compared by real path, so a symlinked
// runner dir (a test's fake runner, a packaged install) still reaches the CLI
// instead of silently exiting 0 with no output.
function invokedDirectly() {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (invokedDirectly()) cli(process.argv.slice(2));
