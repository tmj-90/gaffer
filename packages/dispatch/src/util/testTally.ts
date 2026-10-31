/**
 * REVIEW PACKET: read test counts out of text, deterministically (no model call).
 *
 * Two readers over the same grammar:
 *  - {@link parseRunnerTally} reads what a test runner printed (vitest, jest, pytest,
 *    go test, cargo) — the runner records those lines verbatim on its DoD evidence
 *    (`---DOD-TALLY tests@<repo>---` blocks, see runner/lib/dod.sh).
 *  - {@link parseTestClaims} reads what the delivery agent SAID about its tests
 *    ("all 42 tests pass", "12/12 tests passing", a pasted vitest line).
 *
 * node --test (`# tests N` / `# pass N` lines) is read too: it is the runner a
 * plain Node repo uses.
 *
 * {@link compareTestClaims} puts the two side by side and reports only a real
 * disagreement. It never guesses: a text it cannot read yields nothing, and a claim
 * with no runner count to compare against is not flagged.
 */

/** The counts one runner summary (or a sum of them) reports. */
export interface TestTally {
  /** The framework(s) the counts were read from, e.g. `vitest` or `vitest+pytest`. */
  framework: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** The summary lines the counts came from (ANSI-stripped, bounded). */
  lines: string[];
}

/** One thing the agent said about its tests. */
export interface TestClaim {
  /** The number of passing tests claimed, or null for a bare "all tests pass". */
  passed: number | null;
  /** True when the claim says every test passes ("all", "N/N", "0 failed"). */
  all: boolean;
  /** The words the claim was read from (one line, bounded). */
  excerpt: string;
}

/** A claim that disagrees with what the runner saw. */
export interface TestDisagreement {
  claimed: string;
  runner_saw: string;
  /** "the summary says N, the runner saw M" — ready to show. */
  message: string;
  excerpt: string;
}

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
const MAX_LINE = 300;
const MAX_LINES = 12;

function clean(line: string): string {
  return line.replace(ANSI_RE, "").replace(/\r/g, "").trim().slice(0, MAX_LINE);
}

/** Read `N word` pairs ("41 passed", "1 failed", "2 skipped") from a fragment. */
function countWords(fragment: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of fragment.matchAll(/(\d+)\s+([a-z]+)/gi)) {
    const word = m[2]!.toLowerCase();
    out.set(word, (out.get(word) ?? 0) + Number(m[1]));
  }
  return out;
}

interface Partial {
  framework: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number | null;
  line: string;
}

const pick = (m: Map<string, number>, ...words: string[]): number =>
  words.reduce((n, w) => n + (m.get(w) ?? 0), 0);

