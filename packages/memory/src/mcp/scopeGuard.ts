/**
 * Repo-scope guard for DIRECT-APPLY memory writes in the factory.
 *
 * ARCHITECTURE.md's memory trust model has two tiers. The DIRECT-APPLY
 * (ungated) tier — `update_repo_digest`, `add_feature`, `advance_feature`
 * (file cards are written by the CLI onboard/merge lane, not an agent MCP
 * tool, so they aren't reachable here) — applies immediately: input is
 * length-bounded, sanitised, and quarantine-wrapped on read. What those
 * checks do NOT constrain is the TARGET REPO: the write lands against
 * whatever repo NAME the caller passes.
 *
 * In the factory a delivery agent for ticket T is scoped to a specific set
 * of repos — the same repo-access boundary the runner already enforces on
 * the filesystem via GAFFER_WRITE_ROOTS (see crew/safety/rootAccess.ts and
 * runner/safety-hook.mjs). Without a matching check on memory, a
 * prompt-injected agent could write a digest / feature targeting a
 * DIFFERENT repo its ticket has no scope over, poisoning the memory a
 * future delivery there will consult.
 *
 * This guard binds those writes to the ticket's repo scope. The runner
 * passes the in-scope repo NAMES to the memory MCP server as
 * `GAFFER_TICKET_REPOS` (newline/colon-separated — the same split shape as
 * the roots parser) and marks the factory context with `GAFFER_FACTORY=1`
 * (exactly as the dispatch server already does). A write to a repo not on
 * that list is refused, FAIL CLOSED — the same posture as the safety hook
 * and the dispatch gate.
 *
 * Standalone `memory-mcp` never sets `GAFFER_FACTORY`, so the guard is
 * INERT there and standalone behaviour is UNCHANGED.
 *
 * Pure functions of `(repo, env)` so tests can drive them without spinning
 * up the stdio server — mirroring redact.ts's `shouldGate*` helpers.
 */

/**
 * Whether repo-scope enforcement is active for this process. True only in
 * the factory delivery context, which the runner marks with
 * `GAFFER_FACTORY=1`. Standalone `memory-mcp` never sets it, so the guard
 * stays inert and standalone writes are unchanged.
 */
export function scopeEnforcementActive(env: NodeJS.ProcessEnv): boolean {
  return env["GAFFER_FACTORY"] === "1";
}

/**
 * Split a `GAFFER_TICKET_REPOS` value into trimmed repo names. Newline- OR
 * colon-separated (mirrors the write/read roots parser split), but compares
 * NAMES — so entries are trimmed only, never `resolve()`d as paths — to
 * line up with `normaliseRepo` (trim-only) in repoUnderstanding.ts.
 */
export function parseTicketRepos(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n:]+/)
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * Decide whether `repo` is within the current ticket's repo scope. Pure
 * function of `(repo, env)`.
 *
 * FAIL CLOSED: when enforcement is active but `GAFFER_TICKET_REPOS` is
 * absent, empty, or unparsable, the allowed set is empty and EVERY repo is
 * out of scope — a missing scope signal refuses all writes rather than
 * silently allowing them. Callers gate on `scopeEnforcementActive` first,
 * so this is only consulted when enforcement is on.
 */
export function repoInScope(repo: string, env: NodeJS.ProcessEnv): boolean {
  const target = repo.trim();
  if (!target) return false;
  const allowed = parseTicketRepos(env["GAFFER_TICKET_REPOS"]);
  if (allowed.length === 0) return false; // fail closed: no scope signal ⇒ refuse
  return allowed.includes(target);
}

export interface RepoOutOfScopeRefusal {
  readonly error: "repo_out_of_scope";
  readonly repo: string;
  readonly hint: string;
}

/**
 * Refusal payload returned when a direct-apply write targets a repo outside
 * the ticket's scope. Echoes only the repo the write targeted (the agent
 * already named it, or resolved it from an id it holds) and a fixed hint —
 * deliberately does NOT enumerate the allowed set back to the agent,
 * mirroring redactRestricted's minimal-leak posture.
 */
export function repoOutOfScopeRefusal(repo: string): RepoOutOfScopeRefusal {
  return {
    error: "repo_out_of_scope",
    repo,
    hint:
      "This memory write targets a repo outside the current ticket's scope. " +
      "A delivery agent may only write direct-apply memory (digest / feature) " +
      "for the repo(s) its ticket is scoped to. If this repo genuinely belongs " +
      "to the ticket, the operator must add it to the ticket's repo scope.",
  };
}
