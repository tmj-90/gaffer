/**
 * Shell-word expansion for the read boundary: what a word in a Bash command names once
 * the shell has expanded it, worked out from the hook's own knowledge. Braces, a leading
 * `~`, `$NAME` / `${NAME}` (the hook's environment, plus every value the command itself
 * assigns), word splitting and pathname expansion against the real filesystem.
 *
 * Why: the read checks used to SKIP any operand with a wildcard, a brace or a variable,
 * so `cat $GAFFER_DATA/dashboard-*` (the operator's REST token) and `cp
 * $GAFFER_DATA/mcp-r* src/x` passed every secret and root check. A read operand is now
 * never skipped: it is expanded here, and what cannot be expanded is reported as such so
 * the caller fails closed (lib/hook/read-operands.mjs holds that policy).
 *
 * Sound over-approximation, not an emulator. Where bash could produce more than one
 * thing, every candidate is returned: a variable assigned in the command holds the union
 * of every value it may hold at that point; a variable set by `read`, `$(...)`, an
 * arithmetic or array form, a nameref, `eval` or `source` is UNKNOWN; a glob component
 * written in extglob or zsh syntax matches every name. All work is bounded
 * (EXPAND_LIMITS): over a cap the result is `capped`, never a partial list passed off as
 * complete. Globbing never walks into a symlinked directory and never recurses deeper
 * than the pattern says (`**` is the one recursive form, walked without following links).
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { readdirSync, statSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The bounds. Constants on purpose, never env-configurable (a knob could only loosen).
// variants: brace-expansion and variable-candidate products per word; matches: paths a
// glob may produce per word; entries: directory entries read per budget; dirs:
// directories listed per budget; braces: unquoted `{` per word before the word is
// refused (nested alternatives recurse once per group); depth: `**` recursion; command:
// directory entries read plus paths judged for the read operands of one whole command.
export const EXPAND_LIMITS = Object.freeze({
  variants: 256,
  matches: 2048,
  entries: 20000,
  dirs: 2048,
  braces: 64,
  depth: 24,
  command: 200000,
});

/** A fresh work budget (one per read operand, one per mention word). */
export function newBudget() {
  return { entries: 0, dirs: 0 };
}

// bash's own dynamic variables: their value is not in the environment the hook sees.
const BASH_DYNAMIC = new Set([
  "RANDOM",
  "SRANDOM",
  "SECONDS",
  "LINENO",
  "BASHPID",
  "EPOCHSECONDS",
  "EPOCHREALTIME",
  "PPID",
  "UID",
  "EUID",
  "OLDPWD",
  "REPLY",
  "OPTARG",
  "OPTIND",
  "PIPESTATUS",
  "FUNCNAME",
  "BASH_REMATCH",
  "BASH_SOURCE",
  "BASH_ARGV",
  "BASH_COMMAND",
  "CDPATH",
  "IFS",
  "GLOBIGNORE",
]);