/** One summary line, read; null when the line is not a summary any reader knows. */
function readSummaryLine(raw: string): Partial | null {
  const line = clean(raw);
  if (!line) return null;
  // vitest: "Tests  1 failed | 41 passed (42)" (not "Test Files …").
  let m = line.match(/^Tests\s+(.+?)\s+\((\d+)\)$/);
  if (m && /\d+\s+(passed|failed|skipped|todo)/.test(m[1]!) && !/^Tests:/.test(line)) {
    const c = countWords(m[1]!);
    return {
      framework: "vitest",
      passed: pick(c, "passed"),
      failed: pick(c, "failed"),
      skipped: pick(c, "skipped", "todo"),
      total: Number(m[2]),
      line,
    };
  }
  // jest: "Tests:       1 failed, 2 skipped, 41 passed, 44 total".
  m = line.match(/^Tests:\s+(.+)$/);
  if (m && /\d+\s+total/.test(m[1]!)) {
    const c = countWords(m[1]!);
    return {
      framework: "jest",
      passed: pick(c, "passed"),
      failed: pick(c, "failed"),
      skipped: pick(c, "skipped", "todo", "pending"),
      total: pick(c, "total"),
      line,
    };
  }
  // cargo: "test result: ok. 42 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; …".
  m = line.match(/^test result:\s+\w+\.\s+(.+)$/);
  if (m) {
    const c = countWords(m[1]!);
    const passed = pick(c, "passed");
    const failed = pick(c, "failed");
    const skipped = pick(c, "ignored");
    return { framework: "cargo", passed, failed, skipped, total: passed + failed + skipped, line };
  }
  // go test -v, as the runner tallies it: "gotest-tally: pass=12 fail=0 skip=1".
  m = line.match(/^gotest-tally:\s+pass=(\d+)\s+fail=(\d+)\s+skip=(\d+)$/);
  if (m) {
    const passed = Number(m[1]);
    const failed = Number(m[2]);
    const skipped = Number(m[3]);
    return { framework: "go", passed, failed, skipped, total: passed + failed + skipped, line };
  }
  // pytest: "===== 1 failed, 41 passed, 2 skipped in 0.12s =====" or "41 passed in 0.12s".
  m = line.match(/^=*\s*((?:\d+\s+[a-z]+(?:,\s*)?)+)\s+in\s+[\d.]+s(?:\s*\([^)]*\))?\s*=*$/i);
  if (m && /\d+\s+(passed|failed)/i.test(m[1]!)) {
    const c = countWords(m[1]!);
    const passed = pick(c, "passed", "xpassed");
    const failed = pick(c, "failed", "error", "errors");
    const skipped = pick(c, "skipped", "xfailed", "deselected");
    return { framework: "pytest", passed, failed, skipped, total: passed + failed + skipped, line };
  }
  return null;
}

/**
 * The counts a runner's own output reports, summed across every summary line found
 * (a monorepo prints one vitest line per package; cargo one per test binary). Raw
 * `--- PASS: / --- FAIL:` lines from `go test -v` count too, top-level tests only,
 * and node --test's per-line counts are grouped into one summary per run.
 * Null when no summary is found — the caller then has no runner count, never zero.
 */
export function parseRunnerTally(text: string): TestTally | null {
  const parts: Partial[] = [];
  let goPass = 0;
  let goFail = 0;
  let goSkip = 0;
  // node --test prints one count per line ("# tests 3", "# pass 3", …; "ℹ" under the
  // spec reporter); a repeated key starts the next run's group.
  let node: Map<string, number> | null = null;
  const nodeLines: string[] = [];
  const flushNode = () => {
    if (!node) return;
    const k = (w: string) => node!.get(w) ?? 0;
    parts.push({
      framework: "node:test",
      passed: k("pass"),
      failed: k("fail") + k("cancelled"),
      skipped: k("skipped") + k("todo"),
      total: node.has("tests") ? k("tests") : null,
      line: nodeLines.join(" · "),
    });
    node = null;
    nodeLines.length = 0;
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const plain = raw.replace(ANSI_RE, "").replace(/\r/g, "");
    const nm = plain.trim().match(/^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)$/);
    if (nm) {
      if (node && node.has(nm[1]!)) flushNode();
      node ??= new Map();
      node.set(nm[1]!, Number(nm[2]));
      nodeLines.push(`${nm[1]} ${nm[2]}`);
      continue;
    }
    const go = plain.match(/^--- (PASS|FAIL|SKIP): \S/);
    if (go) {
      if (go[1] === "PASS") goPass += 1;
      else if (go[1] === "FAIL") goFail += 1;
      else goSkip += 1;
      continue;
    }
    const p = readSummaryLine(raw);
    if (p) parts.push(p);
  }
  flushNode();
  if (goPass + goFail + goSkip > 0) {
    parts.push({
      framework: "go",
      passed: goPass,
      failed: goFail,
      skipped: goSkip,
      total: goPass + goFail + goSkip,
      line: `go test -v: ${goPass} passed, ${goFail} failed, ${goSkip} skipped`,
    });
  }
  if (parts.length === 0) return null;
  const frameworks = [...new Set(parts.map((p) => p.framework))];
  const sum = (k: "passed" | "failed" | "skipped") => parts.reduce((n, p) => n + p[k], 0);
  return {
    framework: frameworks.join("+"),
    passed: sum("passed"),
    failed: sum("failed"),
    skipped: sum("skipped"),
    total: parts.reduce((n, p) => n + (p.total ?? p.passed + p.failed + p.skipped), 0),
    lines: parts.map((p) => p.line).slice(-MAX_LINES),
  };
}

