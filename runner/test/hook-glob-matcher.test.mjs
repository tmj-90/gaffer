#!/usr/bin/env node
// The safety hook's glob component matcher (lib/hook/expand.mjs componentMatcher).
// It used to build a RegExp with `*` as `.*`: a backtracking engine tried every split of
// a name between the stars, so `*a*a*a…b` against one name of eighty `a`s never returned
// and 49 bytes of command stalled the hook until its timeout. The matcher is now a
// two-pointer walk bounded by name length times pattern length. This pins:
//   • the same answers as the old RegExp construction on every small pattern and name
//     (an exhaustive sweep, where the RegExp is still safe to run);
//   • the patterns that stalled, and far larger ones, answered in milliseconds;
//   • a range written backwards matches every name (a superset) instead of throwing;
//   • at least every name bash itself matches, compared with the real shell in the C and
//     a UTF-8 locale on generated patterns and names (quoted `!`, `^` and `-` inside a
//     bracket, case folding, names outside ASCII): a name the hook does not match is a
//     path it never judges.
// Run: node runner/test/hook-glob-matcher.test.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  VarTable,
  componentMatcher,
  expandWordFields,
  globField,
  newBudget,
} from "../lib/hook/expand.mjs";
import { scratchDir } from "./lib/hook-harness.mjs";

let pass = 0;
const fails = [];
const ok = (cond, label) => {
  if (cond) pass += 1;
  else {
    fails.push(label);
    console.log(`  FAIL ${label}`);
  }
};

/** A pattern string as the unquoted parts the expander hands the matcher. */
const comp = (pattern) => [...pattern].map((c) => ({ c, q: false }));

// The old construction, kept here only as the reference for small inputs.
function referenceRegExp(pattern, nocase) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let re = "";
  for (let j = 0; j < pattern.length; j += 1) {
    const c = pattern[j];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let k = j + 1;
      if (k < pattern.length && (pattern[k] === "!" || pattern[k] === "^")) k += 1;
      if (k < pattern.length && pattern[k] === "]") k += 1;
      while (k < pattern.length && pattern[k] !== "]") k += 1;
      if (k >= pattern.length) {
        re += "\\[";
        continue;
      }
      const inner = pattern.slice(j + 1, k);
      const neg = /^[!^]/.test(inner);
      const body = (neg ? inner.slice(1) : inner).replace(/[\\\]^[]/g, "\\$&");
      re += `[${neg ? "^" : ""}${body}]`;
      j = k;
    } else re += esc(c);
  }
  return new RegExp(`^${re}$`, nocase ? "is" : "s");
}

