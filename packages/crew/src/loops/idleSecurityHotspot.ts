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
import { resolveMinDeliveredTickets } from "../config/schema.js";

const LOOP = "security_hotspot";

/**
 * A single security hotspot found in source. Carries the file + line (the
 * location), the `risk` (why it matters and how to remediate), and a redacted
 * `snippet` for context. Secret values are never copied into the snippet.
 */
export interface SecurityHotspotFinding {
  file: string;
  line: number;
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
  kind: SecurityHotspotFinding["kind"];
  match: (line: string) => boolean;
  risk: string;
}

const DETECTORS: readonly Detector[] = [
  {
    kind: "secret",
    match: looksLikeSecret,
    risk:
      "Hardcoded credential in source — secrets leak through VCS history and grant standing access. " +
      "Move it to an environment variable or a secret manager and rotate the exposed value.",
  },
  {
    kind: "injection",
    match: (l) => SQL_INJECTION_RE.test(l),
    risk:
      "Variable concatenated into a SQL statement enables SQL injection. " +
      "Use parameterised queries / prepared statements instead of string building.",
  },
  {
    kind: "injection",
    match: (l) => DANGEROUS_HTML_RE.test(l),
    risk:
      "Raw HTML sink (innerHTML / dangerouslySetInnerHTML) can introduce XSS when given unsanitised input. " +
      "Sanitise the value or use safe DOM/text APIs.",
  },
  {
    kind: "unsafe_api",
    match: (l) => UNSAFE_API_RE.test(l),
    risk:
      "Dynamic code or shell execution (eval / new Function / child_process.exec) can run attacker-controlled input. " +
      "Avoid eval; prefer execFile with an argument array and validated inputs.",
  },
  {
    kind: "authz_gap",
    match: (l) => AUTHZ_GAP_RE.test(l),
    risk:
      "A security control appears explicitly disabled (TLS verification, CSRF, or auth). " +
      "Re-enable it, or document and scope a vetted exception.",
  },
];

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

/**
 * Scan one file's source for security hotspots: hardcoded secrets, injection
 * sinks (SQL/HTML), unsafe code/command execution, and disabled security
 * controls. Best-effort line scanning — no parsing — matching the other idle
 * scans' "grep the repo" heuristic. Findings are advisory, not proof.
 */
export function scanSecurityHotspots(source: string, file: string): SecurityHotspotFinding[] {
  const findings: SecurityHotspotFinding[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const detector of DETECTORS) {
      if (!detector.match(line)) continue;
      const snippet = detector.kind === "secret" ? redactSnippet(line) : line.trim().slice(0, 120);
      findings.push({ file, line: i + 1, kind: detector.kind, risk: detector.risk, snippet });
    }
  }
  return findings;
}

function summarise(repoName: string, findings: SecurityHotspotFinding[]): string {
  const counts = { secret: 0, injection: 0, unsafe_api: 0, authz_gap: 0 };
  for (const f of findings) counts[f.kind]++;
  const head =
    `Security-hotspot scan of ${repoName} found ${findings.length} potential issue(s): ` +
    `${counts.secret} hardcoded secret(s), ${counts.injection} injection risk(s), ` +
    `${counts.unsafe_api} unsafe API call(s), ${counts.authz_gap} disabled security control(s). ` +
    `Heuristic findings — verify each before acting.`;
  const detail = findings
    .slice(0, 15)
    .map((f) => `  - ${f.kind} @ ${f.file}:${f.line} — ${f.risk}\n      ${f.snippet}`)
    .join("\n");
  return `${head}\n${detail}`;
}

/**
 * Idle security-hotspot loop. Walks each in-scope repo's source files, flags
 * likely security hotspots, and creates a DRAFT ticket per repo carrying each
 * finding's file/location and why it's a risk. Observation only — never edits
 * code. Dependency-level risks (vulnerable/outdated packages) are owned by the
 * dependency-hygiene loop, so this loop focuses on in-source hotspots.
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

  const results = [];
  for (const repo of candidates) {
    const root = deps.repoRegistry.absolutePath(repo);
    const files = walkFiles(root, isSecurityScanFile);
    const findings: SecurityHotspotFinding[] = [];
    for (const path of files) {
      findings.push(...scanSecurityHotspots(safeRead(path), relative(root, path)));
    }
    deps.events.record("security_hotspot_scanned", {
      repoName: repo.name,
      findings: findings.length,
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
