#!/usr/bin/env node
// =====================================================================
// scripts/docker-context-check.mjs — what `docker build .` would send, and a gate on it.
//
// External review #9: the documented `docker build` baked ./repos (the operator's
// checked-out repositories) and a root .env into the image, because .dockerignore was a
// deny-list that named neither. .dockerignore is now an ALLOW-LIST of build inputs; this
// script evaluates it with Docker's own matching rules (moby/patternmatcher semantics:
// patterns relative to the context root, `**` across directories, `!` re-includes, the
// LAST matching pattern wins, a pattern that matches a parent directory matches
// everything under it) and FAILS when the context would contain anything forbidden:
//   repos/   .env / .env.*  (not .env.example)   *.sqlite*   .gaffer/   .git/
//   node_modules/   a credential-looking file (*.pem, *.key, id_rsa*, .npmrc tokens are
//   not inspected — only names)
// Two inputs are checked: the real tree under the context root, AND a fixed list of
// hostile probe paths (so the gate holds even on a clean CI checkout that has no repos/
// or .env to find).
//
// Usage: node scripts/docker-context-check.mjs [--root <dir>] [--list]
//   exit 0 clean · 1 a forbidden path is in the context · 2 usage / unreadable ignore file
// =====================================================================
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The forbidden-path rule: returns a reason, or null when the path may enter the image. */
export function forbiddenReason(path) {
  const p = path.split(sep).join("/");
  const parts = p.split("/");
  const base = parts[parts.length - 1];
  if (parts[0] === "repos") return "repos/ (the operator's repositories)";
  if (parts.includes(".gaffer")) return ".gaffer/ (factory state: databases, tokens, settings)";
  if (parts.includes(".git")) return ".git/ (repository history)";
  if (parts.includes("node_modules")) return "node_modules/ (host-built dependencies)";
  if ((base === ".env" || base.startsWith(".env.")) && base !== ".env.example")
    return ".env (operator secrets)";
  if (/\.sqlite3?($|-)/.test(base) || /\.db$/.test(base)) return "a database file";
  if (/\.(pem|key|p12|pfx)$/.test(base) || /^id_(rsa|ed25519|ecdsa)/.test(base))
    return "a credential-looking file";
  return null;
}

/** Hostile paths the context must never contain, whatever the working tree holds. */
export const PROBE_PATHS = [
  "repos/app/src/index.ts",
  "repos/app/.env",
  ".env",
  ".env.local",
  "packages/dispatch/.env",
  "runner/.env.production",
  ".gaffer/dispatch.sqlite",
  ".gaffer/settings.json",
  ".gaffer/dashboard-token",
  "dispatch.sqlite",
  "packages/memory/memory.sqlite-wal",
  "runner/data/usage.db",
  "node_modules/x/index.js",
  "packages/crew/node_modules/y/index.js",
  ".git/config",
  "id_rsa",
  "runner/certs/server.key",
];

/** Build inputs the context MUST contain (an over-tight allow-list breaks the build). */
export const REQUIRED_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "packages/dispatch/package.json",
  "packages/dispatch/src/core.ts",
  "packages/crew/package.json",
  "packages/memory/package.json",
  "runner/gaffer",
  "runner/tick.sh",
];

function escapeRe(s) {
  return s.replace(/[.+^${}()|\\]/g, "\\$&");
}

/** One .dockerignore pattern → a RegExp over a slash-separated relative path. */
export function patternToRegExp(pattern) {
  let p = pattern;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**` (optionally followed by a slash) matches any number of directories.
        i++;
        if (p[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = p.indexOf("]", i);
      if (end === -1) re += "\\[";
      else {
        re += p.slice(i, end + 1);
        i = end;
      }
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

/** Parse a .dockerignore into `{ re, negate }` rules (Docker's cleaning rules). */
export function parseIgnore(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1).trim();
    }
    line = line
      .replace(/^\/+/, "")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    if (!line) continue;
    rules.push({ re: patternToRegExp(line), negate, source: raw.trim() });
  }
  return rules;
}

/** True when the rule matches the path or any of its parent directories. */
function matchesOrParent(rule, path) {
  if (rule.re.test(path)) return true;
  const parts = path.split("/");
  for (let n = parts.length - 1; n > 0; n--) {
    if (rule.re.test(parts.slice(0, n).join("/"))) return true;
  }
  return false;
}

/** Is `path` (relative, slash-separated) excluded from the build context? */
export function isExcluded(rules, path) {
  let excluded = false;
  for (const r of rules) if (matchesOrParent(r, path)) excluded = !r.negate;
  return excluded;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join("/");
    if (e.isDirectory()) walk(root, abs, out);
    else out.push(rel);
  }
}

/** Evaluate the ignore file at `root`: the context, the violations, the missing inputs. */
export function checkContext(root, { ignoreText } = {}) {
  const ignorePath = join(root, ".dockerignore");
  const text = ignoreText ?? (existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "");
  const rules = parseIgnore(text);
  const files = [];
  walk(root, root, files);
  const context = files.filter((f) => !isExcluded(rules, f));
  const violations = [];
  for (const f of context) {
    const why = forbiddenReason(f);
    if (why) violations.push({ path: f, why, source: "tree" });
  }
  for (const f of PROBE_PATHS) {
    if (!isExcluded(rules, f))
      violations.push({ path: f, why: forbiddenReason(f), source: "probe" });
  }
  const missing = REQUIRED_PATHS.filter((f) => isExcluded(rules, f));
  return { context, violations, missing };
}

function main(argv) {
  const i = argv.indexOf("--root");
  const root = resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : join(HERE, ".."));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`docker-context-check: no such directory: ${root}\n`);
    process.exit(2);
  }
  const { context, violations, missing } = checkContext(root);
  if (argv.includes("--list")) for (const f of context) process.stdout.write(f + "\n");
  for (const v of violations)
    process.stderr.write(`FORBIDDEN in the build context (${v.source}): ${v.path} — ${v.why}\n`);
  for (const m of missing)
    process.stderr.write(`MISSING from the build context (the build needs it): ${m}\n`);
  if (violations.length || missing.length) process.exit(1);
  process.stderr.write(
    `docker-context-check: OK — ${context.length} files in the context, none forbidden, every build input present\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main(process.argv.slice(2));
