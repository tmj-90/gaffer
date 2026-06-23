/**
 * The retrieval rule the user pastes into their agent's instructions
 * file. Kept here (not just in the README) so `memory print-claude-instructions`
 * can emit it deterministically and `memory doctor` can verify it later.
 *
 * Edit only with care — this is the agent-side trust contract.
 */
export const CLAUDE_INSTRUCTIONS = `Before non-trivial or context-sensitive code changes, search \`lore\` for
relevant local memory.

Search when the task touches:
- auth/security
- dates/timezones
- migrations/schema changes
- payments/billing
- API contracts
- deployment/infra
- cross-repo conventions
- unfamiliar services or subsystems

Call \`search_lore\` first with the repo name, subsystem, and kind of change.
Prefer records that are \`active\`, scoped to the current repo/team/tag,
not stale, medium/high confidence, and backed by a source.

Treat stale, low-confidence, source-less, deprecated, or conflicting
records as clues, not authority. If lore conflicts with the repo, tests,
or the user's explicit instruction, surface the conflict before proceeding.

Only call \`get_lore\` when the summary is not enough.

**Cross-repo context.** Each search hit carries a \`repos\` array. The
local DB may contain records from other repos in the same workspace
(via \`memory sync pull <parent>\`), so search returns matches
regardless of which repo originated them. When a hit's \`repos\` does
NOT include the current repo, treat it as **cross-repo guidance,
not authority** — the rule was captured for a different codebase
and may not apply here. Use it as a hint to read the actual code
in this repo before acting. When the hit's \`repos\` does include
the current repo, treat it as repo-local lore at the confidence it
declares.

**Lore is for what you can't derive from the code.** Structural
questions (call graph, route definitions, who calls what, current
shape of any convention) are better answered by reading the code
directly. Lore is for the *why*, the *what-not-to-do*, the cross-team
policy, the incident lessons, and the staleness signals — things
the code doesn't tell you. If a lore search would just reconfirm
what \`grep\` already showed, skip the search.

**Counter-claims.** If you find code that explicitly contradicts an
active lore record (e.g. lore says "use Argon2id" but the code uses
scrypt as of a recent commit), call \`report_conflict\` with the
existing id and a one-line observation citing the contradicting
evidence. This creates a DRAFT counter-record for human review.
The original record is NEVER mutated. Use this only for genuine
contradictions, not benign overlap.

At the end of the task, call \`suggest_lore\` only if you discovered a
reusable convention, gotcha, decision, or service-specific rule that
would help future agents. Do not save temporary task state or speculation.`;

export function renderClaudeInstructions(): string {
  return CLAUDE_INSTRUCTIONS + "\n";
}
