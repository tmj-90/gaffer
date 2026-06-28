import { relative } from "node:path";

import {
  applyScanFinding,
  finalizeScan,
  isTestFile,
  repoCandidates,
  safeRead,
  shouldSkipForReadyTickets,
  walkFiles,
  type IdleScanOutcome,
} from "./idleScans.js";
import type { IdleLoopDeps } from "./idleLoop.js";
import {
  resolveMinDeliveredTickets,
  type IdleLoopMode,
  type RepoConfig,
} from "../config/schema.js";
import { oracleFindingKey, summariseOracleFindings, type Oracle } from "./oracles/index.js";

const LOOP = "security_hotspot";

/**
 * The three security LENSES this loop applies (audit item A4), each mirroring a
 * `security-*` review skill so a deepening here stays aligned with the skill an
 * implementer would later use:
 *
 *  - `secret_handling`   → `security-secret-handling` — hardcoded credentials.
 *  - `input_validation`  → `security-input-validation` — injection / unsafe sinks.
 *  - `authz`             → `security-authz` — disabled or missing access controls.
 *
 * Running distinct lenses (rather than one undifferentiated grep) keeps each
 * finding attributable to a specific review discipline and lets the summary
 * group by lens.
 */
export type SecurityLens = "secret_handling" | "input_validation" | "authz";

/** The skill each lens corresponds to — surfaced in the drafted ticket. */
export const LENS_SKILL: Record<SecurityLens, string> = {
  secret_handling: "security-secret-handling",
  input_validation: "security-input-validation",
  authz: "security-authz",
};

/**
 * A single security hotspot found in source. Carries the file + line (the
 * location), the `lens` it was found through, the `risk` (why it matters and how
 * to remediate), and a redacted `snippet` for context. Secret values are never
 * copied into the snippet.
 */
export interface SecurityHotspotFinding {
  file: string;
  line: number;
  lens: SecurityLens;
  kind: "secret" | "injection" | "unsafe_api" | "authz_gap";
  /** Why this line is a risk, plus the remediation direction. */
  risk: string;
  /** Redacted single-line context (secret values masked). */
  snippet: string;
}

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|go|rb|java|php)$/i;

/** Source files worth scanning: code files, excluding test/spec files (noisy fixtures). */
export function isSecurityScanFile(name: string): boolean {
  return SOURCE_FILE_RE.test(name) && !isTestFile(name);
}

// ── Detectors ───────────────────────────────────────────────────────────────
// Best-effort, line-based heuristics (no AST). Each detector is intentionally
// conservative to keep the signal-to-noise ratio high; findings are advisory.

