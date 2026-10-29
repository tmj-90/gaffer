#!/usr/bin/env node
// Node engine floor guard — keeps the declared Node floor TRUE.
//
// .npmrc sets engine-strict=true, so `pnpm install` refuses to run when ANY locked
// package's `engines.node` excludes the running Node. The root package.json's
// `engines.node` is the floor the docs promise ("Node 22.22.1+ or 24"); a dev
// dependency that raises its own floor above it (lint-staged 17 needs >=22.22.1)
// silently made the documented floor uninstallable, and CI never noticed because
// setup-node resolves `22` to the newest 22.x.
//
//   node scripts/check-engines.mjs             # exit 1 if a locked package's engines.node
//                                              # excludes the root floor's minimum version
//   node scripts/check-engines.mjs --runtime   # exit 1 if THIS node is below the root floor
//                                              # (runner/setup.sh runs it before installing)
//   --root <dir>                               # read <dir>/package.json + pnpm-lock.yaml
//
// Zero deps: a small semver range evaluator covering the forms npm `engines` use
// (>=, >, <=, <, =, ^, ~, x-ranges, partial versions, space-AND, ||-OR).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** "22.22" → [22, 22, null]; "v12.22.7" → [12, 22, 7]; "x" / "*" → [null, null, null]. */
function parts(v) {
  const p = String(v).trim().replace(/^v/, "").split(".");
  const n = (s) => (s === undefined || s === "" || /^[x*]$/i.test(s) ? null : parseInt(s, 10));
  return [n(p[0]), n(p[1]), n(p[2])];
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
const fill = (p) => p.map((x) => x ?? 0);
/** The first version above every version matching partial `p` (22 → 23.0.0, 22.1 → 22.2.0). */
function bumpPartial(p) {
  if (p[0] === null) return null;
  if (p[1] === null) return [p[0] + 1, 0, 0];
  if (p[2] === null) return [p[0], p[1] + 1, 0];
  return [p[0], p[1], p[2] + 1];
}

/** One comparator → [lo (inclusive) | null, hi (exclusive) | null] over full versions. */
function bounds(comp) {
  const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(comp);
  const op = m[1] || "";
  const p = parts(m[2]);
  if (p[0] === null) return [null, null]; // * / x / ""
  switch (op) {
    case ">=":
      return [fill(p), null];
    case ">":
      return [bumpPartial(p), null];
    case "<":
      return [null, fill(p)];
    case "<=":
      return [null, bumpPartial(p)];
    case "^": {
      const lo = fill(p);
      if (p[0] > 0 || p[1] === null) return [lo, [p[0] + 1, 0, 0]];
      if (p[1] > 0 || p[2] === null) return [lo, [0, p[1] + 1, 0]];
      return [lo, [0, 0, p[2] + 1]];
    }
    case "~":
      return [fill(p), p[1] === null ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0]];
    default: // "=" or bare: exact when full, the whole partial range otherwise
      return [fill(p), bumpPartial(p)];
  }
}

/** Split a range into OR-alternatives of AND-comparators ("> = 1" → ">=1"). */
function alternatives(range) {
  return String(range)
    .split("||")
    .map((alt) =>
      alt
        .trim()
        .replace(/([<>]=?|=|\^|~)\s+/g, "$1")
        .split(/\s+/)
        .filter(Boolean),
    );
}

/** Does full version `v` ("22.22.0" / "v22.22.0") satisfy npm range `range`? */
export function satisfies(v, range) {
  const ver = fill(parts(v));
  return alternatives(range).some((comps) =>
    (comps.length ? comps : ["*"]).every((c) => {
      const [lo, hi] = bounds(c);
      return (lo === null || cmp(ver, lo) >= 0) && (hi === null || cmp(ver, hi) < 0);
    }),
  );
}

/** The lowest version a range admits ("^22.22.1 || >=24" → "22.22.1"). */
export function minVersion(range) {
  let best = null;
  for (const comps of alternatives(range)) {
    let lo = [0, 0, 0];
    for (const c of comps.length ? comps : ["*"]) {
      const b = bounds(c)[0];
      if (b && cmp(b, lo) > 0) lo = b;
    }
    if (!best || cmp(lo, best) < 0) best = lo;
  }
  return best ? best.join(".") : "0.0.0";
}

/**
 * Every `engines: {node: …}` in a pnpm-lock.yaml `packages:` section, as
 * [{ pkg, range }]. A line-level parse (the lockfile's shape is fixed): the
 * package key is the last two-space-indented `name@version:` line above it.
 */
export function lockEngines(lockText) {
  const out = [];
  let pkg = null;
  for (const line of lockText.split("\n")) {
    const key = /^ {2}('?)([^\s'][^']*?)\1:\s*$/.exec(line);
    if (key) pkg = key[2];
    const eng = /^\s+engines:\s*\{.*?\bnode:\s*('([^']*)'|"([^"]*)"|([^,}]*))/.exec(line);
    if (eng && pkg) out.push({ pkg, range: (eng[2] ?? eng[3] ?? eng[4]).trim() });
  }
  return out;
}

/** The locked packages whose engines.node excludes `floor` (the root's minimum). */
export function engineConflicts(rootRange, lockText) {
  const floor = minVersion(rootRange);
  return {
    floor,
    conflicts: lockEngines(lockText).filter(({ range }) => !satisfies(floor, range)),
  };
}

function main(argv) {
  const rootArg = argv.indexOf("--root");
  const ROOT =
    rootArg >= 0
      ? path.resolve(argv[rootArg + 1])
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const rootRange = pkg.engines?.node;
  if (!rootRange) {
    console.error("check-engines: package.json declares no engines.node");
    return 1;
  }
  if (argv.includes("--runtime")) {
    if (satisfies(process.version, rootRange)) return 0;
    console.error(
      `Node ${process.version} is below Gaffer's floor (engines.node "${rootRange}" in ` +
        `${path.join(ROOT, "package.json")}) — install a newer Node first, e.g. ` +
        "`nvm install 22 && nvm use 22` (or Node 24), then re-run.",
    );
    return 1;
  }
  const { floor, conflicts } = engineConflicts(
    rootRange,
    readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8"),
  );
  if (conflicts.length === 0) {
    console.log(
      `check-engines: every locked engines.node admits Node ${floor} (root "${rootRange}")`,
    );
    return 0;
  }
  console.error(
    `check-engines: the root floor is Node ${floor} (engines.node "${rootRange}"), but with ` +
      "engine-strict=true these locked packages refuse to install there:",
  );
  for (const c of conflicts) console.error(`  ${c.pkg}  engines.node "${c.range}"`);
  console.error(
    "Raise engines.node in package.json (and the docs' Node floor) to the real floor, " +
      "or pin the dependency to a release that supports the declared one.",
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
