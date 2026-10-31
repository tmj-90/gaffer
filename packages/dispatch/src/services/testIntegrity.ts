/**
 * GATE INTEGRITY: did a delivery weaken the tests that decide it is done?
 *
 * The runner decides "done" by running the repo's test / typecheck / lint commands in
 * the delivery worktree. A gate that only checks "the tests pass" can be passed by
 * deleting a failing test, renaming it out of the runner's glob, marking it `.skip`,
 * or rewriting the `test` script. This module classifies a base..head change for
 * exactly those moves:
 *
 *  - test files DELETED or RENAMED (conventional test paths per stack);
 *  - skip / focus markers ADDED (`.skip`, `.only`, `xit`, `it.todo`, `@pytest.mark.skip`,
 *    `xfail`, `t.Skip`, `#[ignore]`, `@Disabled`, …) on lines the delivery added;
 *  - a gate-relevant package.json script CHANGED or REMOVED (`test`, `lint`,
 *    `typecheck`, … and any script the gate commands name), or anything it reaches
 *    changed, removed or ADDED: its `pre`/`post` hooks and the scripts its body runs;
 *  - a test-runner config file MODIFIED, DELETED or RENAMED (vitest/jest/playwright/
 *    pytest.ini/conftest.py/…), which can exclude tests without touching them.
 *
 * ONE implementation, two callers: the runner's integrity GATE row
 * (packages/crew runtime/dod/gateIntegrityCli.ts, run by runner/lib/dod.sh) and the
 * server-side `test-modified` risk annotation (diffService.ts) that holds an auto-ship
 * for a human. It only ever FLAGS: nothing here fails a delivery.
 *
 * The classifiers are pure. {@link collectTestIntegrity} is the one I/O helper; it takes
 * an injected git runner so both callers (and the tests) pass their own. Over-flagging is
 * the safe direction (a human looks), so the patterns lean inclusive.
 */

/** One `git diff --name-status` entry. `from` is set for a rename/copy. */
export interface NameStatusEntry {
  /** The status letter: A, M, D, R, C, T, U or X. */
  readonly status: string;
  /** The path at head (the destination for a rename/copy). */
  readonly path: string;
  /** The path at base, for a rename/copy. */
  readonly from?: string;
}

/** A skip/focus marker on a line the delivery added. */
export interface SkipMarker {
  readonly path: string;
  /** Canonical marker name, e.g. `it.skip`, `xit`, `@pytest.mark.xfail`, `t.Skip`. */
  readonly marker: string;
  /** Line number at head when the hunk header gave one, else null. */
  readonly line: number | null;
}

export interface ScriptChange {
  /** The package.json the script lives in (repo-relative). */
  readonly file: string;
  readonly script: string;
  /** `added`: a script the gate now reaches that base did not have (e.g. a new `pretest`). */
  readonly change: "changed" | "removed" | "added";
}

export interface ConfigChange {
  readonly path: string;
  /** `added`: only for package-manager rc files ({@link isGateRcPath}), never test config. */
  readonly change: "modified" | "deleted" | "renamed" | "added";
}

export interface TestIntegrityFindings {
  readonly deleted: readonly string[];
  readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly markers: readonly SkipMarker[];
  readonly scripts: readonly ScriptChange[];
  readonly configs: readonly ConfigChange[];
  /**
   * Why the scan could not see the whole change (git failed, output capped). Non-empty
   * means "could not prove nothing was weakened" and is itself a reason to flag.
   */
  readonly incomplete: readonly string[];
}

// ---------------------------------------------------------------------------
// Test paths
// ---------------------------------------------------------------------------

/** Basename shapes that are test files in their stack. */
const TEST_BASENAME_RE = new RegExp(
  [
    String.raw`\.(?:test|spec|e2e|it)\.[cm]?[jt]sx?$`, // JS/TS (vitest, jest, mocha, playwright)
    String.raw`\.(?:test|spec)\.(?:vue|svelte)$`,
    String.raw`_test\.go$`,
    // unittest's default discovery glob is `test*.py` (Django's `app/tests.py` is in it);
    // pytest's defaults are `test_*.py` and `*_test.py`.
    String.raw`^test[^/]*\.py$`,
    String.raw`_test\.py$`,
    String.raw`_(?:spec|test)\.rb$`,
    String.raw`(?:Tests?|IT|Spec)\.(?:java|kt|kts|scala|groovy)$`,
    String.raw`Tests?\.cs$`,
    String.raw`Test\.php$`,
    String.raw`_test\.exs$`,
    String.raw`\.(?:test\.sh|bats)$`,
  ].join("|"),
);

/** Directory segments that hold tests (anything beneath them counts, fixtures too). */
const TEST_DIR_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|testdata)\//;

/**
 * Is `p` a test file? Conventional paths per stack, plus an operator's additive
 * pattern (`GAFFER_TEST_PATH_RE`). The extra pattern can only WIDEN the set.
 */
export function isTestPath(p: string, extra?: RegExp | null): boolean {
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (TEST_BASENAME_RE.test(base) || TEST_DIR_RE.test(p)) return true;
  return extra ? extra.test(p) : false;
}

/**
 * Parse the operator's additive test-path pattern. A malformed pattern is ignored
 * (the conventional set still applies), never thrown: a typo must not stop the scan.
 */