/**
 * A tests word scoped to part of the suite ("3 new tests", "30 unit tests"). A count
 * so qualified speaks for that part, not for the whole run, so it is never compared
 * with the runner's tally.
 */
const QUALIFIER =
  "(?:unit|integration|e2e|end-to-end|new|existing|regression|black-box|smoke|added|focused)";
const TEST_WORD = `(?:(${QUALIFIER})[\\s-]+)?tests?`;
const PASS_WORD = "(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)";
/** "12/12 tests pass", "all 12 of 12 tests passing". */
const RATIO_RE = new RegExp(
  `\\b(all\\s+)?(\\d+)\\s*(?:/|of|out of)\\s*(\\d+)\\s+${TEST_WORD}\\s+(?:are\\s+|now\\s+)?${PASS_WORD}`,
  "gi",
);
/** "all 42 tests pass", "42 tests passing", "42 tests are green". */
const COUNT_RE = new RegExp(
  `\\b(all\\s+)?(\\d+)\\s+${TEST_WORD}\\s+(?:are\\s+|now\\s+|all\\s+)?${PASS_WORD}`,
  "gi",
);
/** "all tests pass", "all the tests passed", "tests all pass". */
const ALL_RE = new RegExp(
  `\\ball\\s+(?:the\\s+|of\\s+the\\s+)?${TEST_WORD}\\s+(?:are\\s+|now\\s+)?${PASS_WORD}|\\btests\\s+all\\s+${PASS_WORD}`,
  "gi",
);
/** "Added 3 tests pass", "wrote 2 tests passing": the count is of tests just written. */
const WROTE_BEFORE = /\b(?:added|adds|adding|wrote|writes|new)\s+(?:all\s+)?$/i;
/** A line that names one test file speaks for that file ("test/lock.test.ts: 3 tests pass"). */
const TEST_FILE_RE =
  /(?:^|[\s/(:'"`])[\w.-]*(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.(?:go|py)|_spec\.rb)\b|(?:^|[\s/(:'"`])test_[\w-]+\.py\b/i;

/** Where the agent's words were recorded. */
export interface ClaimSource {
  text: string;
  /**
   * True for a row recorded against one acceptance criterion (`ac_id` set). Its
   * counts speak for that criterion's tests, so only an explicit "all N" in it is
   * read as a claim about the whole suite.
   */
  acScoped?: boolean;
}

/**
 * What the agent's words claim about the WHOLE test suite. A count is read as such a
 * claim only when it speaks for the whole run:
 *  - "all N tests pass", or "N/N" / "N of N" (every test, counted);
 *  - a runner summary line the agent pasted (still the agent's word, not the runner's);
 *  - a bare "N tests pass" in a row that is not about one criterion and names no
 *    single test file.
 * Never read: counts qualified as part of the suite ("3 new tests", "30 unit tests",
 * "Added 3 tests"), a partial "1 of 2 tests passing", and in a criterion's row
 * (`acScoped`) anything without "all". One claim per distinct passing count; a bare
 * "all tests pass" stands alone only when no counted claim was found, and otherwise
 * makes the counted claims "all" claims.
 */
export function parseTestClaims(text: string, scope: { acScoped?: boolean } = {}): TestClaim[] {
  return parseTestClaimsFrom([{ text, acScoped: scope.acScoped === true }]);
}

/** {@link parseTestClaims} over several recorded rows, each with its own scope. */
export function parseTestClaimsFrom(sources: readonly ClaimSource[]): TestClaim[] {
  const out: TestClaim[] = [];
  const seen = new Set<string>();
  const add = (c: TestClaim) => {
    const key = `${c.passed}|${c.all}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const src of sources) {
    const acScoped = Boolean(src.acScoped);
    for (const raw of String(src.text || "").split(/\r?\n/)) {
      const line = clean(raw);
      if (!line) continue;
      const oneFile = TEST_FILE_RE.test(line);
      const wrote = (index: number) => WROTE_BEFORE.test(line.slice(0, index));
      // Matched a count at all (read or deliberately dropped): the line is about counts.
      let matched = false;
      for (const m of line.matchAll(RATIO_RE)) {
        matched = true;
        const said = Boolean(m[1]);
        const a = Number(m[2]);
        const b = Number(m[3]);
        if (a !== b || m[4] || wrote(m.index ?? 0)) continue;
        if ((acScoped || oneFile) && !said) continue;
        add({ passed: a, all: true, excerpt: line });
      }
      if (!matched) {
        for (const m of line.matchAll(COUNT_RE)) {
          matched = true;
          const said = Boolean(m[1]);
          if (m[3] || wrote(m.index ?? 0)) continue;
          if ((acScoped || oneFile) && !said) continue;
          add({ passed: Number(m[2]), all: said, excerpt: line });
        }
      }
      if (!matched) {
        const pasted = readSummaryLine(line);
        if (pasted) {
          matched = true;
          if (!acScoped && !oneFile)
            add({ passed: pasted.passed, all: pasted.failed === 0, excerpt: line });
        }
      }
      if (!matched) {
        for (const m of line.matchAll(ALL_RE)) {
          if (m[1]) continue;
          add({ passed: null, all: true, excerpt: line });
        }
      }
    }
  }
  // A bare "all pass" says less than a counted claim, so a counted claim takes its
  // place, but its "all" carries over: "All tests pass" beside "40 tests passing"
  // still says every test passed, and must not hide a failure the runner saw.
  const counted = out.filter((c) => c.passed !== null);
  if (counted.length === 0) return out;
  if (counted.length === out.length) return counted;
  const merged: TestClaim[] = [];
  const kept = new Set<number>();
  for (const c of counted) {
    if (kept.has(c.passed!)) continue;
    kept.add(c.passed!);
    const all = counted.find((x) => x.passed === c.passed && x.all);
    merged.push(all ?? { ...c, all: true });
  }
  return merged;
}

const n = (k: number, word: string) => `${k} ${word}`;

/**
 * Compare the agent's claims with the runner's tally. A claimed passing count that
 * differs from the runner's passing count disagrees; so does "all pass" when the
 * runner saw a failure (or the test gate itself failed). No runner tally and a gate
 * that did not fail ⇒ nothing to compare, nothing reported.
 */
export function compareTestClaims(
  claims: readonly TestClaim[],
  tally: TestTally | null,
  opts: { testsGateFailed?: boolean } = {},
): TestDisagreement[] {
  const out: TestDisagreement[] = [];
  const saw = tally
    ? tally.failed > 0
      ? `${n(tally.passed, "passing")} and ${n(tally.failed, "failing")}`
      : n(tally.passed, "passing")
    : null;
  for (const c of claims) {
    if (c.passed !== null && tally && c.passed !== tally.passed) {
      out.push({
        claimed: String(c.passed),
        runner_saw: String(tally.passed),
        message: `The summary says ${c.passed}, the runner saw ${tally.passed}${
          tally.failed > 0 ? ` (${n(tally.failed, "failing")})` : ""
        }.`,
        excerpt: c.excerpt,
      });
      continue;
    }
    if (c.all && ((tally && tally.failed > 0) || opts.testsGateFailed)) {
      const what = saw ?? "the test gate fail";
      out.push({
        claimed: c.passed === null ? "all pass" : `all ${c.passed} pass`,
        runner_saw: saw ?? "test gate failed",
        message: `The summary says all tests pass, the runner saw ${what}.`,
        excerpt: c.excerpt,
      });
    }
  }
  return out;
}
