import type { ToolName } from "../mcp/tools.js"; // type-only — erased at compile time

/**
 * Per-tool request sanitisers for the audit log. This is the trust boundary
 * called out in SECURITY.md: the audit record carries enough to answer "what
 * did the agent do?" but NEVER the content of the work or any secret.
 *
 * Two rules enforced here, by construction rather than by hope:
 *   1. Claim tokens are never recorded. Where a token is present we record a
 *      boolean `claim_token: true/false` (was one supplied?) — never the value,
 *      not even a hash. The token is a bearer credential; a hash in an audit
 *      line is still a fingerprint worth withholding.
 *   2. Free-text bodies (descriptions, AC text, evidence summaries, decision
 *      questions, block reasons) are reduced to their character length, e.g.
 *      `summary_chars: 142`. Length is useful triage signal ("agent submitted
 *      an empty reason") without exposing the body.
 *
 * Allow-list, not deny-list: each sanitiser returns a brand-new object built
 * only from fields known to be safe. An unrecognised arg can never leak,
 * because it is simply never copied.
 */

type Args = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function chars(v: unknown): number | undefined {
  const s = asString(v);
  return s === undefined ? undefined : s.length;
}

/** Was a claim token supplied? Records presence only — never the value. */
function tokenPresent(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

/** Drop undefined values so the audit line stays compact. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (val !== undefined) out[k] = val;
  }
  return out;
}

type Sanitiser = (args: Args) => Record<string, unknown>;

const SANITISERS: Record<ToolName, Sanitiser> = {
  create_ticket: (a) =>
    compact({
      title: asString(a.title),
      description_chars: chars(a.description),
      priority: a.priority,
      risk_level: a.risk_level,
      policy_pack: a.policy_pack,
      repo: asString(a.repo),
    }),
  add_acceptance_criterion: (a) =>
    compact({
      ticket_id: asString(a.ticket_id),
      text_chars: chars(a.text),
      verification_method: asString(a.verification_method),
      evidence_required: a.evidence_required,
    }),
  mark_ticket_ready: (a) => compact({ ticket_id: asString(a.ticket_id) }),
  claim_next_ticket: (a) =>
    compact({
      agent_id: asString(a.agent_id),
      ttl_seconds: a.ttl_seconds,
      capability_count: Array.isArray(a.capabilities) ? a.capabilities.length : undefined,
    }),
  claim_ticket: (a) =>
    compact({
      ticket_id: asString(a.ticket_id),
      agent_id: asString(a.agent_id),
      ttl_seconds: a.ttl_seconds,
      capability_count: Array.isArray(a.capabilities) ? a.capabilities.length : undefined,
    }),
  record_delivery_artifact: (a) =>
    compact({
      claim_token: tokenPresent(a.claim_token),
      ticket_id: asString(a.ticket_id),
      branch_name: asString(a.branch_name),
      pr_url: asString(a.pr_url),
      commit: asString(a.commit),
      diff_summary_chars: chars(a.diff_summary),
    }),
  get_ticket: (a) => compact({ ticket_id: asString(a.ticket_id) }),
  heartbeat_claim: (a) => compact({ claim_token: tokenPresent(a.claim_token) }),
  record_ac_evidence: (a) =>
    compact({
      claim_token: tokenPresent(a.claim_token),
      ticket_id: asString(a.ticket_id),
      ac_id: asString(a.ac_id),
      repo_id: asString(a.repo_id),
      evidence_type: asString(a.evidence_type),
      summary_chars: chars(a.summary),
      uri: asString(a.uri),
      has_payload: a.payload !== undefined,
    }),
  mark_ticket_blocked: (a) =>
    compact({
      claim_token: tokenPresent(a.claim_token),
      ticket_id: asString(a.ticket_id),
      reason_chars: chars(a.reason),
    }),
  submit_ticket_for_review: (a) =>
    compact({
      claim_token: tokenPresent(a.claim_token),
      ticket_id: asString(a.ticket_id),
      reason_chars: chars(a.reason),
    }),
  record_repo_delivery: (a) =>
    compact({
      ticket_id: asString(a.ticket_id),
      repo_id: asString(a.repo_id),
      branch_name: asString(a.branch_name),
      commit_sha: asString(a.commit_sha),
      pr_url: asString(a.pr_url),
      status: asString(a.status),
      evidence_ref: asString(a.evidence_ref),
    }),
  add_dependency: (a) =>
    compact({
      ticket: asString(a.ticket),
      depends_on: asString(a.depends_on),
    }),
  create_epic: (a) => {
    // Record only the shape of the plan (name + counts) — never the ticket
    // titles, descriptions or AC text (free-text bodies stay out of the audit).
    const epic = (a.epic ?? {}) as Record<string, unknown>;
    const tickets = Array.isArray(a.tickets) ? a.tickets : [];
    const dependencyEdges = tickets.reduce(
      (sum: number, t) =>
        sum +
        (Array.isArray((t as Record<string, unknown>)?.dependsOn)
          ? ((t as Record<string, unknown>).dependsOn as unknown[]).length
          : 0),
      0,
    );
    return compact({
      epic_name: asString(epic.name),
      ticket_count: tickets.length,
      dependency_edge_count: dependencyEdges,
    });
  },
  list_pending_decisions: () => ({}),
  request_decision: (a) =>
    compact({
      title: asString(a.title),
      question_chars: chars(a.question),
      severity: a.severity,
      ticket_id: asString(a.ticket_id),
    }),
  release_claim: (a) =>
    compact({ claim_token: tokenPresent(a.claim_token) || tokenPresent(a.claimToken) }),
  list_scopes: () => ({}),
};

/**
 * Sanitise a tool's raw args into an audit-safe request shape. Falls back to
 * an empty object for any unknown tool — never echoes raw args.
 */
export function sanitiseRequest(tool: ToolName, args: Args): Record<string, unknown> {
  const sanitiser = SANITISERS[tool];
  return sanitiser ? sanitiser(args) : {};
}

/** Result-id extractor: pulls the entity id(s) a tool result references. */
export function resultIdsFor(data: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ["ticket_id", "ac_id", "evidence_id", "decision_id", "event_id"]) {
    const v = data[key];
    if (typeof v === "string") ids.push(v);
  }
  return ids;
}
