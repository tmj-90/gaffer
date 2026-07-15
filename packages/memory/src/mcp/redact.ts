/**
 * MCP trust-boundary helpers for restricted records.
 *
 * `search_lore` already env-gates restricted retrieval via
 * `MEMORY_ALLOW_RESTRICTED_MCP`. Without a matching gate on `get_lore(id)`,
 * any agent in possession of an id (a stale audit line, a prior message,
 * a CLI screenshot) could fetch the body and bypass the search gate.
 * These helpers close that asymmetry: when the gate is off and the
 * record is restricted, `get_lore` returns a minimal refusal shape
 * (no title, no body, no metadata) and records `blocked: "restricted"`
 * in the audit log.
 */

import { quarantine, QUARANTINE_NOTICE } from "./quarantine.js";

export interface RestrictedRefusal {
  readonly id: string;
  readonly restricted: true;
  readonly error: "restricted";
  readonly hint: string;
}

/**
 * Build the refusal payload returned by `get_lore` when the gate blocks
 * a restricted record. Deliberately omits title / summary / body / source /
 * timestamps — the agent already knows the id (it had to, to ask), but it
 * shouldn't learn anything else.
 */
export function redactRestricted(id: string): RestrictedRefusal {
  return {
    id,
    restricted: true,
    error: "restricted",
    hint: "Set MEMORY_ALLOW_RESTRICTED_MCP=1 to allow MCP access to restricted lore.",
  };
}

/**
 * Decide whether a `get_lore` response should be redacted. Pure function
 * of (record, env) so tests can drive it without spinning up the server.
 *
 * Returns true when:
 *   - the record exists and is restricted, AND
 *   - the env gate is NOT set to "1".
 */
export function shouldGateRestrictedGet(
  lore: { readonly restricted: boolean } | null,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!lore) return false;
  if (!lore.restricted) return false;
  return env["MEMORY_ALLOW_RESTRICTED_MCP"] !== "1";
}

/**
 * Strip the `possibleConflicts` field from each search hit before it
 * leaves the MCP boundary. The conflict heuristic (shared repo + tag)
 * is useful for human triage in `memory search`, but surfacing it to
 * an LLM agent tends to cost more tokens (the agent treats the hint as
 * authoritative and tries to "resolve" the alleged conflict) than the
 * heuristic earns. The field is removed wholesale rather than
 * downgraded so a curious agent can't infer its existence either.
 *
 * Exported separately so a unit test can pin the contract without
 * spinning the stdio server.
 */
export function stripPossibleConflicts<
  T extends { readonly possibleConflicts?: ReadonlyArray<string> },
>(hits: ReadonlyArray<T>): Array<Omit<T, "possibleConflicts">> {
  return hits.map(({ possibleConflicts: _ignored, ...rest }) => rest);
}

/**
 * The agent-coaching string shipped on every zero-hit search that has
 * no active absence_marker. Exposed so the unit test can pin the
 * contract without re-encoding the prose.
 *
 * Three behaviours it nudges, in priority order:
 *   1. `record_absence` if the team genuinely has no policy
 *   2. `suggest_lore` at task end if the agent discovers something
 *   3. Retry without `repo` filter — cross-repo lore can live tagged
 *      to multiple repos; a too-narrow filter hides it.
 *
 * Tone is "instructional, not preachy" — a working colleague's
 * one-paragraph nudge, not three paragraphs of process.
 */
export const SEARCH_NO_HIT_COACH =
  "No ratified position found. If the gap is real and durable " +
  "(team has no policy on this), call record_absence so future " +
  "agents don't re-search. If you discover something durable " +
  "while completing this task, call suggest_lore at the end. " +
  "If the query is repo-scoped and the topic could touch other " +
  "repos, retry search_lore without `repo` to look across all " +
  "lore (e.g. cross-repo conventions, shared infra rules).";

/**
 * MCP `record_absence` is the one agent-facing write that bypasses the
 * human review queue (markers are low-stakes, self-expiring, never
 * canonical lore). v0.1 still ships it off by default — agents writing
 * persistent retrieval-affecting state without approval is a trust-model
 * exception worth an explicit opt-in. The CLI `memory absent record`
 * always works (humans don't need the gate); only MCP-side writes are gated.
 *
 * Pure function of `env` so a test can drive it without spinning the server.
 */
export function shouldGateAbsenceWrite(env: NodeJS.ProcessEnv): boolean {
  return env["MEMORY_ALLOW_MCP_ABSENCE"] !== "1";
}

export interface AbsenceDisabledRefusal {
  readonly error: "mcp_record_absence_disabled";
  readonly hint: string;
}

/**
 * Refusal payload returned by `record_absence` when the env gate blocks
 * the write. The hint directs the agent to surface the gap to the human
 * (who can record the marker via the CLI) rather than retrying.
 */
