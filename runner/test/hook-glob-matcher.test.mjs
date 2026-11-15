#!/usr/bin/env node
// The safety hook's glob component matcher (lib/hook/expand.mjs componentMatcher).
// It used to build a RegExp with `*` as `.*`: a backtracking engine tried every split of
// a name between the stars, so `*a*a*a…b` against one name of eighty `a`s never returned
// and 49 bytes of command stalled the hook until its timeout. The matcher is now a
// two-pointer walk bounded by name length times pattern length. This pins:
//   • the same answers as the old RegExp construction on every small pattern and name
//     (an exhaustive sweep, where the RegExp is still safe to run);
//   • the patterns that stalled, and far larger ones, answered in milliseconds;
//   • a range written backwards matches every name (a superset) instead of throwing.
// Run: node runner/test/hook-glob-matcher.test.mjs
import { componentMatcher } from "../lib/hook/expand.mjs";

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

console.log("== 1: the same answers as the old RegExp on every small pattern ==");
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
      for (const name of names) {
        compared += 1;
        if (want.test(name) !== got.test(name)) {
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

if (fails.length > 0) {
  console.log(`\nhook-glob-matcher: ${fails.length} FAILURE(S):`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\nhook-glob-matcher: ALL ${pass} checks passed`);