const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/;
const SECRET_ASSIGN_RE =
  /\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*['"`]([^'"`]{8,})['"`]/i;
/** Values that look like placeholders / env reads rather than real secrets. */
const SECRET_PLACEHOLDER_RE =
  /\$\{|\bprocess\.env\b|^<|>$|\b(?:example|sample|dummy|placeholder|redacted|changeme|change-me|your[_-]|todo|xxx+|test|fake|none|null)\b/i;

/** SQL keyword on a line that also concatenates/interpolates a variable. */
const SQL_INJECTION_RE =
  /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WHERE|FROM)\b[\s\S]*?(?:\$\{|`\s*\+|['"]\s*\+|\+\s*['"`])/i;
/** Raw HTML sinks — XSS surface when fed unsanitised input. */
const DANGEROUS_HTML_RE =
  /dangerouslySetInnerHTML|\.(?:inner|outer)HTML\s*=|insertAdjacentHTML\s*\(/;
/** Dynamic code / command execution. */
const UNSAFE_API_RE = /\beval\s*\(|\bnew\s+Function\s*\(|\bexec(?:Sync)?\s*\(|\bchild_process\b/;
/** Explicitly disabled security controls (TLS verification, CSRF, auth). */
const AUTHZ_GAP_RE =
  /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|(?:csrf|csurf)\s*:\s*false|\b(?:auth|authentication|authorization|authrequired|requireauth|secure|verify)\s*:\s*false/i;

function looksLikeSecret(line: string): boolean {
  if (AWS_KEY_RE.test(line) || PRIVATE_KEY_RE.test(line)) return true;
  const match = SECRET_ASSIGN_RE.exec(line);
  if (!match) return false;
  const value = match[1]!;
  return !SECRET_PLACEHOLDER_RE.test(value);
}

interface Detector {
  lens: SecurityLens;
  kind: SecurityHotspotFinding["kind"];
  match: (line: string) => boolean;
  risk: string;
  /**
   * Lens-specific skeptic. Returns true to REFUTE the candidate (treat it as a
   * likely false positive). Default-refute: a candidate only survives if this
   * returns false, so each detector states what would make the match harmless.
   * Optional — when absent only the shared {@link isLikelyFalsePositive} runs.
   */
  refute?: (line: string) => boolean;
}

const DETECTORS: readonly Detector[] = [
  {
    lens: "secret_handling",
    kind: "secret",
    match: looksLikeSecret,
    // An AWS key / PEM block / long literal that already passed the placeholder
    // filter is hard to explain away, so secret_handling adds no extra refuter
    // beyond the shared comment/example guard.
    risk:
      "Hardcoded credential in source — secrets leak through VCS history and grant standing access. " +
      "Move it to an environment variable or a secret manager and rotate the exposed value.",
  },
  {
    lens: "input_validation",
    kind: "injection",
    match: (l) => SQL_INJECTION_RE.test(l),
    // Refute when the only interpolated value is a constant/literal, not a
    // variable — a fully-literal query is not an injection vector.
    refute: (l) => /\$\{[^}]*['"`]/.test(l) && !/\$\{[^}]*\b[a-z_]\w*\b/i.test(l),
    risk:
      "Variable concatenated into a SQL statement enables SQL injection. " +
      "Use parameterised queries / prepared statements instead of string building.",
  },
  {
    lens: "input_validation",
    kind: "injection",
    match: (l) => DANGEROUS_HTML_RE.test(l),
    // Refute when the assigned value is an empty/whitespace clear, a common safe
    // idiom (`el.innerHTML = ""`) rather than an unsanitised write.
    refute: (l) => /\.(?:inner|outer)HTML\s*=\s*(['"`])\s*\1\s*;?\s*$/.test(l),
    risk:
      "Raw HTML sink (innerHTML / dangerouslySetInnerHTML) can introduce XSS when given unsanitised input. " +
      "Sanitise the value or use safe DOM/text APIs.",
  },
  {
    lens: "input_validation",
    kind: "unsafe_api",
    match: (l) => UNSAFE_API_RE.test(l),
    // Refute a regex/parse `.exec(` — a RegExp.exec call is not code execution.
    // SCOPED to the matched construct: only dismiss the line when its unsafe-API
    // hit really IS the benign `.exec(` and there is NO OTHER unsafe construct on
    // the same line. Otherwise a real `eval(...)` co-located with a `db.exec(...)`
    // would be silently refuted ("line has .exec + no child_process") and a live
    // code-execution sink would slip through unfiled.
    refute: (l) =>
      /\.exec\s*\(/.test(l) &&
      !/\b(?:child_process|cp|shell)\b/.test(l) &&
      !/\beval\s*\(/.test(l) &&
      !/\bnew\s+Function\s*\(/.test(l) &&
      !/\bexecSync\s*\(/.test(l),
    risk:
      "Dynamic code or shell execution (eval / new Function / child_process.exec) can run attacker-controlled input. " +
      "Avoid eval; prefer execFile with an argument array and validated inputs.",
  },
  {
    lens: "authz",
    kind: "authz_gap",
    match: (l) => AUTHZ_GAP_RE.test(l),
    // Refute a `verify: false` that is plainly a *test/mock* config flag rather
    // than a disabled transport/auth control (e.g. `verify: false, // unit only`).
    refute: (l) => /\b(?:mock|stub|fixture|test|spec)\b/i.test(l),
    risk:
      "A security control appears explicitly disabled (TLS verification, CSRF, or auth). " +
      "Re-enable it, or document and scope a vetted exception.",
  },
];

/**
 * Shared first-pass skeptic applied to EVERY candidate before its lens-specific
 * refuter: dismiss matches on commented-out lines and obvious example/doc lines.
 * A commented credential or sink is not live code, so it should not file a
 * ticket. Conservative on purpose — only the clearest non-findings are refuted.
 */
export function isLikelyFalsePositive(line: string): boolean {
  const trimmed = line.trimStart();
  // Whole-line comments (JS/TS //, hash #, block * continuation).
  if (/^(?:\/\/|#|\*|\/\*)/.test(trimmed)) return true;
  return false;
}

/**
 * Adversarial VERIFY pass (audit item A4). Default-refute: a candidate finding
 * survives only when NEITHER the shared {@link isLikelyFalsePositive} guard NOR
 * the detector's lens-specific `refute` skeptic dismisses it. This is the
 * deterministic seam where a per-finding agent skeptic would later plug in; the
 * heuristic version already cuts the loudest false positives (commented code,
 * literal-only queries, regex .exec, test-only flags) before anything is filed.
 */
export function verifySecurityFinding(detector: Detector, line: string): boolean {
  if (isLikelyFalsePositive(line)) return false;
  if (detector.refute?.(line)) return false;
  return true;
}

/**
 * Mask quoted string contents and key-shaped tokens so a drafted ticket / event
 * log never carries a real secret value, then trim to a short context snippet.
 */
function redactSnippet(line: string): string {
  return line
    .replace(/(['"`])(?:\\.|(?!\1).){4,}?\1/g, "$1***$1")
    .replace(AWS_KEY_RE, "AKIA****************")
    .trim()
    .slice(0, 120);
}

/** The detectors belonging to one lens — the lens runs as a distinct pass. */
function detectorsForLens(lens: SecurityLens): readonly Detector[] {
  return DETECTORS.filter((d) => d.lens === lens);
}

/** The three lenses, in the order they are applied (mirrors LENS_SKILL). */
const LENSES: readonly SecurityLens[] = ["secret_handling", "input_validation", "authz"];

/**
 * Scan one file's source for security hotspots through THREE distinct lenses
 * (secret-handling, input-validation, authz — each a `security-*` skill), then
 * pass every candidate through the adversarial {@link verifySecurityFinding}
 * gate (default-refute) so commented code, literal-only queries, regex `.exec`,
 * and test-only flags are dropped before anything is reported.
 *
 * Best-effort line scanning — no parsing — matching the other idle scans' "grep
 * the repo" heuristic. Findings are advisory, not proof.
 */
export function scanSecurityHotspots(source: string, file: string): SecurityHotspotFinding[] {
  const findings: SecurityHotspotFinding[] = [];
  const lines = source.split("\n");

  // Run each lens as its own pass so a finding is attributable to a specific
  // review discipline (and the verify gate is applied per lens/detector).
  for (const lens of LENSES) {
    for (const detector of detectorsForLens(lens)) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!detector.match(line)) continue;
        // Adversarial verify pass — default-refute the candidate before filing.
        if (!verifySecurityFinding(detector, line)) continue;
        const snippet =
          detector.kind === "secret" ? redactSnippet(line) : line.trim().slice(0, 120);
        findings.push({
          file,
          line: i + 1,
          lens,
          kind: detector.kind,
          risk: detector.risk,
          snippet,
        });
      }
    }
  }
  return findings;
}

function summarise(repoName: string, findings: SecurityHotspotFinding[]): string {
  const byLens: Record<SecurityLens, number> = {
    secret_handling: 0,
    input_validation: 0,
    authz: 0,
  };
  for (const f of findings) byLens[f.lens]++;
  const head =
    `Security-hotspot scan of ${repoName} found ${findings.length} potential issue(s) ` +
    `across 3 lenses (each verified by a default-refute skeptic pass before filing): ` +
    `${byLens.secret_handling} via ${LENS_SKILL.secret_handling}, ` +
    `${byLens.input_validation} via ${LENS_SKILL.input_validation}, ` +
    `${byLens.authz} via ${LENS_SKILL.authz}. ` +
    `Heuristic findings — verify each before acting.`;
  const detail = findings
    .slice(0, 15)
    .map(
      (f) =>
        `  - [${LENS_SKILL[f.lens]}] ${f.kind} @ ${f.file}:${f.line} — ${f.risk}\n      ${f.snippet}`,
    )
    .join("\n");
  return `${head}\n${detail}`;
}

const ORACLE_ACCEPTANCE =
  `Each finding is a semgrep result (rule id + file/line). Acceptance criteria: ` +
  `remediate the flagged sink (or document a vetted, scoped exception) and re-run semgrep clean.`;

/**
 * Try the semgrep security oracle for one repo. Returns the apply result when the
 * tool ran, or `null` when semgrep is absent (loop falls back to its three-lens
 * grep+verify path). Logs the path taken either way.
 */
function trySecurityOracle(
  deps: IdleLoopDeps,
  oracle: Oracle,
  mode: IdleLoopMode,
  repo: RepoConfig,
  root: string,
): ReturnType<typeof applyScanFinding> | null {
  const result = oracle.consult(root);
  if (!result.available) {
    deps.events.record("security_hotspot_oracle_unavailable", {
      repoName: repo.name,
      oracle: oracle.id,
      reason: result.reason,
    });
    return null;
  }
  deps.events.record("security_hotspot_scanned", {
    repoName: repo.name,
    findings: result.findings.length,
    path: "oracle",
    oracle: oracle.id,
  });
  if (result.findings.length === 0) return { kind: "deduped" };
  const summary = summariseOracleFindings(repo.name, "semgrep", result.findings, ORACLE_ACCEPTANCE);
  return applyScanFinding(
    deps,
    LOOP,
    mode,
    repo,
    `Security hotspots: ${repo.name}`,
    summary,
    oracleFindingKey(oracle.id, result.findings),
  );
}

/**
 * Idle security-hotspot loop. PREFERS the semgrep oracle (precise, rule-based
 * findings) when one is wired and semgrep is installed; otherwise falls back to
 * walking each in-scope repo's source files through the three-lens grep+verify
 * heuristic. Either way it creates a DRAFT ticket per repo carrying each finding's
 * file/location and why it's a risk, and logs the path taken (`oracle` vs
 * `heuristic`). Observation only — never edits code. Dependency-level risks
 * (vulnerable/outdated packages) are owned by the dependency-hygiene loop.
 */
export function runIdleSecurityHotspotLoop(deps: IdleLoopDeps): IdleScanOutcome {
  deps.events.record("loop_started", { loop: LOOP });
  if (shouldSkipForReadyTickets(deps, LOOP)) return { status: "skipped_tickets_ready" };

  const { repos: allow, mode, min_delivered_tickets } = deps.config.loops.idle_security_hotspot;
  const minDelivered = resolveMinDeliveredTickets(deps.config.loops, min_delivered_tickets);
  const candidates = repoCandidates(deps, allow, { loop: LOOP, minDelivered });
  if (candidates.length === 0) {
    deps.events.record("loop_finished", { loop: LOOP, result: "no_repos" });
    return { status: "no_repos" };
  }

  const oracle = deps.oracles?.security;
  const results = [];
  for (const repo of candidates) {
    const root = deps.repoRegistry.absolutePath(repo);

    // Oracle-first: a wired semgrep oracle whose tool is installed yields precise
    // rule-based findings. Unavailable → null → fall back to the three lenses.
    if (oracle) {
      const oracleResult = trySecurityOracle(deps, oracle, mode, repo, root);
      if (oracleResult !== null) {
        results.push(oracleResult);
        continue;
      }
    }

    const files = walkFiles(root, isSecurityScanFile);
    const findings: SecurityHotspotFinding[] = [];
    for (const path of files) {
      findings.push(...scanSecurityHotspots(safeRead(path), relative(root, path)));
    }
    deps.events.record("security_hotspot_scanned", {
      repoName: repo.name,
      findings: findings.length,
      path: "heuristic",
    });
    if (findings.length === 0) continue;
    results.push(
      applyScanFinding(
        deps,
        LOOP,
        mode,
        repo,
        `Security hotspots: ${repo.name}`,
        summarise(repo.name, findings),
      ),
    );
  }

  return finalizeScan(deps, LOOP, results);
}