// ---------------------------------------------------------------------------
// Lexing one raw word (quotes still on) into parts: { c, q } is one character, q true
// when it was quoted or escaped (so never a glob or brace character); { v, q } is a
// `$NAME` / `${NAME}`. Lexing stops at the first thing the hook cannot expand
// ($(...), backticks, $((...)), ${x:-...}, $1, $@, $'...', <(...)): `unknown` is set
// and `parts` holds what came before it (the static prefix).
// ---------------------------------------------------------------------------
function lexWord(raw) {
  const parts = [];
  const n = raw.length;
  let i = 0;
  const lit = (c, q) => parts.push({ c, q });
  // At raw[i] === "$": consume an expansion the hook can follow, or return false.
  const dollar = (q) => {
    const nx = raw[i + 1];
    if (nx === undefined) {
      lit("$", q);
      i += 1;
      return true;
    }
    if (nx === "{") {
      const close = raw.indexOf("}", i + 2);
      const body = close === -1 ? "" : raw.slice(i + 2, close);
      if (!/^[A-Za-z_]\w*$/.test(body)) return false;
      parts.push({ v: body, q });
      i = close + 1;
      return true;
    }
    if (/[A-Za-z_]/.test(nx)) {
      const name = /^[A-Za-z_]\w*/.exec(raw.slice(i + 1))[0];
      parts.push({ v: name, q });
      i += 1 + name.length;
      return true;
    }
    // A positional or special parameter, $( ), $(( )), $'...', $"...": not knowable.
    if (/[0-9@*#?$!(\-'"]/.test(nx)) return false;
    lit("$", q);
    i += 1;
    return true;
  };
  while (i < n) {
    const c = raw[i];
    if (c === "'") {
      const close = raw.indexOf("'", i + 1);
      if (close === -1) return { parts, unknown: true };
      for (const ch of raw.slice(i + 1, close)) lit(ch, true);
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      for (;;) {
        if (i >= n) return { parts, unknown: true };
        const d = raw[i];
        if (d === '"') {
          i += 1;
          break;
        }
        if (d === "\\" && i + 1 < n && /[$`"\\\n]/.test(raw[i + 1])) {
          lit(raw[i + 1], true);
          i += 2;
          continue;
        }
        if (d === "`") return { parts, unknown: true };
        if (d === "$") {
          if (!dollar(true)) return { parts, unknown: true };
          continue;
        }
        lit(d, true);
        i += 1;
      }
      continue;
    }
    if (c === "\\") {
      if (i + 1 < n) lit(raw[i + 1], true);
      i += 2;
      continue;
    }
    if (c === "`") return { parts, unknown: true };
    if (c === "$") {
      if (!dollar(false)) return { parts, unknown: true };
      continue;
    }
    if ((c === "<" || c === ">") && raw[i + 1] === "(") return { parts, unknown: true };
    lit(c, false);
    i += 1;
  }
  return { parts, unknown: false };
}

const isOpen = (p, ch) => p.v === undefined && !p.q && p.c === ch;

// `{a..e}` / `{1..20..2}` / `{01..10}`: the alternatives, null when not a sequence,
// "over" when longer than the cap.
function sequenceAlternatives(inner) {
  if (inner.some((p) => p.v !== undefined || p.q)) return null;
  const text = inner.map((p) => p.c).join("");
  let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const step = Math.abs(Number(m[3] ?? 1)) || 1;
    if (Math.abs(b - a) / step + 1 > EXPAND_LIMITS.variants) return "over";
    const width =
      /^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2]) ? Math.max(m[1].length, m[2].length) : 0;
    const out = [];
    for (let x = a; a <= b ? x <= b : x >= b; x += a <= b ? step : -step) {
      const s = width
        ? String(Math.abs(x)).padStart(width - (x < 0 ? 1 : 0), "0")
        : String(Math.abs(x));
      out.push([...((x < 0 ? "-" : "") + s)].map((c) => ({ c, q: true })));
    }
    return out;
  }
  m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(text);
  if (m) {
    const a = m[1].charCodeAt(0);
    const b = m[2].charCodeAt(0);
    const step = Math.abs(Number(m[3] ?? 1)) || 1;
    const out = [];
    for (let x = a; a <= b ? x <= b : x >= b; x += a <= b ? step : -step) {
      out.push([{ c: String.fromCharCode(x), q: true }]);
    }
    return out;
  }
  return null;
}

/** Brace expansion of a part list: the variants, or null when over the cap. */
function expandBraces(parts) {
  for (let a = 0; a < parts.length; a += 1) {
    if (!isOpen(parts[a], "{")) continue;
    let depth = 0;
    let close = -1;
    const commas = [];
    for (let k = a + 1; k < parts.length; k += 1) {
      const x = parts[k];
      if (isOpen(x, "{")) depth += 1;
      else if (isOpen(x, "}")) {
        if (depth === 0) {
          close = k;
          break;
        }
        depth -= 1;
      } else if (isOpen(x, ",") && depth === 0) commas.push(k);
    }
    if (close === -1) continue;
    let alts;
    if (commas.length) {
      alts = [];
      let s = a + 1;
      for (const k of [...commas, close]) {
        alts.push(parts.slice(s, k));
        s = k + 1;
      }
    } else {
      alts = sequenceAlternatives(parts.slice(a + 1, close));
      if (alts === "over") return null;
    }
    if (!alts) continue;
    const head = parts.slice(0, a);
    const tail = parts.slice(close + 1);
    const out = [];
    for (const alt of alts) {
      const sub = expandBraces([...head, ...alt, ...tail]);
      if (!sub) return null;
      out.push(...sub);
      if (out.length > EXPAND_LIMITS.variants) return null;
    }
    return out;
  }
  return [parts];
}

// ---------------------------------------------------------------------------
// The variable table: what `$NAME` may hold at a point of the command.
// ---------------------------------------------------------------------------

/**
 * A table of the values each variable may hold. `env` is the hook's environment (what
 * the agent's shell inherits). `cmd` is the whole command: a name it sets in a way the
 * hook does not follow (read, mapfile, getopts, select, printf -v, let, (( )), an array
 * or `+=` form) is UNKNOWN everywhere; after an `eval`, `source` or `.` (they can set
 * anything) the caller marks every name unknown (allUnknown).
 */
export class VarTable {
  constructor(env, cmd) {
    this.env = env;
    this.cmd = cmd;
    this.vals = new Map(); // name -> { values: string[] } | { unknown: true }
    // Set by the caller once the command has run `eval`, `source` or `.` (they can set
    // any variable): every later lookup is unknown.
    this.allUnknown = false;
    this.ifsChanged = /(?<![\w$])IFS(?:\+?=)/.test(cmd);
    this.dynamicCache = new Map();
    // Bumped on every change, so a caller may cache what a word expanded to.
    this.version = 0;
  }

  /** After `eval`, `source` or `.`: nothing is known any more. */
  forgetAll() {
    this.allUnknown = true;
    this.version += 1;
  }

  dynamic(name) {
    if (this.dynamicCache.has(name)) return this.dynamicCache.get(name);
    const n = name.replace(/[^\w]/g, "");
    const re = new RegExp(
      String.raw`\b(?:read|mapfile|readarray|getopts|select)\b[^\n;&|]*?(?<![\w$])${n}(?!\w)|\bprintf\b[^\n;&|]*-v[ \t]*["']?${n}\b|\(\([^)]*\b${n}\b|\blet\b[^\n;&|]*\b${n}\b|(?<![\w$])${n}(?:\[[^\]]*\])?\+?=\(|(?<![\w$])${n}\+=|(?<![\w$])${n}\[|\bdeclare\b[^\n;&|]*-\w*[naAi]\w*[^\n;&|]*\b${n}\b|\b(?:typeset|local)\b[^\n;&|]*-\w*[naAi]\w*[^\n;&|]*\b${n}\b|\bunset\b[^\n;&|]*-\w*n\w*[^\n;&|]*\b${n}\b`,
    );
    const hit = re.test(this.cmd);
    this.dynamicCache.set(name, hit);
    return hit;
  }

  /** The values `name` may hold, or null when it is unknown. `cwds`: the current cwds. */
  lookup(name, cwds) {
    if (this.allUnknown || BASH_DYNAMIC.has(name) || this.dynamic(name)) return null;
    const own = this.vals.get(name);
    if (own) return own.unknown ? null : own.values;
    if (name === "PWD") return cwds.includes(null) ? null : cwds.slice();
    if (name === "HOME" && this.env.HOME === undefined) return [homedir()];
    const v = this.env[name];
    return [v === undefined ? "" : String(v)];
  }

  /** Record an assignment: `definite` replaces, otherwise the values are added. */
  assign(name, values, definite, cwds) {
    this.version += 1;
    if (values === null) {
      this.vals.set(name, { unknown: true });
      return;
    }
    if (definite) {
      this.vals.set(name, { values: [...new Set(values)] });
      return;
    }
    const before = this.lookup(name, cwds);
    if (before === null) {
      this.vals.set(name, { unknown: true });
      return;
    }
    const merged = [...new Set([...before, ...values])];
    if (merged.length > EXPAND_LIMITS.variants) this.vals.set(name, { unknown: true });
    else this.vals.set(name, { values: merged });
  }
}

/** Substitute the variables of one brace variant: the candidate part lists, or null. */
function substituteVariant(parts, table, cwds) {
  let combos = [[]];
  for (const p of parts) {
    if (p.v === undefined) {
      for (const c of combos) c.push(p);
      continue;
    }
    const values = table.lookup(p.v, cwds);
    if (values === null) return { unknown: true, prefix: combos[0] };
    if (!p.q && table.ifsChanged) return { unknown: true, prefix: combos[0] };
    const next = [];
    for (const c of combos) {
      for (const value of values) {
        // An unquoted value is split on blanks and its glob characters stay active.
        next.push([...c, ...[...value].map((ch) => ({ c: ch, q: p.q, split: !p.q }))]);
        if (next.length > EXPAND_LIMITS.variants) return { capped: true };
      }
    }
    combos = next;
  }
  return { combos };
}

/** Split a part list into fields at unquoted blanks that came from a variable. */
function splitFields(parts) {
  const fields = [[]];
  let anyQuoted = false;
  for (const p of parts) {
    if (p.q) anyQuoted = true;
    if (p.split && /[ \t\n]/.test(p.c)) {
      if (fields[fields.length - 1].length) fields.push([]);
      continue;
    }
    fields[fields.length - 1].push(p);
  }
  return fields.filter((f, k) => f.length || (anyQuoted && k === 0));
}

/** Tilde expansion at the head of a brace variant (bash does it after braces). */
function expandTilde(parts, table, cwds) {
  if (!parts.length || !isOpen(parts[0], "~")) return [parts];
  let k = 1;
  let user = "";
  while (k < parts.length && !(parts[k].v === undefined && parts[k].c === "/")) {
    const p = parts[k];
    if (p.v !== undefined || p.q) return [parts]; // `~"x"`: no tilde expansion
    user += p.c;
    k += 1;
  }
  let homes;
  if (user === "") homes = table.lookup("HOME", cwds);
  else if (user === "+") homes = cwds.includes(null) ? null : cwds;
  else return "unverifiable"; // `~-` (dir stack) or `~user` (another home)
  if (homes === null) return null;
  return homes.map((h) => [...[...h].map((c) => ({ c, q: true })), ...parts.slice(k)]);
}

/**
 * Expand one raw shell word to the fields the program would receive, before pathname
 * expansion. Returns { fields: part[][] } or { unknown: true, prefix: part[] } (an
 * expansion the hook cannot follow; prefix = the literal parts before it), { capped:
 * true } or { unverifiable: true } (`~user` / `~-`).
 */
export function expandWordFields(raw, table, cwds) {
  const lexed = lexWord(raw);
  if (lexed.unknown) return { unknown: true, prefix: lexed.parts };
  const braces = lexed.parts.filter((p) => isOpen(p, "{")).length;
  if (braces > EXPAND_LIMITS.braces) return { capped: true };
  const variants = expandBraces(lexed.parts);
  if (!variants) return { capped: true };
  const fields = [];
  for (const variant of variants) {
    const tilded = expandTilde(variant, table, cwds);
    if (tilded === "unverifiable") return { unverifiable: true };
    if (tilded === null) return { unknown: true, prefix: [] };
    for (const t of tilded) {
      const sub = substituteVariant(t, table, cwds);
      if (sub.unknown) return { unknown: true, prefix: sub.prefix };
      if (sub.capped) return { capped: true };
      for (const combo of sub.combos) fields.push(...splitFields(combo));
      if (fields.length > EXPAND_LIMITS.variants) return { capped: true };
    }
  }
  return { fields };
}

/** The literal text of an assignment value, as the shell stores it (no split, no glob). */
export function expandAssignmentValue(raw, table, cwds) {
  const lexed = lexWord(raw);
  if (lexed.unknown) return null;
  const tilded = expandTilde(lexed.parts, table, cwds);
  if (tilded === null || tilded === "unverifiable") return null;
  const out = [];
  for (const t of tilded) {
    const sub = substituteVariant(t, table, cwds);
    if (sub.unknown || sub.capped) return null;
    for (const combo of sub.combos) out.push(combo.map((p) => p.c).join(""));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pathname expansion.
// ---------------------------------------------------------------------------
const isGlobPart = (p) => p.v === undefined && !p.q && (p.c === "*" || p.c === "?" || p.c === "[");

/** Does a field carry an active glob character? */
export function fieldHasGlob(field) {
  return field.some(isGlobPart);
}

/** The text of a field (quotes already removed). */
export function fieldText(field) {
  return field.map((p) => p.c).join("");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// One glob component as a name matcher. `wild`: written in a syntax not modelled here
// (extglob `@(...)` / `!(...)`, zsh qualifiers `*(...)`, POSIX classes): it matches
// every name, dot entries included (a superset of anything the shell could match).
function componentMatcher(comp, opts) {
  let re = "";
  let wild = false;
  for (let j = 0; j < comp.length; j += 1) {
    const p = comp[j];
    if (p.q) {
      re += escapeRe(p.c);
      continue;
    }
    if (p.c === "(" && j > 0 && !comp[j - 1].q && /[?*+@!]/.test(comp[j - 1].c)) wild = true;
    if (p.c === "*") re += ".*";
    else if (p.c === "?") re += ".";
    else if (p.c === "[") {
      let k = j + 1;
      if (k < comp.length && !comp[k].q && (comp[k].c === "!" || comp[k].c === "^")) k += 1;
      if (k < comp.length && comp[k].c === "]") k += 1;
      while (k < comp.length && !(comp[k].c === "]" && !comp[k].q)) k += 1;
      if (k >= comp.length) {
        re += "\\[";
        continue;
      }
      const inner = comp
        .slice(j + 1, k)
        .map((x) => x.c)
        .join("");
      if (inner.includes("[:") || inner.includes("[=") || inner.includes("[.")) {
        wild = true;
        re += ".";
      } else {
        const neg = /^[!^]/.test(inner);
        const body = (neg ? inner.slice(1) : inner).replace(/[\\\]^[]/g, "\\$&");
        re += `[${neg ? "^" : ""}${body}]`;
      }
      j = k;
    } else re += escapeRe(p.c);
  }
  const dot = comp.length > 0 && comp[0].c === ".";
  if (wild) return { test: () => true, dots: true, hidden: true };
  const rx = new RegExp(`^${re}$`, opts.nocase ? "is" : "s");
  return { test: (name) => rx.test(name), dots: dot, hidden: dot || opts.dotglob };
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

class Capped extends Error {}

function listDir(dir, budget) {
  budget.dirs += 1;
  if (budget.dirs > EXPAND_LIMITS.dirs) throw new Capped();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  budget.entries += entries.length;
  if (budget.entries > EXPAND_LIMITS.entries) throw new Capped();
  return entries;
}

// `**`: the directory and every directory below it (hidden ones only with dotglob),
// never through a symlink, so a link loop cannot be walked.
function walkDirs(dir, budget, opts, depth, out) {
  out.push(dir);
  if (depth >= EXPAND_LIMITS.depth) throw new Capped();
  for (const e of listDir(dir, budget)) {
    if (!opts.dotglob && e.name.startsWith(".")) continue;
    if (e.isDirectory()) walkDirs(join(dir, e.name), budget, opts, depth + 1, out);
  }
}

/**
 * Pathname expansion of one field against the filesystem, from `cwd` (null: unknown).
 * Returns { kind: "literal", path } when the field has no active glob character, else
 * { kind: "paths", paths, prefix } (every match), { kind: "nomatch", prefix } (the shell
 * would pass the word through unexpanded), { kind: "capped", prefix }, or { kind:
 * "unknown" } (a relative glob with no known cwd); with `walk` false it returns
 * { kind: "capped", prefix } without listing anything. `prefix` is the directory the
 * literal part of the pattern names: no match can lie outside it (a glob never matches
 * `/`, so climbing out needs a literal `..` after it, which the walk resolves).
 */
export function globField(field, cwd, budget, opts, walk = true) {
  if (!fieldHasGlob(field)) return { kind: "literal", path: fieldText(field) };
  const absolute = field.length > 0 && field[0].c === "/";
  if (!absolute && cwd === null) return { kind: "unknown" };
  const comps = [[]];
  for (const p of field) {
    if (p.c === "/") comps.push([]);
    else comps[comps.length - 1].push(p);
  }
  let base = absolute ? "/" : cwd;
  let k = 0;
  if (absolute) k = 1;
  while (k < comps.length && !fieldHasGlob(comps[k])) {
    if (comps[k].length) base = join(base, fieldText(comps[k]));
    k += 1;
  }
  const prefix = resolve(base);
  // walk = false: only the literal prefix is wanted (the caller is past its word budget).
  if (!walk) return { kind: "capped", prefix };
  let cur = [prefix];
  try {
    for (; k < comps.length; k += 1) {
      const comp = comps[k];
      const last = k === comps.length - 1;
      if (comp.length === 0) {
        // `a/*/` (trailing slash) keeps directories only; `a//b` changes nothing.
        if (last) cur = cur.filter(isDir);
        continue;
      }
      if (!fieldHasGlob(comp)) {
        cur = cur.map((d) => join(d, fieldText(comp)));
        continue;
      }
      const next = [];
      if (comp.length === 2 && comp.every((p) => !p.q && p.c === "*")) {
        for (const d of cur) {
          if (!isDir(d)) continue;
          const dirs = [];
          walkDirs(d, budget, opts, 0, dirs);
          if (last) {
            for (const sub of dirs) {
              for (const e of listDir(sub, budget)) {
                if (!opts.dotglob && e.name.startsWith(".")) continue;
                next.push(join(sub, e.name));
              }
            }
          } else next.push(...dirs);
          if (next.length > EXPAND_LIMITS.matches) throw new Capped();
        }
      } else {
        const m = componentMatcher(comp, opts);
        for (const d of cur) {
          if (!isDir(d)) continue;
          const names = listDir(d, budget).map((e) => e.name);
          if (m.dots) names.push(".", "..");
          for (const name of names) {
            if (name.startsWith(".") && !m.hidden && name !== "." && name !== "..") continue;
            if (!m.test(name)) continue;
            const p = join(d, name);
            if (!last && !isDir(p)) continue;
            next.push(p);
          }
          if (next.length > EXPAND_LIMITS.matches) throw new Capped();
        }
      }
      cur = next;
      if (cur.length === 0) break;
    }
  } catch (err) {
    if (err instanceof Capped) return { kind: "capped", prefix };
    throw err;
  }
  const paths = [...new Set(cur.filter(exists))];
  if (paths.length > EXPAND_LIMITS.matches) return { kind: "capped", prefix };
  if (paths.length === 0) return { kind: "nomatch", prefix };
  return { kind: "paths", paths, prefix };
}

/** Glob options a command turns on (dot files, case-insensitive matching). */
export function globOptions(cmd) {
  return {
    dotglob: /\bdotglob\b|\bGLOBIGNORE\b|\bglob_?dots\b|\bsetopt\b/i.test(cmd),
    nocase: /\bnocaseglob\b|\bsetopt\b/i.test(cmd),
  };
}

export { lexWord };
