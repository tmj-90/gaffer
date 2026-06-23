---
name: minimalism
description: Use to deliver the simplest, shortest solution that fully satisfies the ticket — fewer tokens and less code per delivery, without ever weakening a safety guard. Invoke whenever you are about to implement a claimed ticket and want to resist over-engineering, or for "keep it minimal", "don't over-build this", "smallest change that works". A cross-cutting lens that composes with any implementation skill; supports intensity lite | full | ultra (default full).
stack: []
area: quality
---

# Minimalism — least code that fully works

Modelled on [ponytail](https://github.com/DietrichGebert/ponytail), which measures
~54% less code while keeping every safety property. The goal is the *smallest correct
delivery*: fewer tokens, less code, fewer moving parts — never fewer guarantees. You
still satisfy every acceptance criterion in full; you just refuse the scope, layers,
and abstractions the ticket didn't ask for.

This is a lens, not a stage. Apply it while you implement (alongside `plan-change` and
whatever build skill the ticket needs), and confirm it in `self-review` before submitting.

## The four questions (ask in order, stop at the first that resolves it)

1. **YAGNI — does this need to exist at all?** Question the task before writing it.
   Delete speculative code paths, config knobs, options, and "future-proofing" nobody
   asked for. The cheapest line is the one you don't write. If a whole file/class/flag
   isn't required by an AC, it isn't in scope.
2. **Standard library before custom code.** Reach for what the language already ships
   (built-in collections, string/date/JSON utilities, iterators) before hand-rolling it.
   Don't reimplement what `Array`/`Map`/`itertools`/`stdlib` already does correctly.
3. **Native platform features before a new dependency.** Prefer what the runtime,
   framework, or browser already provides over adding a package. A new dependency is
   debt (supply chain, CVEs, build weight) and in this factory needs human approval
   anyway — flag it via `mark_ticket_blocked` rather than reaching for it reflexively.
4. **One line before fifty.** Favour the direct expression over the elaborate one:
   composition over a new class hierarchy, a function over a framework, a literal over a
   config system. Optimise for clarity and least surface area, not cleverness.

## Intensity levels

Default is **full**. Pick the level the ticket's risk and ambiguity justify.

- **lite** — gentle nudge. Avoid obvious over-engineering and dead options; otherwise
  follow the repo's prevailing style even when it's verbose. Use for high-risk or
  unfamiliar code where matching convention matters more than trimming lines.
- **full** *(default)* — actively apply all four questions. Drop every layer, option,
  and abstraction not demanded by an AC. Prefer stdlib/native and the shortest correct
  form. This is the standard delivery posture.
- **ultra** — ruthless. Justify the existence of every file, dependency, and public
  symbol you add; collapse anything that can be collapsed without losing correctness or
  clarity. Use when the ticket explicitly asks for the most minimal possible change.

## Rules

- **NEVER weaken a safety guard to save lines.** The factory's `safety-hook.mjs`,
  repo write/read boundaries, secret handling, authorization checks, and input
  validation are not "extra code" — they are guarantees. Minimalism removes
  *redundancy*, never *protection*. If shrinking code would drop a check, don't.
- Satisfy every acceptance criterion in full — minimal means *least code*, not *least
  scope*. Don't cut a requirement to look smaller.
- Don't sacrifice readability for raw character count: a clear short solution beats a
  cryptic shorter one. Self-documenting beats golfed.
- Still write the tests the ticket needs — test code is a guarantee, not bloat.
- Match the repo's existing conventions; minimalism trims *your additions*, it doesn't
  license a repo-wide rewrite or scope creep.
- When you decline to add something (a dependency, a layer, an option) for minimalism's
  sake and it was a real call, note it — `request_decision` at `log_only` keeps the
  tradeoff visible.
