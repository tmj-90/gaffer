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
 *    `typecheck`, … and any script the gate commands name);
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
  readonly change: "changed" | "removed";
}

export interface ConfigChange {
  readonly path: string;
  readonly change: "modified" | "deleted" | "renamed";
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
    String.raw`^test_[^/]*\.py$`,
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
}

const MARKER_RULES: readonly MarkerRule[] = [
  {
    // describe.skip / it.only / test.todo / it.skipIf(…) / test.fixme (playwright)
    applies: JS_TEST,
    re: /\b(describe|it|test|context|suite|specify|bench)\s*\.\s*(skip|only|todo|fixme|skipIf)\b/,
    name: (m) => `${m[1]}.${m[2]}`,
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
  { applies: PY_TEST, re: /\bpytest\.(skip|xfail)\s*\(/, name: (m) => `pytest.${m[1]}()` },
  {
    applies: PY_TEST,
    re: /@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b/,
    name: (m) => `@unittest.${m[1]}`,
  },
  { applies: PY_TEST, re: /\.skipTest\s*\(/, name: () => "skipTest()" },
  { applies: GO_TEST, re: /\b[tb]\.(Skip|Skipf|SkipNow)\s*\(/, name: (m) => `t.${m[1]}` },
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

/**
 * A comment line: a marker inside a comment skips nothing. `#[` stays code (a Rust
 * attribute); a Python/Ruby `#` comment does not.
 */
function isCommentLine(s: string): boolean {
  const t = s.trimStart();
  return (
    t.startsWith("//") ||
    t.startsWith("/*") ||
    t.startsWith("*") ||
    (t.startsWith("#") && !t.startsWith("#["))
  );
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
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = unquoteGitPath(raw.slice(4).replace(/\t.*$/, ""));
      path = target === "/dev/null" ? null : target.replace(/^b\//, "");
      rules = path ? MARKER_RULES.filter((r) => r.applies(path!, x)) : [];
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
      const body = raw.slice(1);
      if (rules.length > 0 && !isCommentLine(body)) {
        for (const rule of rules) {
          const m = rule.re.exec(body);
          if (m) {
            out.push({ path, marker: rule.name(m), line: lineNo });
            break;
          }
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

/**
 * Gate-relevant scripts a delivery CHANGED or REMOVED in one package.json. Adding a
 * script is not flagged (it cannot weaken an existing gate). `gateScriptNames` adds the
 * scripts the registered gate commands name (e.g. `pnpm run verify:fast`).
 * An unparseable base or head file is reported as a change to `scripts` (fail toward
 * a human).
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
  const named = new Set(gateScriptNames);
  const out: ScriptChange[] = [];
  for (const [name, body] of Object.entries(base)) {
    if (!GATE_SCRIPT_RE.test(name) && !named.has(name)) continue;
    if (!(name in head)) out.push({ file, script: name, change: "removed" });
    else if (head[name]!.trim() !== body.trim())
      out.push({ file, script: name, change: "changed" });
  }
  return out;
}

/** Test-runner config: a change here can exclude tests without touching a test file. */
const TEST_CONFIG_RE =
  /(?:^|\/)(?:(?:vitest|jest|playwright|cypress|karma|ava|wdio|nyc)\.config\.[^/]+|vitest\.workspace\.[^/]+|karma\.conf\.[^/]+|jest\.setup\.[^/]+|\.mocharc(?:\.[^/]+)?|\.nycrc(?:\.[^/]+)?|pytest\.ini|conftest\.py|tox\.ini|\.coveragerc|phpunit\.xml(?:\.dist)?|\.rspec)$/i;

export function isTestConfigPath(p: string): boolean {
  return TEST_CONFIG_RE.test(p);
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
    } else if (s === "M" || s === "T") {
      if (isTestConfigPath(e.path)) configs.push({ path: e.path, change: "modified" });
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
  for (const c of f.configs) out.push(`${c.change} test config ${c.path}`);
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
      `${f.scripts.some((s) => s.change === "removed") ? "changed/removed" : "changed"} gate script${
        f.scripts.length === 1 ? "" : "s"
      } (${list(
        f.scripts.map((s) => `${s.script} in ${s.file}`),
        max,
      )})`,
    );
  }
  if (f.configs.length) {
    parts.push(
      `touched test config (${list(
        f.configs.map((c) => `${c.path} ${c.change}`),
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
export type IntegrityGit = (
  args: readonly string[],
  opts?: { maxBuffer?: number },
) => { status: number | null; stdout: string; truncated?: boolean };

/** Never run a repo-configured diff driver/textconv: the scan reads raw bytes only. */
const SAFE = ["--no-ext-diff", "--no-textconv", "--no-color"] as const;
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
    const patch = git(["diff", "-U0", "-M", ...SAFE, base, head, ...spec], {
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
   *  - `base`: the script at the base commit, identical at head; runs as registered.
   *  - `base-pinned`: the delivery changed or removed the script; the BASE commit's
   *    script body runs instead (the agent cannot redirect the gate).
   *  - `head`: the script is new in this delivery (no base version); runs as registered.
   *  - `unresolved`: the base commit or its package.json could not be read; runs as
   *    registered (the integrity scan flags the same condition).
   */
  readonly source: "registered" | "base" | "base-pinned" | "head" | "unresolved";
  readonly note: string;
}

/**
 * Resolve a gate command against the BASE commit's package.json. `basePkg`/`headPkg`
 * are the root package.json texts (null where absent); `baseRev` names the commit in
 * the note. When the delivery changed the script, the base body runs with the
 * worktree's `node_modules/.bin` on PATH (what the package manager would add), wrapped
 * by the base's `pre<name>`/`post<name>` hooks when they exist.
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
  if (baseBody === undefined) {
    return {
      command: cmd,
      source: "head",
      note: `script "${inv.script}" is new in this delivery (none at base ${short})`,
    };
  }
  const headBody = head?.[inv.script];
  if (headBody !== undefined && headBody.trim() === baseBody.trim()) {
    return {
      command: cmd,
      source: "base",
      note: `script "${inv.script}" read from base ${short} (unchanged in the delivery)`,
    };
  }
  const args = inv.args.map(shq).join(" ");
  const parts: string[] = [];
  const pre = base?.[`pre${inv.script}`];
  const post = base?.[`post${inv.script}`];
  if (pre !== undefined) parts.push(`( ${pre} )`);
  parts.push(`( ${baseBody}${args ? ` ${args}` : ""} )`);
  if (post !== undefined) parts.push(`( ${post} )`);
  const command = `PATH="$PWD/node_modules/.bin:$PATH"; ${parts.join(" && ")}`;
  return {
    command,
    source: "base-pinned",
    note: `the delivery ${headBody === undefined ? "removed" : "changed"} script "${inv.script}"; ran the base ${short} script instead`,
  };
}
