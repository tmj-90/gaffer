// Formatting: durations, relative times, days, money, plurals.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { clockTime } from "../app.js";

/** Compact, human-friendly duration from milliseconds (e.g. "2d 3h", "45m"). */
function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

/** Relative time from an ISO stamp, e.g. "3d ago" / "just now". */
function fmtRelative(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const ms = Date.now() - t;
  if (ms < 60_000) return "just now";
  return `${fmtDuration(ms)} ago`;
}

/** Short, human-friendly timestamp. Falls back to the raw string. */
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // British, like the voice: "29 Oct, 18:56" (24-hour clock, day before month).
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clockTime(d.getTime())}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** A date the British way: "Thu 29 Oct" (weekday optional). */
function fmtDay(iso, { weekday = true } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${weekday ? WEEKDAYS[d.getDay()] + " " : ""}${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
/**
 * Money, one format everywhere: dollars and cents ("$15.74"). A sliver under a cent
 * reads "<$0.01" (never a four-decimal "$0.0034"); no figure reads "—", never "$0".
 */
function money(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.005) return "<$0.01";
  return `$${v.toFixed(2)}`;
}
/** A budget or cap: whole dollars when it is whole ("$25"), else cents. */
function moneyW(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? `$${v}` : money(v);
}
/** JSON.parse that answers null for a malformed or empty payload. */
function parseJsonSafe(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}
/** "3 diffs" / "1 diff". */
function plural(n, one, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

export {
  fmtDuration,
  fmtRelative,
  fmtTime,
  WEEKDAYS,
  fmtDay,
  money,
  moneyW,
  parseJsonSafe,
  plural,
};