export function extraTestPathRe(raw: string | undefined): RegExp | null {
  const src = (raw ?? "").trim();
  if (!src) return null;
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Skip / focus markers
// ---------------------------------------------------------------------------

type PathPred = (p: string, extra: RegExp | null) => boolean;

const ext =
  (re: RegExp): PathPred =>
  (p, extra) =>
    re.test(p) && isTestPath(p, extra);

const JS_TEST = ext(/\.(?:[cm]?[jt]sx?|vue|svelte)$/);
const PY_TEST = ext(/\.py$/);
const GO_TEST: PathPred = (p) => /_test\.go$/.test(p);
const RUST_ANY: PathPred = (p) => /\.rs$/.test(p); // unit tests live in src/*.rs
const JVM_TEST = ext(/\.(?:java|kt|kts|scala|groovy)$/);
const CS_TEST = ext(/\.cs$/);
const RB_TEST = ext(/\.rb$/);
const PHP_TEST = ext(/\.php$/);
const EX_TEST = ext(/\.exs?$/);

interface MarkerRule {
  readonly applies: PathPred;
  readonly re: RegExp;
  /** Canonical name from the match. */
  readonly name: (m: RegExpExecArray) => string;
  /**
   * Match the RAW added line, comments included: for markers that ARE comments (a Go
   * `//go:build ignore` constraint drops the whole test file from `go test`).
   */
  readonly raw?: boolean;
}

const MARKER_RULES: readonly MarkerRule[] = [
  {
    // describe.skip / it.only / test.todo / it.skipIf(…) / test.fixme (playwright), also
    // behind modifiers: it.concurrent.skip, describe.sequential.only, test.concurrent.todo.
    applies: JS_TEST,
    re: /\b(describe|it|test|context|suite|specify|bench)((?:\s*\.\s*\w+)*?)\s*\.\s*(skip|only|todo|fixme|skipIf|runIf)\b/,
    name: (m) => `${m[1]}${(m[2] ?? "").replace(/\s+/g, "")}.${m[3]}`,
  },
  {
    // The same markers through bracket access: test["skip"](…), it['only'](…).
    applies: JS_TEST,
    re: /\b(describe|it|test|context|suite|specify|bench)((?:\s*\.\s*\w+)*?)\s*\[\s*(['"`])(skip|only|todo|fixme|skipIf|runIf)\3\s*\]/,
    name: (m) => `${m[1]}${(m[2] ?? "").replace(/\s+/g, "")}.${m[4]}`,
  },
  {
    // A chained marker on its own line: `test\n  .skip("a", …)`.
    applies: JS_TEST,
    re: /^\s*\??\.\s*(skip|only|todo|fixme|skipIf|runIf)\s*[(`]/,
    name: (m) => `.${m[1]} (chained)`,
  },
  {
    // Destructured out of the test API: `const { skip } = test; skip("a", …)`.
    applies: JS_TEST,
    re: /\{[^}]*?\b(skip|only|todo)\b[^}]*\}\s*=\s*(describe|it|test|context|suite|specify)\b(?!\s*\()/,
    name: (m) => `{ ${m[1]} } = ${m[2]}`,
  },
  {
    // node:test / vitest options: test("a", { skip: true }, …), { todo: "later" },
    // { skip: !hasDb }, { skip: process.platform === "win32" }. A number is left alone
    // (`{ skip: 10, take: 5 }` is a query in a test, not a test option).
    applies: JS_TEST,
    re: /(?:^|[{,])\s*['"]?(skip|todo|only)['"]?\s*:\s*(?:true\b|['"`]|!|process\.)/,
    name: (m) => `{ ${m[1]}: … } option`,
  },
  {
    // Runtime skips inside a test body: node:test t.skip()/t.todo(), mocha this.skip(),
    // vitest ctx.skip()/context.skip().
    applies: JS_TEST,
    re: /(?:^|[^.\w$])(t|ctx|context|this)\s*\.\s*(skip|todo)\s*\(/,
    name: (m) => `${m[1]}.${m[2]}()`,
  },
  {
    applies: JS_TEST,
    re: /(?:^|[^.\w$])(xit|xdescribe|xtest|xcontext|xspecify|fit|fdescribe|ftest)\s*\(/,
    name: (m) => m[1]!,
  },
  {
    applies: PY_TEST,
    re: /@pytest\.mark\.(skip|skipif|xfail)\b/,
    name: (m) => `@pytest.mark.${m[1]}`,
  },
  {
    // Module/class-level marks (`pytestmark = pytest.mark.skip`) and `from pytest import mark`.
    applies: PY_TEST,
    re: /\b(?:pytest\.)?mark\.(skip|skipif|xfail)\b/,
    name: (m) => `pytest.mark.${m[1]}`,
  },
  {
    applies: PY_TEST,
    re: /\bpytest\.(skip|xfail|importorskip)\s*\(/,
    name: (m) => `pytest.${m[1]}()`,
  },
  {
    applies: PY_TEST,
    re: /@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b/,
    name: (m) => `@unittest.${m[1]}`,
  },
  {
    applies: PY_TEST,
    re: /\bunittest\.(skip|skipIf|skipUnless|expectedFailure)\b/,
    name: (m) => `unittest.${m[1]}`,
  },
  { applies: PY_TEST, re: /\.skipTest\s*\(/, name: () => "skipTest()" },
  { applies: PY_TEST, re: /\bSkipTest\b/, name: () => "SkipTest" },
  // pytest (and nose) do not collect a module or class that sets `__test__ = False`.
  { applies: PY_TEST, re: /^\s*__test__\s*=\s*False\b/, name: () => "__test__ = False" },
  { applies: GO_TEST, re: /\b[tb]\.(Skip|Skipf|SkipNow)\s*\(/, name: (m) => `t.${m[1]}` },
  {
    // A build constraint drops the whole _test.go file (`//go:build ignore`).
    applies: GO_TEST,
    re: /^\s*\/\/\s*(?:go:build|\+build)\s/,
    name: () => "go build constraint",
    raw: true,
  },
  { applies: RUST_ANY, re: /#\[\s*ignore\b/, name: () => "#[ignore]" },
  { applies: JVM_TEST, re: /@(Disabled|Ignore)\b/, name: (m) => `@${m[1]}` },
  { applies: CS_TEST, re: /\[\s*(?:Ignore|Skip)\b|\bSkip\s*=\s*"/, name: () => "Skip" },
  {
    applies: RB_TEST,
    re: /^\s*(xit|xdescribe|xcontext|xspecify|skip|pending)\b/,
    name: (m) => m[1]!,
  },
  { applies: PHP_TEST, re: /markTest(Skipped|Incomplete)\s*\(/, name: (m) => `markTest${m[1]}` },
  { applies: EX_TEST, re: /@(?:module)?tag\s+:skip\b/, name: () => "@tag :skip" },
];

/** Could `p` carry a marker this module looks for? (Bounds the patch the scan reads.) */
export function markerCandidate(p: string, extra?: RegExp | null): boolean {
  const x = extra ?? null;
  return MARKER_RULES.some((r) => r.applies(p, x));
}

/** Which comment syntaxes a file's language has (what {@link codeOf} strips). */
interface CommentStyle {
  /** `//` line and `/* … *\/` block comments. */
  readonly slash: boolean;
  /** `#` line comments (`#[` stays code: a Rust/PHP attribute). */
  readonly hash: boolean;
  /** JS-family regex literals, so a `/*` or `//` inside one is not read as a comment. */
  readonly regex: boolean;
}

function commentStyleOf(p: string): CommentStyle {
  if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(p)) return { slash: true, hash: false, regex: true };
  if (/\.php$/.test(p)) return { slash: true, hash: true, regex: false };
  if (/\.(?:py|rb|exs?)$/.test(p)) return { slash: false, hash: true, regex: false };
  return { slash: true, hash: false, regex: false }; // go, rust, jvm, c#
}

/** A `/` here starts a JS regex literal (not division) when the previous token is not a value. */
function regexCanStart(prev: string): boolean {
  return prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev);
}

/**
 * The CODE on one added line: comments removed, string and regex literals kept. A
 * marker inside a comment skips nothing, but code after a comment does — `/**\/
 * test.skip(…)` or `x; // note` must still be read — so comments are cut out of the
 * line rather than the whole line being judged a comment. A line that continues a
 * block comment (`* …`) is comment up to its `*\/`.
 */
function codeOf(line: string, style: CommentStyle): string {
  let s = line;
  if (style.slash) {
    const t = s.trimStart();
    if (t.startsWith("*")) {
      const end = t.indexOf("*/");
      if (end < 0) return "";
      s = t.slice(end + 2);
    }
  }
  let out = "";
  let prev = ""; // last non-space code character
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    const n = s[i + 1] ?? "";
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1);
      prev = c;
      i = j + 1;
      continue;
    }
    if (style.slash && c === "/" && n === "/") break;
    if (style.slash && c === "/" && n === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) break;
      out += " ";
      i = end + 2;
      continue;
    }
    if (style.hash && c === "#" && n !== "[") break;
    if (style.regex && c === "/" && regexCanStart(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < s.length) {
        const r = s[j]!;
        if (r === "\\") j += 2;
        else if (inClass) {
          if (r === "]") inClass = false;
          j += 1;
        } else if (r === "[") {
          inClass = true;
          j += 1;
        } else if (r === "/") break;
        else j += 1;
      }
      out += s.slice(i, j + 1);
      prev = "/";
      i = j + 1;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/** Unquote a git C-quoted path (`"a\tb"`), or return it as-is. */
function unquoteGitPath(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p.slice(1, -1);
  }
}

/**
 * Skip/focus markers on ADDED lines of a unified diff (any context size; `-U0` is what
 * {@link collectTestIntegrity} reads). Removed lines never count: deleting a `.skip`
 * re-enables a test.
 */
export function addedSkipMarkers(patch: string, extra?: RegExp | null): SkipMarker[] {
  const x = extra ?? null;
  const out: SkipMarker[] = [];
  let path: string | null = null;
  let rules: readonly MarkerRule[] = [];
  let lineNo: number | null = null;
  let style: CommentStyle = commentStyleOf("");
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = unquoteGitPath(raw.slice(4).replace(/\t.*$/, ""));
      path = target === "/dev/null" ? null : target.replace(/^b\//, "");
      rules = path ? MARKER_RULES.filter((r) => r.applies(path!, x)) : [];
      style = path ? commentStyleOf(path) : style;
      lineNo = null;
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      path = null;
      rules = [];
      lineNo = null;
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      lineNo = m ? Number.parseInt(m[1]!, 10) : null;
      continue;
    }
    if (!path) continue;
    if (raw.startsWith("+")) {
      const line = raw.slice(1);
      const code = rules.length > 0 ? codeOf(line, style) : "";
      for (const rule of rules) {
        const target = rule.raw ? line : code;
        if (target.trim() === "") continue;
        const m = rule.re.exec(target);
        if (m) {
          out.push({ path, marker: rule.name(m), line: lineNo });
          break;
        }
      }
      if (lineNo !== null) lineNo += 1;
    } else if (raw.startsWith(" ")) {
      if (lineNo !== null) lineNo += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// package.json gate scripts + test-runner config
// ---------------------------------------------------------------------------

/** Script names that are gate-relevant by convention (plus their pre/post hooks). */
export const GATE_SCRIPT_RE =
  /^(?:pre|post)?(?:test|tests|lint|typecheck|type-check|check-types|types:check|check|verify|ci)(?:[:._-].*)?$/;

function scriptsOf(text: string | null): Record<string, string> | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object") return {};
    const s = (v as { scripts?: unknown }).scripts;
    if (!s || typeof s !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, body] of Object.entries(s as Record<string, unknown>)) {
      if (typeof body === "string") out[k] = body;
    }
    return out;
  } catch {
    return null;
  }
}

/** An npm-run-all style script pattern: `*` matches within one `:` segment, `**` across. */
function scriptPatternRe(pat: string): RegExp {
  return new RegExp(
    `^${pat
      .split("**")
      .map((x) =>
        x
          .split("*")
          .map((y) => y.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^:]*"),
      )
      .join(".*")}$`,
  );
}

/**
 * Script names a script BODY runs, matched against `universe` (the names that exist at
 * base or head): `npm|pnpm|yarn|bun run X`, `npm test`/`npm start`, `pnpm X`/`yarn X`,
 * the words of `run-s`/`run-p`/`npm-run-all` (globs `x:*` / `x:**` included) and
 * `npm:X` (concurrently). Leans inclusive: an over-match only widens what is checked.
 */
export function scriptRefs(body: string, universe: readonly string[]): string[] {
  const out = new Set<string>();
  const known = new Set(universe);
  const addName = (n: string | undefined): void => {
    if (n && known.has(n)) out.add(n);
  };
  const addPattern = (pat: string): void => {
    if (!pat.includes("*")) return addName(pat);
    const re = scriptPatternRe(pat);
    for (const n of universe) if (re.test(n)) out.add(n);
  };
  const PM_VALUE_FLAGS = new Set([
    "--filter",
    "-F",
    "-C",
    "--dir",
    "--prefix",
    "--cwd",
    "-w",
    "--workspace",
  ]);
  for (const seg of body.split(/&&|\|\||[;|&()`\n]/)) {
    const w = seg
      .trim()
      .split(/[ \t]+/)
      .map((t) => t.replace(/^["']+|["']+$/g, ""))
      .filter((t) => t !== "");
    for (let i = 0; i < w.length; i += 1) {
      const tok = w[i]!;
      const npmColon = /^npm:(.+)$/.exec(tok);
      if (npmColon) {
        addPattern(npmColon[1]!);
        continue;
      }
      const cmd = tok.replace(/^.*\//, "");
      if (cmd === "run-s" || cmd === "run-p" || cmd === "npm-run-all") {
        for (let j = i + 1; j < w.length; j += 1) if (!w[j]!.startsWith("-")) addPattern(w[j]!);
        break;
      }
      if (cmd !== "npm" && cmd !== "pnpm" && cmd !== "yarn" && cmd !== "bun") continue;
      let j = i + 1;
      const skipFlags = (): void => {
        while (j < w.length && w[j]!.startsWith("-")) {
          j += PM_VALUE_FLAGS.has(w[j]!) ? 2 : 1;
        }
      };
      skipFlags();
      const verb = w[j];
      if (verb === "run" || verb === "run-script") {
        j += 1;
        skipFlags();
        addName(w[j]);
      } else if (cmd === "npm" && (verb === "test" || verb === "t" || verb === "tst")) {
        addName("test");
      } else if (cmd === "npm" && (verb === "start" || verb === "stop" || verb === "restart")) {
        addName(verb);
      } else if (
        (cmd === "pnpm" || cmd === "yarn") &&
        verb !== undefined &&
        !PM_BUILTINS.has(verb)
      ) {
        addName(verb);
      }
    }
  }
  return [...out];
}

/**
 * Every script a run of `roots` reaches in one scripts map: the roots, each one's
 * `pre<name>`/`post<name>` hook, and (transitively) the scripts their bodies run
 * ({@link scriptRefs}). Roots are kept even when absent from `scripts` (a removal).
 * Discovery order, de-duplicated.
 */
export function scriptClosure(
  scripts: Readonly<Record<string, string>>,
  roots: readonly string[],
  universe: readonly string[],
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (name: string, isRoot: boolean): void => {
    if (seen.has(name) || order.length > 500) return;
    if (!isRoot && !(name in scripts)) return;
    seen.add(name);
    order.push(name);
    if (`pre${name}` in scripts) visit(`pre${name}`, false);
    const body = scripts[name];
    if (body !== undefined) for (const r of scriptRefs(body, universe)) visit(r, false);
    if (`post${name}` in scripts) visit(`post${name}`, false);
  };
  for (const r of roots) visit(r, true);
  return order;
}

/**
 * The changes inside the closure of `roots` (at base AND at head): a script that is
 * changed, removed, or ADDED (a new `pretest`, or a new script a changed body now runs).
 */
function closureChanges(
  base: Readonly<Record<string, string>>,
  head: Readonly<Record<string, string>>,
  roots: readonly string[],
): Array<{ script: string; change: ScriptChange["change"] }> {
  const universe = [...new Set([...Object.keys(base), ...Object.keys(head)])];
  const names = [
    ...new Set([...scriptClosure(base, roots, universe), ...scriptClosure(head, roots, universe)]),
  ];
  const out: Array<{ script: string; change: ScriptChange["change"] }> = [];
  for (const n of names) {
    const b = base[n];
    const h = head[n];
    if (b !== undefined && h === undefined) out.push({ script: n, change: "removed" });
    else if (b === undefined && h !== undefined) out.push({ script: n, change: "added" });
    else if (b !== undefined && h !== undefined && b.trim() !== h.trim())
      out.push({ script: n, change: "changed" });
  }
  return out;
}

/**
 * Gate-relevant scripts a delivery CHANGED, REMOVED or ADDED in one package.json. The
 * gate scripts are the ones that exist at base and are gate-named by convention
 * (`test`, `lint`, …) or named by the registered gate commands (`gateScriptNames`,
 * e.g. `pnpm run verify:fast`). Every script they REACH is checked too — their
 * `pre`/`post` hooks and the scripts their bodies run (`npm run unit`, `run-s a b`) —
 * at base and at head, so an added `pretest`, or a changed `unit` behind
 * `test: npm run unit`, is flagged. A brand-new gate script (none at base) is not
 * flagged: it cannot weaken an existing gate. An unparseable base or head file is
 * reported as a change to `scripts` (fail toward a human).
 */
export function changedGateScripts(
  file: string,
  baseText: string | null,
  headText: string | null,
  gateScriptNames: readonly string[] = [],
): ScriptChange[] {
  const base = scriptsOf(baseText);
  if (baseText === null) return []; // new package.json: nothing to weaken
  const head = headText === null ? {} : scriptsOf(headText);
  if (base === null || head === null) {
    return [{ file, script: "(unparseable package.json)", change: "changed" }];
  }
  const named = new Set(gateScriptNames.filter((n) => !n.includes("*")));
  const patterns = gateScriptNames.filter((n) => n.includes("*")).map(scriptPatternRe);
  const roots = Object.keys(base).filter(
    (n) => GATE_SCRIPT_RE.test(n) || named.has(n) || patterns.some((re) => re.test(n)),
  );
  return closureChanges(base, head, roots).map((c) => ({ file, ...c }));
}

/** Test-runner config: a change here can exclude tests without touching a test file. */
const TEST_CONFIG_RE =
  /(?:^|\/)(?:(?:vitest|jest|playwright|cypress|karma|ava|wdio|nyc)\.config\.[^/]+|vitest\.workspace\.[^/]+|karma\.conf\.[^/]+|jest\.setup\.[^/]+|\.mocharc(?:\.[^/]+)?|\.nycrc(?:\.[^/]+)?|pytest\.ini|conftest\.py|tox\.ini|\.coveragerc|phpunit\.xml(?:\.dist)?|\.rspec)$/i;

export function isTestConfigPath(p: string): boolean {
  return TEST_CONFIG_RE.test(p) || isGateRcPath(p);
}

/**
 * Package-manager rc files, at the root or in any package dir. They configure how
 * `npm test` / `pnpm run lint` / `yarn test` / `bun test` RUN — `script-shell=/bin/true`
 * or `node-options=--test-name-pattern=x` in a project `.npmrc` turns every gate into a
 * no-op without touching package.json or a test. Unlike test-runner config (which a
 * greenfield scaffold adds as a matter of course) one of these is flagged on ADD too:
 * an rc file a delivery introduces redirects the gate just as surely as one it edits.
 */
export const GATE_RC_NAMES = [".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml"] as const;
const GATE_RC_RE = /(?:^|\/)(?:\.npmrc|\.yarnrc|\.yarnrc\.yml|bunfig\.toml)$/i;

export function isGateRcPath(p: string): boolean {
  return GATE_RC_RE.test(p);
}

// ---------------------------------------------------------------------------
// Analysis + summary
// ---------------------------------------------------------------------------

export interface AnalyzeInput {
  readonly nameStatus: readonly NameStatusEntry[];
  /** Unified diff text (any context size) covering at least the marker candidates. */
  readonly patch: string;
  /** Base/head text of each changed package.json (null where absent). */
  readonly packageJsons?: ReadonlyArray<{
    readonly file: string;
    readonly base: string | null;
    readonly head: string | null;
  }>;
  readonly gateScriptNames?: readonly string[];
  readonly extraTestPathRe?: RegExp | null;
  readonly incomplete?: readonly string[];
}

/** Classify a base..head change. Pure. */
export function analyzeTestIntegrity(input: AnalyzeInput): TestIntegrityFindings {
  const extra = input.extraTestPathRe ?? null;
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const configs: ConfigChange[] = [];
  for (const e of input.nameStatus) {
    const s = e.status.charAt(0);
    if (s === "D") {
      if (isTestPath(e.path, extra)) deleted.push(e.path);
      if (isTestConfigPath(e.path)) configs.push({ path: e.path, change: "deleted" });
    } else if (s === "R" && e.from !== undefined) {
      if (isTestPath(e.from, extra)) renamed.push({ from: e.from, to: e.path });
      if (isTestConfigPath(e.from)) configs.push({ path: e.from, change: "renamed" });
      // Renaming a file INTO an rc name is adding that rc file.
      else if (isGateRcPath(e.path)) configs.push({ path: e.path, change: "added" });
    } else if (s === "M" || s === "T") {
      if (isTestConfigPath(e.path)) configs.push({ path: e.path, change: "modified" });
    } else if (s === "A" || s === "C") {
      if (isGateRcPath(e.path)) configs.push({ path: e.path, change: "added" });
    }
  }
  const scripts: ScriptChange[] = [];
  for (const pj of input.packageJsons ?? []) {
    scripts.push(...changedGateScripts(pj.file, pj.base, pj.head, input.gateScriptNames ?? []));
  }
  return {
    deleted,
    renamed,
    markers: addedSkipMarkers(input.patch, extra),
    scripts,
    configs,
    incomplete: [...(input.incomplete ?? [])],
  };
}

export function hasIntegrityFindings(f: TestIntegrityFindings): boolean {
  return (
    f.deleted.length > 0 ||
    f.renamed.length > 0 ||
    f.markers.length > 0 ||
    f.scripts.length > 0 ||
    f.configs.length > 0 ||
    f.incomplete.length > 0
  );
}

function configKind(p: string): string {
  return isGateRcPath(p) ? "package-manager config" : "test config";
}

function list(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown}, +${items.length - max} more` : shown;
}

/**
 * One human line per finding, for the Review banner and the evidence row. Ordered
 * deleted → renamed → markers → scripts → config → incomplete.
 */
export function integrityItems(f: TestIntegrityFindings): string[] {
  const out: string[] = [];
  for (const p of f.deleted) out.push(`deleted test file ${p}`);
  for (const r of f.renamed) out.push(`renamed test file ${r.from} → ${r.to}`);
  for (const m of f.markers)
    out.push(`added ${m.marker} in ${m.path}${m.line ? `:${m.line}` : ""}`);
  for (const s of f.scripts) out.push(`${s.change} script "${s.script}" in ${s.file}`);
  for (const c of f.configs) out.push(`${c.change} ${configKind(c.path)} ${c.path}`);
  for (const r of f.incomplete) out.push(`scan incomplete: ${r}`);
  return out;
}

/** The one-line reason: `deleted 1 test file (a.test.ts); added it.skip (b.test.ts:4)`. */
export function summarizeIntegrity(f: TestIntegrityFindings, max = 3): string {
  const parts: string[] = [];
  if (f.deleted.length) {
    parts.push(
      `deleted ${f.deleted.length} test file${f.deleted.length === 1 ? "" : "s"} (${list(f.deleted, max)})`,
    );
  }
  if (f.renamed.length) {
    parts.push(
      `renamed ${f.renamed.length} test file${f.renamed.length === 1 ? "" : "s"} (${list(
        f.renamed.map((r) => `${r.from} → ${r.to}`),
        max,
      )})`,
    );
  }
  if (f.markers.length) {
    parts.push(
      `added skip/only markers (${list(
        f.markers.map((m) => `${m.marker} in ${m.path}${m.line ? `:${m.line}` : ""}`),
        max,
      )})`,
    );
  }
  if (f.scripts.length) {
    parts.push(
      `changed gate script${f.scripts.length === 1 ? "" : "s"} (${list(
        f.scripts.map((s) => `${s.script} ${s.change} in ${s.file}`),
        max,
      )})`,
    );
  }
  const rc = f.configs.filter((c) => isGateRcPath(c.path));
  const tc = f.configs.filter((c) => !isGateRcPath(c.path));
  if (tc.length) {
    parts.push(
      `touched test config (${list(
        tc.map((c) => `${c.path} ${c.change}`),
        max,
      )})`,
    );
  }
  if (rc.length) {
    parts.push(
      `touched package-manager config (${list(
        rc.map((c) => `${c.path} ${c.change}`),
        max,
      )})`,
    );
  }
  if (f.incomplete.length) parts.push(`scan incomplete (${list([...f.incomplete], max)})`);
  return parts.length
    ? parts.join("; ")
    : "no test files deleted or renamed, no skip markers added";
}

/** Every path a finding names (for the risk annotation's `paths`), de-duplicated. */
export function integrityPaths(f: TestIntegrityFindings): string[] {
  const seen = new Set<string>();
  const add = (p: string): void => {
    seen.add(p);
  };
  f.deleted.forEach(add);
  f.renamed.forEach((r) => add(r.from));
  f.markers.forEach((m) => add(m.path));
  f.scripts.forEach((s) => add(s.file));
  f.configs.forEach((c) => add(c.path));
  return [...seen];
}

// ---------------------------------------------------------------------------
// I/O: collect findings from a git repo
// ---------------------------------------------------------------------------

/** Parse `git diff --name-status -z` output (NUL-separated). */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const toks = out.split("\0");
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < toks.length) {
    const status = toks[i] ?? "";
    if (status === "") {
      i += 1;
      continue;
    }
    const s = status.charAt(0);
    if (s === "R" || s === "C") {
      const from = toks[i + 1];
      const to = toks[i + 2];
      if (from === undefined || to === undefined) break;
      entries.push({ status, path: to, from });
      i += 3;
    } else {
      const p = toks[i + 1];
      if (p === undefined) break;
      entries.push({ status, path: p });
      i += 2;
    }
  }
  return entries;
}

/** The git seam {@link collectTestIntegrity} needs: run git with args in the repo. */
/**
 * Tracked paths whose working-tree changes `git diff` does not look at: entries marked
 * skip-worktree (`S`, also what a sparse checkout leaves behind) or assume-unchanged
 * (a lowercase tag), from `git ls-files -v -z`. A gate runs the files ON DISK, so a test
 * changed or deleted under one of these bits passes the gate while the scan — and the
 * auto-commit — see the untouched index copy. Pure.
 */
export function hiddenIndexPaths(lsFilesV: string): string[] {
  const out: string[] = [];
  for (const entry of lsFilesV.split("\0")) {
    if (entry.length < 3 || entry[1] !== " ") continue;
    const tag = entry[0]!;
    if (tag === "S" || (tag >= "a" && tag <= "z")) out.push(entry.slice(2));
  }
  return out;
}

export type IntegrityGit = (
  args: readonly string[],
  opts?: { maxBuffer?: number },
) => { status: number | null; stdout: string; truncated?: boolean };

/** Never run a repo-configured diff driver/textconv: the scan reads raw bytes only. */
const SAFE = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  // Fixed prefixes: repo config (diff.noprefix / mnemonicPrefix / srcPrefix / dstPrefix)
  // must not change the `+++ b/<path>` lines the marker scan parses.
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;
/** Generous caps: the scan reads only names and the marker candidates' hunks. */
const NAMES_MAX = 16 * 1024 * 1024;
const PATCH_MAX = 8 * 1024 * 1024;
const PKG_MAX = 1024 * 1024;
/** Above this many candidate files the patch is read without a pathspec. */
const MAX_PATHSPECS = 1000;
/** At most this many package.json files are compared (a monorepo bump touches many). */
const MAX_PACKAGE_JSONS = 50;

export interface CollectOptions {
  readonly gateScriptNames?: readonly string[];
  readonly extraTestPathRe?: RegExp | null;
}

/**
 * Collect findings for `base..head` (two commits; the caller resolves the merge-base).
 * Every git failure is recorded in `incomplete`, never thrown: a scan that cannot see
 * the change must flag it, not wave it through.
 */
export function collectTestIntegrity(
  git: IntegrityGit,
  base: string,
  head: string,
  opts: CollectOptions = {},
): TestIntegrityFindings {
  const extra = opts.extraTestPathRe ?? null;
  const incomplete: string[] = [];
  const names = git(["diff", "--name-status", "-z", "-M", ...SAFE, base, head], {
    maxBuffer: NAMES_MAX,
  });
  if (names.status !== 0) {
    return analyzeTestIntegrity({
      nameStatus: [],
      patch: "",
      incomplete: [`git could not list the changed files between ${base} and ${head}`],
    });
  }
  if (names.truncated) incomplete.push("the changed-file list was too long to read in full");
  const nameStatus = parseNameStatusZ(names.stdout);

  const candidates = nameStatus
    .filter((e) => e.status.charAt(0) !== "D" && markerCandidate(e.path, extra))
    .map((e) => e.path);
  let patchText = "";
  if (candidates.length > 0) {
    const spec =
      candidates.length <= MAX_PATHSPECS ? ["--", ...candidates.map((p) => `:(literal)${p}`)] : [];
    // --text: a `.gitattributes` that marks the tests `binary` / `-diff` would otherwise
    // print "Binary files differ" and hide every added line from the marker scan.
    const patch = git(["diff", "-U0", "-M", "--text", ...SAFE, base, head, ...spec], {
      maxBuffer: PATCH_MAX,
    });
    if (patch.status !== 0) {
      incomplete.push("git could not read the test files' changes");
    } else {
      patchText = patch.stdout;
      if (patch.truncated)
        incomplete.push("the test files' changes were too large to read in full");
    }
  }

  const pkgEntries = nameStatus.filter((e) => {
    const s = e.status.charAt(0);
    const p = e.from ?? e.path;
    return (s === "M" || s === "D" || s === "R" || s === "T") && /(?:^|\/)package\.json$/.test(p);
  });
  if (pkgEntries.length > MAX_PACKAGE_JSONS) {
    incomplete.push(
      `${pkgEntries.length} package.json files changed; compared the first ${MAX_PACKAGE_JSONS}`,
    );
  }
  const show = (rev: string, p: string): string | null => {
    const r = git(["show", `${rev}:${p}`], { maxBuffer: PKG_MAX });
    return r.status === 0 && !r.truncated ? r.stdout : null;
  };
  const packageJsons = pkgEntries.slice(0, MAX_PACKAGE_JSONS).map((e) => {
    const from = e.from ?? e.path;
    return {
      file: from,
      base: show(base, from),
      head: e.status.charAt(0) === "D" ? null : show(head, e.path),
    };
  });

  return analyzeTestIntegrity({
    nameStatus,
    patch: patchText,
    packageJsons,
    gateScriptNames: opts.gateScriptNames ?? [],
    extraTestPathRe: extra,
    incomplete,
  });
}

// ---------------------------------------------------------------------------
// Gate command resolution (the runner's "read the commands from the base commit")
// ---------------------------------------------------------------------------

/**
 * A package-manager script invocation the gate can pin to the base commit:
 * `npm test`, `npm run lint`, `npm run-script x`, `pnpm test`, `pnpm run x`, `pnpm x`,
 * `yarn x`, `yarn run x`, `bun run x`, each optionally followed by plain arguments.
 * Anything with shell syntax (`&&`, `|`, `;`, `$`, quotes, redirects) or a flag before
 * the script name (`pnpm -r test`) is NOT parsed: it runs as registered, and its
 * scripts are still covered by the integrity scan's script check.
 */
export interface ScriptInvocation {
  readonly pm: "npm" | "pnpm" | "yarn" | "bun";
  readonly script: string;
  /** The words after the script name, with a leading `--` dropped. */
  readonly args: readonly string[];
}

const PM_BUILTINS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "ci",
  "exec",
  "dlx",
  "x",
  "create",
  "init",
  "publish",
  "pack",
  "link",
  "unlink",
  "audit",
  "outdated",
  "why",
  "list",
  "ls",
  "store",
  "config",
  "set",
  "get",
  "help",
  "version",
  "rebuild",
  "prune",
  "dedupe",
  "import",
  "patch",
  "workspace",
  "workspaces",
]);

const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

export function parseScriptInvocation(cmd: string): ScriptInvocation | null {
  const c = cmd.trim();
  if (c === "" || /[^A-Za-z0-9 \t:._\-=/@,+]/.test(c)) return null; // shell syntax: leave it
  const w = c.split(/[ \t]+/);
  const pm = w[0];
  if (pm !== "npm" && pm !== "pnpm" && pm !== "yarn" && pm !== "bun") return null;
  let i = 1;
  let script: string | undefined;
  if (w[i] === "run" || w[i] === "run-script") {
    script = w[i + 1];
    i += 2;
  } else if (pm === "npm" && (w[i] === "test" || w[i] === "t" || w[i] === "tst")) {
    script = "test";
    i += 1;
  } else if (pm === "npm" && (w[i] === "start" || w[i] === "stop" || w[i] === "restart")) {
    script = w[i];
    i += 1;
  } else if ((pm === "pnpm" || pm === "yarn") && w[i] !== undefined && !PM_BUILTINS.has(w[i]!)) {
    script = w[i];
    i += 1;
  } else {
    return null;
  }
  if (!script || script.startsWith("-") || !SAFE_SCRIPT_NAME.test(script)) return null;
  const rest = w.slice(i);
  if (rest[0] === "--") rest.shift();
  return { pm, script, args: rest };
}

/** Script names a gate command refers to (for the script check's `gateScriptNames`). */
export function gateScriptNamesOf(cmds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const c of cmds) {
    const inv = parseScriptInvocation(c);
    if (inv) out.add(inv.script);
    // Compound commands: any `run <name>` / `pnpm <name>` word pair is a referenced script.
    for (const m of c.matchAll(
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9][A-Za-z0-9:._-]*)/g,
    )) {
      if (!PM_BUILTINS.has(m[1]!) && m[1] !== "run") out.add(m[1]!);
    }
    // `run-s a b` / `run-p` / `npm-run-all` words (patterns like `test:*` included) and
    // concurrently's `npm:x`.
    for (const seg of c.split(/&&|\|\||[;|&()`\n]/)) {
      const w = seg
        .trim()
        .split(/[ \t]+/)
        .map((t) => t.replace(/^["']+|["']+$/g, ""));
      const at = w.findIndex((t) => /^(?:.*\/)?(?:run-s|run-p|npm-run-all)$/.test(t));
      if (at !== -1) for (const t of w.slice(at + 1)) if (t && !t.startsWith("-")) out.add(t);
      for (const t of w) {
        const m = /^npm:(.+)$/.exec(t);
        if (m) out.add(m[1]!);
      }
    }
  }
  return [...out];
}

/** POSIX single-quote a word for `bash -c`. */
function shq(s: string): string {
  return /^[A-Za-z0-9_./:=@,+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export interface ResolvedGateCommand {
  /** The command the runner executes. */
  readonly command: string;
  /**
   * Where the command's behaviour was read from, for the evidence:
   *  - `registered`: not a package script call; runs exactly as registered.
   *  - `base`: the script, its hooks and every script it runs are identical at base and
   *    head; runs as registered.
   *  - `base-pinned`: the delivery changed or removed the script, ADDED or changed one
   *    of its `pre`/`post` hooks, or changed a script it runs; the BASE commit's
   *    expansion runs instead (the agent cannot redirect the gate).
   *  - `head`: the script is new in this delivery (no base version); runs as registered.
   *  - `unresolved`: the base commit or its package.json could not be read; runs as
   *    registered (the integrity scan flags the same condition).
   */
  readonly source: "registered" | "base" | "base-pinned" | "head" | "unresolved";
  readonly note: string;
}

/**
 * The BASE commit's expansion of `name`: its `pre`/`post` hooks around its body, with a
 * body that is itself one script call (`test: npm run unit`) inlined from base too, so
 * the whole simple chain runs as base has it. A compound body (`run-s a b`,
 * `npm run a && npm run b`) runs as written, and the scripts IT runs are not pinned:
 * they are returned in `reached` for the caller to report. `covered` is every name the
 * expansion decided (inlined, or a hook it ran or left out).
 */
function expandFromBase(
  base: Readonly<Record<string, string>>,
  name: string,
  args: readonly string[],
  universe: readonly string[],
  covered: Set<string>,
  reached: Set<string>,
  depth = 0,
): string {
  covered.add(name);
  covered.add(`pre${name}`);
  covered.add(`post${name}`);
  const body = base[name] ?? "";
  const inv = depth < 8 ? parseScriptInvocation(body) : null;
  let inner: string;
  if (inv && base[inv.script] !== undefined && !covered.has(inv.script)) {
    inner = `( ${expandFromBase(base, inv.script, [...inv.args, ...args], universe, covered, reached, depth + 1)} )`;
  } else {
    const a = args.map(shq).join(" ");
    inner = `( ${body}${a ? ` ${a}` : ""} )`;
    for (const r of scriptRefs(body, universe)) reached.add(r);
  }
  const parts: string[] = [];
  const pre = base[`pre${name}`];
  const post = base[`post${name}`];
  for (const hook of [pre, post]) {
    if (hook !== undefined) for (const r of scriptRefs(hook, universe)) reached.add(r);
  }
  if (pre !== undefined) parts.push(`( ${pre} )`);
  parts.push(inner);
  if (post !== undefined) parts.push(`( ${post} )`);
  return parts.join(" && ");
}

/**
 * Resolve a gate command against the BASE commit's package.json. `basePkg`/`headPkg`
 * are the root package.json texts (null where absent); `baseRev` names the commit in
 * the note. The script counts as changed when anything a run of it reaches differs
 * between base and head: its body, a `pre<name>`/`post<name>` hook (an ADDED hook
 * included — npm would run it), or a script its body runs (`test: npm run unit`). Then
 * the base expansion runs instead ({@link expandFromBase}) with the worktree's
 * `node_modules/.bin` on PATH (what the package manager would add). A changed script
 * reached only through a compound body cannot be pinned this way; the note names it and
 * the integrity scan flags it.
 */
export function resolveGateCommand(
  cmd: string,
  basePkg: string | null,
  headPkg: string | null,
  baseRev: string,
): ResolvedGateCommand {
  const inv = parseScriptInvocation(cmd);
  if (!inv) return { command: cmd, source: "registered", note: "runs as registered" };
  const short = baseRev.slice(0, 12);
  if (basePkg === null && headPkg === null) {
    return { command: cmd, source: "registered", note: "no package.json at base or head" };
  }
  const base = scriptsOf(basePkg);
  const head = headPkg === null ? {} : scriptsOf(headPkg);
  if (basePkg !== null && base === null) {
    return {
      command: cmd,
      source: "unresolved",
      note: `package.json at base ${short} is not valid JSON; ran the delivery's script`,
    };
  }
  const baseBody = base?.[inv.script];
  if (base === null || baseBody === undefined) {
    return {
      command: cmd,
      source: "head",
      note: `script "${inv.script}" is new in this delivery (none at base ${short})`,
    };
  }
  // An unparseable head package.json: nothing at head can be trusted, so pin.
  const headScripts = head ?? {};
  const changes =
    head === null
      ? [{ script: inv.script, change: "changed" as const }]
      : closureChanges(base, headScripts, [inv.script]);
  if (changes.length === 0) {
    return {
      command: cmd,
      source: "base",
      note: `script "${inv.script}" read from base ${short} (it and every script it runs are unchanged in the delivery)`,
    };
  }
  const universe = [...new Set([...Object.keys(base), ...Object.keys(headScripts)])];
  const covered = new Set<string>();
  const reached = new Set<string>();
  const expansion = expandFromBase(base, inv.script, inv.args, universe, covered, reached);
  const what = changes.map((c) => `${c.change} script "${c.script}"`).join(", ");
  // What still runs from HEAD: the scripts a compound base body calls, as head has them.
  const live = new Set(scriptClosure(headScripts, [...reached], universe));
  const unpinned = changes
    .filter((c) => live.has(c.script) && !covered.has(c.script))
    .map((c) => c.script);
  const command = `PATH="$PWD/node_modules/.bin:$PATH"; ${expansion}`;
  return {
    command,
    source: "base-pinned",
    note:
      `the delivery ${what}; ran the base ${short} "${inv.script}" instead` +
      (unpinned.length
        ? ` (${unpinned.join(", ")} still ran as the delivery has ${unpinned.length === 1 ? "it" : "them"}: reached through a compound script; the integrity row flags it)`
        : ""),
  };
}
