---
name: prepare-digest-delta
description: Use right after a ticket is implemented and evidenced — while you still hold the diff in context — to PREPARE the Repo Digest delta and the feature note as a recorded evidence row, so the merge step can apply them deterministically WITHOUT spending a fresh agent call. Invoke once your change is committed and its ACs are evidenced, as the last thing you do before you stop (the runner submits for review). It only PREPARES (records inert evidence); the merge APPLIES it post-review, so a rejected delivery never touches the digest.
stack: []
area: workflow
---

# Prepare the Repo Digest delta (apply-at-merge)

You just implemented and evidenced a ticket. You already know exactly what changed —
so you are the cheapest place to write down how the **Repo Digest** should move and
which **feature** this ticket ships. This skill records that as a single, structured
**evidence row**. It is INERT: nothing is applied now. The factory's merge step reads
this row **post-review** and applies it deterministically (no new agent call). If the
ticket is rejected, it never merges, so this prepared delta never pollutes the digest.

This is the **prepare** half of prepare-at-delivery / apply-at-merge. Recording the
delta here — instead of running a fresh `claude -p` on every merge — is the whole cost
win. Keep it cheap: you are summarising a diff you already have, not re-deriving it.

## Steps

1. **Decide what the digest should say now.** For each Repo Digest section your change
   makes stale (architecture, key flows, conventions, surface area, gotchas, …), write
   the SHORT updated prose for that section — only sections you actually changed. If the
   change is small and touches no section's narrative, you may record zero sections (the
   merge will still stamp freshness).
2. **Name the feature this ticket ships.** One feature note: its `name`, a one-line
   `summary`, and — if you know it — the `scopeNode` and `provenance` (e.g. the epic
   ref). This is what the merge advances/adds to `shipped`.
3. **Record ONE evidence row** via the Dispatch MCP delivery-evidence path
   (`attach_delivery_evidence` / the `record-evidence` flow), `evidence_type:
   manual_note`, whose **summary is exactly** the marker line below — the marker, a
   single space, then a compact one-line JSON payload:

   ```
   GAFFER_DIGEST_DELTA_V1 {"repo":"<repo-name>","sections":[{"section":"<digest section>","content":"<updated prose>"}],"feature":{"name":"<feature name>","summary":"<one line>","scopeNode":"<id or omit>","provenance":"<epic ref or omit>"}}
   ```

   - The summary MUST start with `GAFFER_DIGEST_DELTA_V1 ` (marker + one space).
   - The payload MUST be valid one-line JSON. `sections` may be `[]`; `feature` may be
     omitted if this ticket ships no discrete feature.
   - Record at most one such row per ticket. If you record more than one, the merge
     uses the LAST — so re-record a corrected full payload rather than a partial patch.
4. **Stop.** Do not call any digest or feature tool yourself — applying is the merge's
   job, and only the merge's, so a rejected delivery is never applied. Once this and
   your AC evidence are recorded you are done — the runner records the delivery and
   submits for review.

## Rules

- **Prepare only — never apply.** No `update_repo_digest`, no `add_feature`, no
  `advance_feature` from here. The merge owns application, exactly once, post-review.
- The payload must be TRUE: describe the digest as it should read AFTER this change,
  grounded in the diff you delivered — never speculative future work.
- Keep section prose tight and current — the digest is a living map, not a changelog.
  Replace stale narrative; do not append history.
- One row, valid JSON, marker-prefixed. A malformed payload is ignored by the merge
  (it falls back to a minimal freshness stamp), so getting the shape right is what makes
  the cheap apply-at-merge path work.
