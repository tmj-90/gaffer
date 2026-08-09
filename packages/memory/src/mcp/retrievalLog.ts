/**
 * Fail-soft retrieval logging for the MCP read path (memory ROI, migration 011).
 *
 * A delivery agent's reads (search_lore / get_repo_digest / list_features /
 * cards) are the moment memory "primes the next delivery." This records which
 * record id(s) were SERVED for which ticket so the ROI report can later join
 * them to the ticket outcome. The instrumentation is strictly additive:
 *
 *   - GATED ON TICKET: the ticket ref arrives via GAFFER_RECALL_TICKET (the same
 *     marker the CLI primer already uses, plumbed one hop into the memory MCP
 *     env — mirroring GAFFER_TICKET_REPOS). Standalone `memory-mcp` never sets
 *     it, so the whole feature is INERT there: absent/empty ticket ⇒ log nothing,
 *     zero read-path overhead. Same posture as scopeEnforcementActive.
 *   - FAIL-SOFT: the whole call is wrapped so a throw is swallowed. It returns
 *     void and takes NO part in building the tool's response — a failure here can
 *     never block, slow materially, or change what memory returns to the agent.
 *   - IDS ONLY: it records record ids + the ticket ref, never agent free-text
 *     bodies — nothing new to sanitise.
 *
 * Call it IMMEDIATELY AFTER the tool's existing `audit(...)` call (same site,
 * same posture — audit already writes on every read).
 */
import type { Database } from "better-sqlite3";

import { logRetrieval, type RetrievalItem } from "../core/retrievalRoi.js";
import { parseTicketRepos } from "./scopeGuard.js";

/** The current delivery ticket ref, or "" when there is none (standalone/no-ticket). */
export function recallTicket(env: NodeJS.ProcessEnv): string {
  return (env["GAFFER_RECALL_TICKET"] ?? "").trim();
}

/**
 * Best-effort repo key for a retrieval row. Prefer the tool's own `repo` arg
 * (digest / features / cards always carry it); else fall back to the ticket's
 * primary in-scope repo (first GAFFER_TICKET_REPOS entry, mirroring the runner's
 * RECALL_REPO_NAME so the outcome join lands); else "".
 */
function bestEffortRepo(env: NodeJS.ProcessEnv, repoArg?: string): string {
  const a = (repoArg ?? "").trim();
  if (a) return a;
  const scoped = parseTicketRepos(env["GAFFER_TICKET_REPOS"]);
  return scoped[0] ?? "";
}

/**
 * Record a retrieval, fail-soft. Gates on ticket presence first (no ticket ⇒
 * no cost, no write). Any error is swallowed — the read it instruments must be
 * unaffected. Returns void; callers MUST NOT use its result to shape a response.
 */
export function recordRetrieval(
  db: Database,
  tool: string,
  items: ReadonlyArray<RetrievalItem>,
  repoArg?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const ticket = recallTicket(env);
    if (!ticket) return; // inert without a delivery ticket (standalone / no-ticket)
    if (items.length === 0) return;
    logRetrieval(db, {
      repo: bestEffortRepo(env, repoArg),
      ticket,
      tool,
      items,
    });
  } catch {
    // Swallow — instrumentation must never block or change a read.
  }
}