console.log("== 1: the old RegExp's answers on every small pattern (more names under nocase) ==");
{
  const atoms = [
    "a",
    "b",
    "A",
    "*",
    "?",
    "[ab]",
    "[!a]",
    "[a-c]",
    "[^b-c]",
    "[]a]",
    "[a-]",
    ".",
    "-",
  ];
  const names = [""];
  for (const len of [1, 2, 3, 4]) {
    const grow = (prefix) => {
      if (prefix.length === len) return names.push(prefix);
      for (const ch of ["a", "b", "c", "A", ".", "-", "]"]) grow(prefix + ch);
    };
    grow("");
  }
  let compared = 0;
  let differ = 0;
  let firstDiff = "";
  const patterns = [];
  const build = (parts) => {
    if (parts.length > 0) patterns.push(parts.join(""));
    if (parts.length === 3) return;
    for (const a of atoms) build([...parts, a]);
  };
  build([]);
  for (const pattern of patterns) {
    for (const nocase of [false, true]) {
      const want = referenceRegExp(pattern, nocase);
      const got = componentMatcher(comp(pattern), { nocase });
      // Under nocase a negated set is any one character (bash folds its endpoints and
      // its members by the locale): the answers may only grow.
      const exact = !nocase || !/\[[!^]/.test(pattern);
      for (const name of names) {
        compared += 1;
        const w = want.test(name);
        const g = got.test(name);
        if (exact ? w !== g : w && !g) {
          differ += 1;
          if (!firstDiff)
            firstDiff = `${JSON.stringify(pattern)} nocase=${nocase} name=${JSON.stringify(name)}`;
        }
      }
    }
  }
  ok(
    differ === 0,
    `${compared} pattern x name pairs agree with the RegExp (first difference: ${firstDiff})`,
  );
  ok(compared > 1_000_000, `the sweep is the size it claims (${compared} pairs)`);
}

console.log("== 2: the patterns that stalled come back at once ==");
{
  const timeIt = (fn) => {
    const start = performance.now();
    const value = fn();
    return { value, ms: performance.now() - start };
  };
  const eighty = "a".repeat(80);
  const stalled = "*a".repeat(20) + "b";
  let r = timeIt(() => componentMatcher(comp(stalled), {}).test(eighty));
  ok(r.value === false && r.ms < 50, `*a x20 + b against 80 a's: no match, ${r.ms.toFixed(1)}ms`);
  r = timeIt(() => componentMatcher(comp("*a".repeat(20)), {}).test(eighty));
  ok(r.value === true && r.ms < 50, `*a x20 against 80 a's: a match, ${r.ms.toFixed(1)}ms`);
  // Far past anything a command line holds: a 255-unit name (the longest a filesystem
  // gives) against 5000 star-letter pairs, and a 20000-unit name against 40 pairs.
  const longName = "a".repeat(255);
  r = timeIt(() => componentMatcher(comp("*a".repeat(5000) + "b"), {}).test(longName));
  ok(
    r.value === false && r.ms < 200,
    `*a x5000 + b against 255 a's: no match, ${r.ms.toFixed(1)}ms`,
  );
  r = timeIt(() => componentMatcher(comp("*a".repeat(40) + "b"), {}).test("a".repeat(20000)));
  ok(
    r.value === false && r.ms < 500,
    `*a x40 + b against 20000 a's: no match, ${r.ms.toFixed(1)}ms`,
  );
  r = timeIt(() => componentMatcher(comp("*".repeat(50000) + "z"), {}).test(longName));
  ok(
    r.value === false && r.ms < 200,
    `50000 stars + z against 255 a's: no match, ${r.ms.toFixed(1)}ms`,
  );
  r = timeIt(() =>
    componentMatcher(comp("[a-c]*".repeat(300) + "[!a]"), { nocase: true }).test(
      "B".repeat(254) + "x",
    ),
  );
  ok(
    r.value === false && r.ms < 300,
    `300 class-star pairs, case-insensitive, 255-unit name: ${r.ms.toFixed(1)}ms`,
  );
}

console.log("== 3: syntax the matcher does not model matches every name ==");
{
  let m;
  let threw = false;
  try {
    m = componentMatcher(comp("[z-a]*"), {});
  } catch {
    threw = true;
  }
  ok(
    !threw && m.test("anything") && m.test(".hidden") && m.dots === true,
    "a range written backwards is a superset, not a crash",
  );
  m = componentMatcher(comp("+(.)env"), {});
  ok(
    m.test(".env") && m.dots === true,
    "an extglob group still matches every name, dot entries included",
  );
  m = componentMatcher(comp("[[:alpha:]]x"), {});
  ok(m.test("zz") && m.dots === true, "a POSIX class still matches every name");
}

console.log("== 4: ordinary glob rules ==");
{
  const m = (pattern, opts = {}) => componentMatcher(comp(pattern), opts);
  ok(m("*.js").test("a.js") && !m("*.js").test("a.jsx") && !m("*.js").test("js"), "*.js");
  ok(m("a?c").test("abc") && !m("a?c").test("ac") && !m("a?c").test("abbc"), "a?c");
  ok(m("[!.]*").test("x") && !m("[!.]*").test(".x"), "[!.]* leaves dot names out");
  ok(
    m("*").test("") && m("**").test("abc") && !m("?").test(""),
    "stars match the empty name, ? does not",
  );
  ok(
    m("README*", { nocase: true }).test("readme.md") && !m("README*").test("readme.md"),
    "nocase folds letters only when asked",
  );
  ok(m("[a-c]x", { nocase: true }).test("Bx") && !m("[a-c]x").test("Bx"), "nocase folds a range");
  ok(m("a[").test("a[") && !m("a[").test("a"), "an unclosed bracket is a literal");
  const quoted = [
    { c: "*", q: true },
    { c: ".", q: false },
    { c: "j", q: false },
  ];
  ok(
    componentMatcher(quoted, {}).test("*.j") && !componentMatcher(quoted, {}).test("a.j"),
    "a quoted star is a literal star",
  );
}

console.log("== 5: quoting, case folding and names outside ASCII ==");
{
  /** Parts as the lexer hands them: `\\x` is a quoted x. */
  const parts = (pattern) => {
    const out = [];
    for (let i = 0; i < pattern.length; i += 1) {
      if (pattern[i] === "\\" && i + 1 < pattern.length) out.push({ c: pattern[++i], q: true });
      else out.push({ c: pattern[i], q: false });
    }
    return out;
  };
  const m = (pattern, opts = {}) => componentMatcher(parts(pattern), opts);
  ok(m(".[\\!e]nv").test(".env"), "a quoted ! opening a bracket is a literal: .[\\!e]nv is .env");
  ok(m(".[\\^e]nv").test(".env"), "so is a quoted ^");
  ok(!m(".[!e]nv").test(".env"), "an unquoted ! still negates");
  ok(m("[a\\-c]").test("-"), "a quoted - is a literal: [a\\-c] holds -");
  ok(m("[.-K]", { nocase: true }).test("_"), "nocase folds a range's endpoints: [.-K] holds _");
  ok(m("[!a]", { nocase: true }).test("A"), "under nocase a negated set is any one character");
  ok(m("[a-z]", { collate: true }).test("B"), "ranges by collation: a range is any character");
  ok(
    m("??").test("\u00e9") && m("??").test("\u{1f600}x"),
    "? against names outside ASCII: a superset",
  );
  ok(
    m("k*", { nocase: true }).test("\u212a.txt"),
    "nocase: the Kelvin sign is k in a UTF-8 locale",
  );
  ok(m("\u212a*", { nocase: true }).test("k.txt"), "nocase: a non-ASCII letter in the pattern");
  ok(!m("*.js").test("\u00e9.ts") && m("*.ts").test("\u00e9.ts"), "stars and literals stay exact");
}

console.log("== 6: at least what bash matches, against the real shell ==");
{
  const ver = spawnSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" });
  const major = Number(String(ver.stdout).trim());
  const locales = ["C"];
  const utf8 = spawnSync("bash", ["-c", "printf %s \u00e9 | wc -m"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, LC_ALL: "C.UTF-8" },
  });
  if (String(utf8.stdout).trim() === "1") locales.push("C.UTF-8");
  if (!(major >= 5)) {
    console.log(`  note: bash ${ver.stdout.trim() || "?"} here; the comparison needs bash 5`);
  } else {
    let seed = 20261115;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const NAME = [
      ..."abcABzZ-][!^.e_09~ ",
      "\u00e9",
      "\u00df",
      "\u212a",
      "k",
      "K",
      "\u{1f600}",
      "\n",
    ];
    const PAT = [..."abcAz-]!^.ek_0", "\u00e9"];
    const quote = (c) => (c === "\n" ? "$'\\n'" : rnd() < 0.5 && c !== "'" ? `'${c}'` : `\\${c}`);
    const lit = (c) => (/[A-Za-z0-9_.,-]/.test(c) && rnd() < 0.7 ? c : quote(c));
    const set = () => {
      let s = "[";
      if (rnd() < 0.35) s += pick(["!", "^", "\\!", "'!'", "\\^", '"^"']);
      if (rnd() < 0.2) s += "]";
      if (rnd() < 0.2) s += "-";
      for (let i = 0, n = 1 + Math.floor(rnd() * 3); i < n; i += 1) {
        const r = rnd();
        const c = pick(PAT.filter((x) => x !== "]"));
        if (r < 0.35) s += `${c}-${pick(PAT.filter((x) => x !== "]"))}`;
        else if (r < 0.5) s += quote(pick(PAT));
        else if (r < 0.65) s += pick(["a\\-c", "a'-'c", "\\]", "'['"]);
        else s += c === "!" || c === "^" ? `\\${c}` : c;
      }
      if (rnd() < 0.2) s += "-";
      return `${s}]`;
    };
    const pattern = () => {
      let p = "";
      let glob = false;
      for (let i = 0, n = 1 + Math.floor(rnd() * 4); i < n; i += 1) {
        const r = rnd();
        if (r < 0.2) ((p += "*"), (glob = true));
        else if (r < 0.35) ((p += "?"), (glob = true));
        else if (r < 0.65) ((p += set()), (glob = true));
        else p += lit(pick(NAME));
      }
      return glob ? p : `${p}*`;
    };
    const ROOT = scratchDir("gaffer-glob-bash-");
    let cases = 0;
    const misses = [];
    for (let i = 0; i < 150; i += 1) {
      const dir = join(ROOT, String(i));
      mkdirSync(dir);
      for (let j = 0, k = 3 + Math.floor(rnd() * 10); j < k; j += 1) {
        let n = "";
        for (let c = 0, len = 1 + Math.floor(rnd() * 4); c < len; c += 1) n += pick(NAME);
        if (n !== "." && n !== "..") writeFileSync(join(dir, n), "");
      }
      const pat = pattern();
      const ex = expandWordFields(pat, new VarTable({}, ""), [dir]);
      for (const loc of locales) {
        for (const [nocase, dotglob] of [
          [false, false],
          [true, false],
          [false, true],
          [true, true],
        ]) {
          const opts = [nocase ? "nocaseglob" : "", dotglob ? "dotglob" : ""].join(" ").trim();
          const sh =
            `cd "$1" || exit 9; shopt -s nullglob ${opts}; ` +
            `eval 'for f in '"$2"'; do printf "%s\\0" "$f"; done'`;
          const r = spawnSync("bash", ["-c", sh, "glob", dir, pat], {
            encoding: "utf8",
            env: { PATH: process.env.PATH, LC_ALL: loc },
          });
          if (r.status !== 0) continue;
          cases += 1;
          if (!ex.fields) continue; // the hook refuses what it cannot expand
          const hook = new Set();
          let refused = false;
          for (const f of ex.fields) {
            const g = globField(f, dir, newBudget(), { nocase, dotglob });
            if (g.kind === "paths") for (const p of g.paths) hook.add(p.slice(dir.length + 1));
            else if (g.kind === "literal") hook.add(g.path);
            else if (g.kind !== "nomatch") refused = true;
          }
          if (refused) continue;
          for (const name of r.stdout.split("\0")) {
            if (name !== "" && !hook.has(name)) {
              misses.push(`${JSON.stringify(pat)} ${loc} ${opts || "-"}: ${JSON.stringify(name)}`);
            }
          }
        }
      }
    }
    rmSync(ROOT, { recursive: true, force: true });
    ok(cases > 600, `compared with bash on ${cases} pattern, locale and option cases`);
    ok(
      misses.length === 0,
      `every name bash matches, the hook matches (${misses.length} missed: ${misses.slice(0, 5).join("; ")})`,
    );
  }
}

if (fails.length > 0) {
  console.log(`\nhook-glob-matcher: ${fails.length} FAILURE(S):`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\nhook-glob-matcher: ALL ${pass} checks passed`);
