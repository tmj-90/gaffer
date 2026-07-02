# runner/ — maintainer guide

This directory is the **LIVE production agent runtime**. `tick.sh` drives one
delivery/review/clarify tick by shelling out to `claude -p`; `lib/*` assembles
the context the agent receives and runs the delivery gates. The safety layer is
`safety-hook.mjs` — never weaken it.

## RULE: production delivery features must land here (not only in crew)

Gaffer has **two** agent runtimes, and only one of them is live:

| Runtime | Location | Status |
|---|---|---|
| **Live agent** | `runner/tick.sh` → `claude -p`, context in `runner/lib/*` | **Production.** This is what actually delivers tickets. |
| Crew implementation loop | `packages/crew/src/loops/implementationLoop.ts` | **Mock-only.** Runs `MockAgentRuntime`; a FUTURE seam + the `--dry-run` test harness. It invokes NO real agent and writes NO files. |

Therefore:

> **Any new production delivery feature — context/prompt assembly, the ticket
> close path, or what the agent actually receives — MUST land in
> `runner/tick.sh` / `runner/lib`.** The crew implementation loop is a future
> seam; a feature added *only* there silently misses the live agent.

This is not hypothetical: Track 1c's `productContext` injection and the
ticket→lore distiller were originally wired **only** into the crew mock loop, so
they never ran for the live agent until they were backported here. If you add a
delivery-facing capability to crew, either backport it to `runner/tick.sh` in the
same change or leave a `TODO` referencing this rule — until a real
`ClaudeAgentRuntime` replaces `MockAgentRuntime`, crew changes alone do not reach
production.

New context/close-path features should be **additive and fail-soft**: an absent
or erroring dependency (e.g. the memory CLI) must never block a delivery that has
otherwise passed its gates.