export const ABSENCE_DISABLED_REFUSAL: AbsenceDisabledRefusal = {
  error: "mcp_record_absence_disabled",
  hint:
    "MCP-side absence-marker writes are off by default in v0.1. " +
    "Surface the finding to the human and let them record the " +
    'marker with `memory absent record "<query>" --reason "..."`. ' +
    "To enable agent writes, the operator can set " +
    "MEMORY_ALLOW_MCP_ABSENCE=1 in the MCP server's environment.",
};

/**
 * `report_conflict` against a restricted record is always refused,
 * regardless of `MEMORY_ALLOW_RESTRICTED_MCP` — restricted lore can
 * only be revised by humans through `memory update` / `supersede`,
 * not by an agent-suggested counter-record. The core layer also
 * refuses (defence in depth); this MCP-side check produces a friendlier
 * structured response than letting the core throw.
 *
 * Pure function of the looked-up record so tests can pin the contract.
 */
export function shouldRefuseConflictAgainstRestricted(
  existing: { readonly restricted: boolean } | null,
): boolean {
  if (!existing) return false;
  return existing.restricted;
}

export interface ConflictAgainstRestrictedRefusal {
  readonly error: "restricted";
  readonly hint: string;
}

/**
 * Refusal payload returned by `report_conflict` when the target record
 * is restricted. Directs the agent to escalate to the human rather than
 * suggesting setting an env var — the env var does not unlock this path.
 */
export const CONFLICT_AGAINST_RESTRICTED_REFUSAL: ConflictAgainstRestrictedRefusal = {
  error: "restricted",
  hint:
    "Restricted records cannot be challenged via MCP. " +
    "If you believe one needs revising, surface the concern " +
    "to the human and let them use the CLI (`memory show <id>` " +
    "then `memory update` / `memory supersede`).",
};

export interface AbsenceMarkerForResponse {
  readonly reason: string;
  readonly recordedAt: string;
  readonly expiresAt: string;
}

/**
 * Coaching string attached when results were capped by `limit` and more
 * matches exist. Tells the agent the set is partial so it narrows
 * (sharper query, repo/tag filter, or a higher `limit`) rather than
 * treating the top-N as the team's complete position. Exported so the
 * unit test can pin the contract.
 */
export const SEARCH_TRUNCATED_HINT =
  "More matches exist than were returned. These are the top-ranked " +
  "(relevance + trust) hits. If none answers your question, narrow the " +
  "query, add a `repo`/`tag` filter, or raise `limit` (max 50) — don't " +
  "assume the team's position is limited to what's shown.";

/**
 * Pure builder for the `search_lore` response body. Shapes:
 *
 *   - hits present                    → { results }
 *   - hits present + truncated        → { results, truncated: {...} }
 *   - empty + active marker matched   → { results, absence_marker }
 *   - empty + no marker + has query   → { results, next }
 *   - empty + no marker + no query    → { results } (blank list-recent
 *                                                    has no useful coach)
 *
 * `totalMatches` is the unlimited match count (from `searchLoreCount`);
 * when it exceeds the number of hits shown we attach a `truncated`
 * block. Omitted / undefined `totalMatches` means "don't know / don't
 * report" so existing callers and tests keep the bare `{ results }`
 * shape.
 *
 * Exported so a unit test can pin the contract without spinning up the
 * stdio server.
 */
export function buildSearchResponseBody<T>(opts: {
  hits: ReadonlyArray<T>;
  query: string | undefined;
  absenceMarker: AbsenceMarkerForResponse | null;
  totalMatches?: number;
}): Record<string, unknown> {
  const base: Record<string, unknown> = { results: opts.hits };
  if (opts.absenceMarker) {
    base["absence_marker"] = {
      // The marker `reason` is AGENT-authored free text (writable when
      // MEMORY_ALLOW_MCP_ABSENCE=1). Wrap it in the untrusted envelope — which also
      // strips any embedded delimiter tokens — so a planted "SYSTEM: …" reason can't
      // inject the next agent that hits this zero-hit search. Ship the notice too.
      reason: quarantine("absence", opts.absenceMarker.reason),
      recordedAt: opts.absenceMarker.recordedAt,
      expiresAt: opts.absenceMarker.expiresAt,
    };
    base["security"] = QUARANTINE_NOTICE;
    return base;
  }
  if (opts.hits.length === 0 && opts.query) {
    base["next"] = SEARCH_NO_HIT_COACH;
    return base;
  }
  if (typeof opts.totalMatches === "number" && opts.totalMatches > opts.hits.length) {
    base["truncated"] = {
      shown: opts.hits.length,
      total: opts.totalMatches,
      hint: SEARCH_TRUNCATED_HINT,
    };
  }
  return base;
}
