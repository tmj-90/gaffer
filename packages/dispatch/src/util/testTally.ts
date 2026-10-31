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
 * `--- PASS: / --- FAIL:` lines from `go test -v` count too, top-level tests only.
 * Null when no summary is found — the caller then has no runner count, never zero.
 */
export function parseRunnerTally(text: string): TestTally | null {
  const parts: Partial[] = [];
  let goPass = 0;
  let goFail = 0;
  let goSkip = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const plain = raw.replace(ANSI_RE, "").replace(/\r/g, "");
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

const TEST_WORD = "(?:unit\\s+|integration\\s+|e2e\\s+|end-to-end\\s+|new\\s+|existing\\s+)?tests?";
const PASS_WORD = "(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)";
/** "12/12 tests pass", "12 of 12 tests passing". */
const RATIO_RE = new RegExp(
  `(\\d+)\\s*(?:/|of|out of)\\s*(\\d+)\\s+${TEST_WORD}\\s+(?:are\\s+|now\\s+)?${PASS_WORD}`,
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
  "i",
);

/**
 * What the agent's words claim about the tests. Reads plain prose and any runner
 * summary the agent pasted (a pasted line is still the agent's word, not the
 * runner's). One claim per distinct passing count; a bare "all tests pass" is kept
 * only when no counted claim was found.
 */
export function parseTestClaims(text: string): TestClaim[] {
  const out: TestClaim[] = [];
  const seen = new Set<string>();
  const add = (c: TestClaim) => {
    const key = `${c.passed}|${c.all}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = clean(raw);
    if (!line) continue;
    let counted = false;
    for (const m of line.matchAll(RATIO_RE)) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      add({ passed: a, all: a === b, excerpt: line });
      counted = true;
    }
    if (!counted) {
      for (const m of line.matchAll(COUNT_RE)) {
        add({ passed: Number(m[2]), all: Boolean(m[1]), excerpt: line });
        counted = true;
      }
    }
    if (!counted) {
      const pasted = readSummaryLine(line);
      if (pasted) {
        add({ passed: pasted.passed, all: pasted.failed === 0, excerpt: line });
        counted = true;
      }
    }
    if (!counted && ALL_RE.test(line)) add({ passed: null, all: true, excerpt: line });
  }
  // A bare "all pass" says less than a counted claim; keep it only when alone.
  return out.some((c) => c.passed !== null) ? out.filter((c) => c.passed !== null) : out;
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
