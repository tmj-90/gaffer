import type { OracleFinding, OracleSeverity } from "./types.js";

const SEVERITY_RANK: Record<OracleSeverity, number> = { error: 3, warning: 2, info: 1 };

/** Rank: error > warning > info, then file, then line. */
function rank(a: OracleFinding, b: OracleFinding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  );
}

/**
 * A stable de-dup signature for an oracle finding set, used so the same precise
 * findings re-discovered on a later tick map to the same open draft. It is the
 * tool id plus a hash of the (file, line, rule) tuples — NOT date-stamped — so a
 * re-run with identical findings yields the same key. A change in the finding set
 * yields a new key (a genuinely new finding earns a fresh draft).
 */
export function oracleFindingKey(toolId: string, findings: readonly OracleFinding[]): string {
  const tuples = [...findings]
    .map((f) => `${f.file}:${f.line}:${f.rule}`)
    .sort()
    .join("|");
  return `${toolId}:${djb2(tuples)}`;
}

function djb2(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Render a precise, auditable summary from oracle findings for a drafted ticket.
 * Leads with severity counts, then the top findings (file:line — rule: message).
 * `toolLabel` names the oracle so the ticket says exactly which tool spoke.
 */
export function summariseOracleFindings(
  repoName: string,
  toolLabel: string,
  findings: readonly OracleFinding[],
  acceptance: string,
): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const head =
    `${toolLabel} oracle scan of ${repoName} found ${findings.length} precise finding(s) ` +
    `(${counts.error} error, ${counts.warning} warning, ${counts.info} info). ` +
    `These are tool-verified findings (file/line/rule), not heuristic guesses.`;
  const detail = [...findings]
    .sort(rank)
    .slice(0, 20)
    .map((f) => {
      const span = f.endLine && f.endLine !== f.line ? `${f.line}-${f.endLine}` : `${f.line}`;
      return `  - ${f.file}:${span} [${f.severity}] ${f.rule}: ${f.message}`;
    })
    .join("\n");
  return `${head}\n\nTop findings:\n${detail}\n\n${acceptance}`;
}
