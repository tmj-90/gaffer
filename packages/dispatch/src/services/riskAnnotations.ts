/**
 * Deterministic risk-annotation for the review gate.
 *
 * As batch sizes grow, the human review gate is where the operator's scarce attention
 * is spent — and on a large diff there is no fast way to see WHERE the risk concentrates.
 * This flags, from the real server-computed diff's changed paths + line counts, the parts
 * that deserve the human's eyes first. It is purely ADVISORY: the authoritative diff and
 * the Approve-gated-on-real-diff behaviour never change — this only re-orders where the
 * reviewer looks.
 *
 * Pure + deterministic (no I/O). Mirrors the runner-side lite-mode sensitive-path
 * classifier (`gaffer_lite_trivial_reason` / GAFFER_LITE_SENSITIVE_RE) so "what lite mode
 * refuses to auto-approve" and "what the reviewer is told to look at" stay consistent.
 * Over-flagging is safe here (advisory), so the patterns lean inclusive.
 */

export type RiskKind = "sensitive-path" | "dependency-change" | "large-deletion";

export interface RiskAnnotation {
  readonly kind: RiskKind;
  readonly severity: "high" | "medium";
  /** Short human summary, e.g. "3 sensitive paths (auth/, migrations/…)". */
  readonly detail: string;
  /** The concrete paths that triggered it (omitted for count-only signals). */
  readonly paths?: readonly string[];
}

/**
 * Secret/auth/infra paths — mirrors the lite-mode ERE, ported to JS + a little broader
 * (advisory). Segment-anchored where it matters so "author.ts" doesn't trip "auth".
 * Operator-overridable via DISPATCH_SENSITIVE_PATH_RE.
 */
const DEFAULT_SENSITIVE_SRC =
  "(^|/)(migrations?|\\.github|dockerfile|auth|authz|security|secrets?|credentials?|\\.env|\\.gaffer|safety-hook)(/|\\.|-|_|$)|(\\.pem|\\.key|id_rsa[a-z0-9_]*)$";

/** Dependency/manifest files — a change here can pull in new transitive code. */
const DEPENDENCY_RE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json|cargo\.(toml|lock)|go\.(mod|sum)|requirements\.txt|pyproject\.toml|gemfile(\.lock)?|composer\.(json|lock))$/i;

function sensitiveRe(env: NodeJS.ProcessEnv): RegExp {
  const override = (env.DISPATCH_SENSITIVE_PATH_RE ?? "").trim();
  try {
    return new RegExp(override || DEFAULT_SENSITIVE_SRC, "i");
  } catch {
    // A malformed operator override must never break the review diff — fall back.
    return new RegExp(DEFAULT_SENSITIVE_SRC, "i");
  }
}

function largeDeletionThreshold(env: NodeJS.ProcessEnv): number {
  const n = Number.parseInt(env.DISPATCH_LARGE_DELETION_LINES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 150;
}

function summarise(paths: readonly string[], max = 3): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown}, +${paths.length - max} more` : shown;
}

/**
 * Classify the risk in one repo's change from its changed paths + deletion count.
 * Returns [] when nothing is elevated (the UI renders an explicit "no elevated-risk
 * signals" state rather than an empty region).
 */
export function computeRiskAnnotations(
  paths: readonly string[],
  deletions: number,
  env: NodeJS.ProcessEnv = process.env,
): RiskAnnotation[] {
  const out: RiskAnnotation[] = [];
  const sensRe = sensitiveRe(env);
  const sensitive = paths.filter((p) => sensRe.test(p));
  if (sensitive.length > 0) {
    out.push({
      kind: "sensitive-path",
      severity: "high",
      detail: `${sensitive.length} sensitive path${sensitive.length === 1 ? "" : "s"} (${summarise(sensitive)})`,
      paths: sensitive,
    });
  }
  const deps = paths.filter((p) => DEPENDENCY_RE.test(p));
  if (deps.length > 0) {
    out.push({
      kind: "dependency-change",
      severity: "medium",
      detail: `dependency/manifest changed (${summarise(deps)})`,
      paths: deps,
    });
  }
  const threshold = largeDeletionThreshold(env);
  if (deletions >= threshold) {
    out.push({
      kind: "large-deletion",
      severity: "medium",
      detail: `${deletions} lines deleted (≥ ${threshold})`,
    });
  }
  return out;
}
