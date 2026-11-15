#!/usr/bin/env node
// runner/test/lib/sbpl-eval.mjs: a small evaluator for the SBPL subset lib/sandbox.sh
// generates, so a Linux host (no sandbox-exec) can still ask "would this profile let a
// process write <path>?" of a REAL generated profile, not only grep its text.
//
// The subset: `(version 1)`, `(allow default)`, `(allow|deny <op>... <filter>...)` where an
// op is file-write*, file-read*, file-read-data, network*, process-exec*, process-fork, and
// a filter is (subpath "p"), (literal "p") or (regex #"re"). SBPL is last match wins; a rule
// with no filter matches every path. Anything outside the subset is an error (the caller
// fails), never a silent "allow".
//
// This models the profile's MEANING only. What the macOS kernel actually does (canonical
// paths, hard links, renames) is proved by the Darwin sections of the tests that use it.
//
//   node sbpl-eval.mjs <profile> <write|read> <path>...   → one "allow|deny <path>" per line
import { readFileSync } from "node:fs";

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ";") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "(" || c === ")") {
      out.push(c);
      i++;
    } else if (c === "#" && src[i + 1] === '"') {
      // A regex literal: raw up to the next unescaped quote.
      let j = i + 2;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j] + src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new Error("unterminated regex literal");
      out.push({ regex: s });
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new Error("unterminated string");
      out.push({ str: s });
      i = j + 1;
    } else {
      let j = i;
      while (j < src.length && !/[\s()]/.test(src[j])) j++;
      out.push({ sym: src.slice(i, j) });
      i = j;
    }
  }
  return out;
}

function parse(tokens) {
  let i = 0;
  const read = () => {
    const t = tokens[i++];
    if (t === "(") {
      const list = [];
      while (tokens[i] !== ")") {
        if (i >= tokens.length) throw new Error("unbalanced parentheses");
        list.push(read());
      }
      i++;
      return list;
    }
    if (t === ")") throw new Error("unexpected )");
    return t;
  };
  const forms = [];
  while (i < tokens.length) forms.push(read());
  return forms;
}

const OPS = new Set([
  "default",
  "file-write*",
  "file-read*",
  "file-read-data",
  "network*",
  "process-exec*",
  "process-fork",
]);

/** The profile's rules: [{ action, ops: Set, filters: [{kind, value}] }]. */
export function loadProfile(text) {
  const rules = [];
  for (const f of parse(tokenize(text))) {
    if (!Array.isArray(f) || !f[0] || !f[0].sym) throw new Error(`bad form ${JSON.stringify(f)}`);
    const head = f[0].sym;
    if (head === "version") continue;
    if (head !== "allow" && head !== "deny") throw new Error(`unknown form ${head}`);
    const ops = new Set();
    const filters = [];
    for (const x of f.slice(1)) {
      if (x && x.sym) {
        if (!OPS.has(x.sym)) throw new Error(`unknown operation ${x.sym}`);
        ops.add(x.sym);
      } else if (Array.isArray(x) && x[0] && x[0].sym) {
        const kind = x[0].sym;
        const v = x[1];
        if (kind === "subpath" || kind === "literal") {
          if (!v || typeof v.str !== "string" || x.length !== 2) throw new Error(`bad ${kind}`);
          filters.push({ kind, value: v.str });
        } else if (kind === "regex") {
          if (!v || typeof v.regex !== "string" || x.length !== 2) throw new Error("bad regex");
          filters.push({ kind, value: new RegExp(v.regex) });
        } else throw new Error(`unknown filter ${kind}`);
      } else throw new Error(`bad rule element ${JSON.stringify(x)}`);
    }
    if (ops.size === 0) throw new Error(`rule with no operation`);
    rules.push({ action: head, ops, filters });
  }
  return rules;
}

function opMatches(ops, op) {
  if (ops.has("default")) return true;
  if (op === "write") return ops.has("file-write*");
  if (op === "read") return ops.has("file-read*") || ops.has("file-read-data");
  return false;
}

function filterMatches(f, path) {
  if (f.kind === "literal") return path === f.value;
  if (f.kind === "subpath")
    return path === f.value || path.startsWith(`${f.value.replace(/\/$/, "")}/`);
  return f.value.test(path);
}

/** "allow" | "deny" for `op` ("write" | "read") on an absolute canonical `path`. */
export function decide(rules, op, path) {
  let verdict = "deny";
  for (const r of rules) {
    if (!opMatches(r.ops, op)) continue;
    if (r.filters.length === 0 || r.filters.some((f) => filterMatches(f, path))) verdict = r.action;
  }
  return verdict;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, op, ...paths] = process.argv.slice(2);
  try {
    const rules = loadProfile(readFileSync(file, "utf8"));
    for (const p of paths) process.stdout.write(`${decide(rules, op, p)} ${p}\n`);
  } catch (e) {
    process.stderr.write(`sbpl-eval: ${e.message}\n`);
    process.exit(2);
  }
}
