---
name: minimalism
description: Use to deliver the simplest, shortest solution that fully satisfies the ticket — fewer tokens and less code per delivery, without ever weakening a safety guard. Invoke whenever you are about to implement a claimed ticket and want to resist over-engineering, or for "keep it minimal", "don't over-build this", "smallest change that works". A cross-cutting lens that composes with any implementation skill; supports intensity lite | full | ultra (default full).
stack: []
area: quality
---

# Minimalism — least code that fully works

Deliver the smallest correct change: fewer files, fewer lines, fewer moving parts, fewer
tokens spent — never fewer guarantees. Every acceptance criterion is still met in full;
you only refuse the scope, layers and abstractions the ticket did not ask for. Small
diffs are also easier to review, so defects are more likely to be caught.

This is a lens, not a stage: apply it while you implement (alongside the `plan-change`
skill and the build skill for the ticket) and confirm it in the `self-review` skill.

## The four questions (ask in order; stop at the first that resolves it)

1. **YAGNI — does this need to exist at all?** Delete speculative code paths, options,
   config knobs and "future-proofing" nobody asked for. If a file, class, flag or public
   symbol is not required by an AC, it is out of scope.
2. **Standard library before custom code.** Use what the language ships (collections,
   string/date/JSON utilities, iterators, `itertools`, `Array`/`Map`) before hand-rolling.
3. **Native platform features before a new dependency.** Prefer what the runtime,
   framework or browser provides. A new dependency is supply-chain risk and build weight,
   and in this factory it needs human approval: raise it with `request_decision` (or
   `mark_ticket_blocked` if the ticket cannot proceed without it) instead of adding it.
4. **One line before fifty.** Prefer the direct expression: a function over a framework,
   composition over a class hierarchy, a literal over a config system. Clarity first —
   a clear short solution beats a cryptic shorter one.

## Intensity levels

Default is **full**. Choose by the ticket's risk.

- **lite** — avoid obvious over-engineering and dead options; otherwise follow the repo's
  prevailing style even when verbose. For high-risk or unfamiliar code.
- **full** (default) — apply all four questions; drop every layer, option and
  abstraction no AC demands. The standard delivery posture.
- **ultra** — justify every file, dependency and public symbol you add; collapse anything
  that can be collapsed without losing correctness or clarity. When the ticket asks for
  the most minimal change possible.

## Procedure

1. Before editing, cross out anything in your plan that no AC requires.
2. While editing, prefer editing an existing file to adding one; leave unrelated code,
   formatting and comments untouched (a reformatted file hides the real change).
3. Before committing, read `git diff --stat <default>...HEAD` plus your uncommitted
   changes. For each file ask: which AC needs this? Remove what has no answer; remove
   debug output and commented-out code.
4. Record the **smallest-change note** once, after your final edit: a `manual_note` via
   the `record-evidence` skill, no `ac_id`, starting `smallest-change check:`, naming the
   changed files by file name, what you cut or refused, and why this is the floor. The
   runner reads the MOST RECENT evidence row containing "smallest-change" (so a rework
   records a fresh note for the new diff; on a resume the call is refused, so put the
   note in your final message instead): a missing note is
   flagged for human review (or fails the delivery when the operator requires it), and
   a note that names none of the changed files is flagged as boilerplate. It also flags
   a diff over 12 files or 400 changed lines as oversized for a human to judge; if
   yours is that large, the note must say why it cannot be smaller.

**Done when:** every changed file maps to an AC, no speculative option or abstraction
remains, the suite still passes, and the smallest-change note is recorded.

## Rules

- **NEVER weaken a safety guard to save lines.** The factory's safety hook, repo
  write/read boundaries, secret handling, authorization checks, input validation, error
  handling and locking are guarantees, not bloat. Minimalism removes redundancy, never
  protection.
- Satisfy every acceptance criterion in full: least code, not least scope.
- Tests the ACs need are part of the minimum; never skip one to shrink the diff.
- Match the repo's conventions; minimalism trims your additions, it does not license a
  rewrite of existing code.
- When you decline something real (a dependency, a layer, an option) for minimalism's
  sake, note it: `request_decision` at `log_only` keeps the tradeoff visible.
- **Reviewers:** extra code is a reason for CHANGES only when it carries a concrete
  defect (a bug, untested AC behaviour, a security gap). Otherwise list it as an
  "(optional)" note; size alone never fails a review.
