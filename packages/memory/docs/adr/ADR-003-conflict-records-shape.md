# ADR-003: Conflict-records storage shape and link directionality

**Status:** Accepted (ratified 2026-05-17 alongside epic-init-2026-05-17-001-03)
**Initiative:** init-2026-05-17-001
**Epic:** conflict-records (epic 3)

## Context

The team needs a primitive for "I disagree with this canonical record" that:

- never lets an agent mutate canonical lore (R1+ poisoning-prevention is the whole point of the draft lifecycle);
- is durable across sessions and committable through `memory sync`;
- is distinct from the existing `possibleConflicts` overlap heuristic (which is a runtime-only hint based on shared repo+tag);
- gets PR-reviewed before becoming authoritative.

Two shapes were considered.

## Decision

**1. Storage: a nullable `conflicts_with TEXT` column on `lore`, JSON-encoded as a string array (or NULL).**

Decoded into `Lore.conflictsWith?: ReadonlyArray<string>` at the hydration boundary (`rowToLore` / `rowToSummary`). `NULL` decodes to `undefined`; a non-empty array decodes to a frozen `ReadonlyArray<string>`; `[]` is not a representable on-disk state.

**2. Link directionality: one-way, on the counter-record only.**

`reportConflict` writes `conflicts_with` on the new draft and emits a `conflict_reported` event keyed to the original record's id. The original `lore` row is never UPDATEd. The reviewer resolves a counter-claim using existing lifecycle ops (`approveLore`, `updateLore`, `supersedeLore`, `rejectLore`).

## Alternatives considered

### A. Separate join table `lore_conflicts(lore_id, conflicts_with_id)`

Pros: normalised; cheap to query "who challenges X?" with an indexed lookup; symmetric.
Cons: an additional table + cascade-delete contract; a second sync-format change; reads now require a third hydration query per record (we already pay two for repos/tags); query power not actually used in v1 (CLI/MCP only need "show me what THIS counter is challenging"). Rejected for v1; revisitable if we later want a reverse-lookup CLI command.

### B. Single-id column (`conflicts_with TEXT` storing one id, not a list)

Pros: simplest possible shape; matches today's use case (one counter targets one original).
Cons: forecloses on a future "counter-record challenging multiple records at once" use case for no real save (one TEXT column either way). Rejected on YAGNI symmetry — the JSON-array shape is the same cost.

### C. Bidirectional link (back-pointer on the original)

Pros: surfaces "this record has been challenged" in default search without an extra query.
Cons: requires UPDATE on the canonical record, which is the exact invariant we're trying to keep ("agents cannot poison canonical lore"). The CLI/MCP can compute the back-link from the events table when actually needed. Rejected on the trust-model boundary.

## Consequences

**Positive.**

- Migration is one column add, append-only, idempotent.
- The `conflicts_with` field rides through the existing sync round-trip with a single new frontmatter line.
- The trust boundary is bright: a `grep` for `UPDATE lore` inside `reportConflict` will fail the review.
- Decouples cleanly from the runtime `possibleConflicts` heuristic — distinct field, distinct lifecycle.

**Negative / accepted.**

- Querying "find all counters against record X" requires a table scan in v1 (decode `conflicts_with` JSON per row) or a derived events lookup (`SELECT lore_id FROM events WHERE kind='conflict_reported' AND payload LIKE ...`). Acceptable while N is small; if it becomes a hot path we extract the join table (A above) in a follow-up.
- `conflicts_with` is denormalised JSON — referential integrity of the target id is NOT enforced by SQLite. Mitigated by validating the existing-id at write time in `reportConflict`; an id later deleted will leave a dangling reference (cosmetic; CLI rendering tolerates it).
- A counter-draft whose target is later superseded does NOT auto-update its `conflictsWith`. The reviewer sees stale linkage on display; documented here. (Deferred — see below.)

**Establishes the pattern for future cross-record relations** (clarifies, references, etc.): JSON-array column + event-on-target + counter-side ownership.

## Deferred (not in scope for this epic)

- Reverse lookup ("show all counters against X").
- Auto-rewrite of `conflictsWith` when target is superseded.
- Dedup of repeated counters against the same target.
- Bidirectional surfacing in search (without UPDATEing the original).
