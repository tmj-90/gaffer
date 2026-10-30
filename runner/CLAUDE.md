# runner/ — maintainer guide

This directory is the **LIVE production agent runtime**. `tick.sh` drives one
delivery/review/clarify tick by shelling out to `claude -p`; `lib/*` assembles
the context the agent receives and runs the delivery gates. The safety layer is
`safety-hook.mjs` — never weaken it.

## RULE: production delivery features must land on the live path (not only in crew's mock loop)

Gaffer has **two** agent runtimes, and only one of them is live. Separately,
some crew modules are not a runtime at all but **live render seams** that the
runner shells out to:

| Code | Location | Status |
|---|---|---|
| **Live agent** | `runner/tick.sh` → `claude -p`; orchestration, gates and the close path in `runner/lib/*` | **Production.** This is what actually delivers tickets. |
| **Prompt / context-primer / MCP render text** | `packages/crew/src/runtime/context/*`, run through `renderPromptCli.js`, `renderContextPrimerCli.js` and `renderMcpCli.js` (called by `gaffer_render_delivery_prompt`, `gaffer_render_mcp_runtime` and `lib/context-primer.sh`) | **LIVE.** Rebuild crew's dist after editing; the runner fails closed without it. `tick.sh` only gathers the raw inputs (`TITLE`, `_RF`, `WT_ROWS`, the context blocks); the wording, the quarantine envelopes and the lore-reflection nudge live in `deliveryPrompt.ts`. |
| Crew implementation loop | `packages/crew/src/loops/implementationLoop.ts` | **Mock-only.** Runs `MockAgentRuntime`; a FUTURE seam + the `--dry-run` test harness. It invokes NO real agent and writes NO files. |

Therefore:

> **Any new production delivery feature — orchestration, gates, the ticket
> close path, or which inputs the agent receives — MUST land in
> `runner/tick.sh` / `runner/lib`.** Text the agent reads (prompt, primer
> blocks, MCP config) is edited in `packages/crew/src/runtime/context/*`, which
> IS live. The crew implementation loop is a future seam; a feature added *only*
> there silently misses the live agent.

This is not hypothetical: Track 1c's `productContext` injection and the
ticket→lore distiller were originally wired **only** into the crew mock loop, so
they never ran for the live agent until they were backported here. If you add a
delivery-facing capability to the crew mock loop, either wire it into the live
path in the same change or leave a `TODO` referencing this rule — until a real
`ClaudeAgentRuntime` replaces `MockAgentRuntime`, mock-loop changes alone do not
reach production. The reverse mistake is just as easy: a copy of prompt text in
`tick.sh` is never read (`runner/test/prompt-quarantine.test.sh` and
`product-context-block.test.sh` fail if one comes back), and
`runner/test/tick-dead-assignments.test.sh` fails on any variable `tick.sh`
assigns but never reads.

New context/close-path features should be **additive and fail-soft**: an absent
or erroring dependency (e.g. the memory CLI) must never block a delivery that has
otherwise passed its gates.
