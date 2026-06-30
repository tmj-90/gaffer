---
name: card-review
description: |
  Internal skill for onboard's semantic review gate. After the deterministic
  validation gate (which catches invented symbols / hash drift / secrets), this
  skill drives a sampled `claude -p` pass that checks whether the TLDR and role
  are DIRECTIONALLY ACCURATE given the file's structure and head snippet. The
  deterministic gate is the FLOOR; this skill is the ceiling check for plausible-
  but-wrong summaries (e.g. "handles auth middleware" when the file only renders
  auth *errors*). Used by onboard-analyze.mjs. Not for the ticket delivery flow.
stack: []
area: memory
---

# Review one file card — the semantic accuracy gate

You will be given:
1. A **card** (tldr + role) produced by the generation pass.
2. The **mechanical structure** of the file (imports, top-level symbol names).
3. A **bounded head snippet** of the file.

Your job: judge whether the TLDR and role are **directionally accurate and not
over-claiming** — given ONLY the structure and snippet shown.

You are NOT asked to rewrite the card. You are asked to give a **verdict** and
one sentence explaining it.

## The accuracy bar

**This is a generous but honest bar.** You are not looking for perfection; you
are catching meaningful errors.

A card PASSES if:
- The TLDR's primary claim is consistent with the structure and snippet.
- Imprecision or vagueness is acceptable as long as nothing is actively wrong.
- The role label is plausible (even if another label might be slightly better).

A card REVISES if:
- The TLDR is partially right but contains a specific false claim that could
  mislead an agent (e.g. claims it exports `handleSession` when no such symbol
  appears in the structure).
- The role label is clearly wrong (e.g. `migration` for a route handler).

A card REJECTS if:
- The TLDR describes something fundamentally different from what the file is
  (e.g. "implements JWT authentication" for a file that only does arithmetic).
- The TLDR is so vague it provides zero retrieval value ("utility functions").
- The TLDR contains fabricated behaviour not visible in the structure or snippet.

## What you must NOT do

- Do NOT penalise a card for being brief or imprecise — only for being wrong.
- Do NOT infer capabilities from the filename alone; use only what the structure
  and snippet show.
- Do NOT reject a card because you would have written it differently. The bar is
  directional accuracy, not editorial quality.
- Do NOT consider the symbols field in your verdict — that is the deterministic
  gate's job. Focus only on the TLDR and role_primary.
- Do NOT write a revised TLDR. Your output is verdict + one-sentence reason only.

## Sampling context

This review runs on a SAMPLE of cards (typically up to 5 per onboard, configurable
via GAFFER_CARD_REVIEW_SAMPLE). It is best-effort: a review failure never fails
the onboard. Cards that pass the deterministic gate but fail this semantic gate
are downgraded to model_status='failed_validation' with your reason recorded.

The mechanical fields (path, symbols, loc) are still served even for failed
model summaries — the card retains retrieval value, just without the TLDR.

## Output format

Return EXACTLY one fenced ```json block as the LAST thing in your response:

```json
{
  "verdict": "pass | revise | reject",
  "reason": "<one sentence: what is correct, or what specific claim is wrong>"
}
```

Examples of good reasons:
- pass: "TLDR correctly identifies the file as arithmetic helpers exporting `add` and `PI`."
- revise: "TLDR claims `handleSession` is exported but that symbol is not in the structure."
- reject: "TLDR describes JWT authentication but the file only contains math utility functions."
