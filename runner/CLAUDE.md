# runner/: maintainer guide

This directory is the **LIVE production agent runtime**. `tick.sh` drives one
delivery/review/clarify tick by shelling out to `claude -p`; `lib/*` assembles
the context the agent receives and runs the delivery gates. The safety layer is
`safety-hook.mjs` with its rules in `safety-hook-core.mjs`, `lib/hook/` and
`lib/dangerous-commands.mjs`: never weaken any of them.

## Where the tick lives: `tick.sh` and `lib/tick-*.sh`

`tick.sh` is orchestration only. It sources the config and every phase lib (a missing
or unloadable one stops the tick before any work, `TICK_RESULT=setup_error`), keeps the
up-front safety check (`gaffer_assert_safety_hook`), the exit and signal traps, `log`
and `result`, and calls the phases in order. The phase bodies were moved out verbatim
and read and write the tick's globals (`NUM`, `SHOW`, `WT_ROWS`, `CLAIM_TOKEN`, ...);
the `gaffer_tick_*` wrappers declare no locals.

| File | Phase |
|---|---|
| `lib/tick-helpers.sh` | the deadline clock, the locked skip / marker appends, the dry-run preview list, `gaffer_abort_setup` |
| `lib/tick-recovery.sh` | the orphaned-agent reap, `gaffer_crash_cleanup` (what the traps run), `gaffer_resume_abort`, resume-begin |
| `lib/tick-claim.sh` | setup and spend admission, agent registration, the candidate scan and claim, the bootstrap / acceptance classification, scope and skills, the self-operation ban, the worktree plan |
| `lib/tick-bootstrap.sh` | the greenfield create-a-repo delivery |
| `lib/tick-launch.sh` | workspace trust, the raw prompt inputs, model routing and the dry-run preview, worktree creation, the agent env and MCP runtime, one attempt's launch through the worker seam |
| `lib/tick-gates.sh` | claim release and park, the no-commit counter, the budget gate, the submit, the GUARD B attempt loop and its gates |
| `lib/tick-close.sh` | the submit and delivery records, the PR / CI gate, the replay manifest, recall feedback, the intent distillation, the tester route |
| `lib/tick-idle.sh` | the feature-backlog planner, the maintenance lane, the idle draft scan |

A tick feature goes in the lib of its phase. A new phase lib is sourced in `tick.sh` with
the same fail-closed guard and a `# shellcheck source=` line
(`runner/test/tick-phase-libs.test.sh` and `tick-dead-assignments.test.sh` check both).

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

> **Any new production delivery feature (orchestration, gates, the ticket
> close path, or which inputs the agent receives) MUST land in
> `runner/tick.sh` / `runner/lib`.** Text the agent reads (prompt, primer
> blocks, MCP config) is edited in `packages/crew/src/runtime/context/*`, which
> IS live. The crew implementation loop is a future seam; a feature added *only*
> there silently misses the live agent.

This is not hypothetical: the product-context injection (`productContext`) and the
ticket→lore distiller were originally wired **only** into the crew mock loop, so
they never ran for the live agent until they were backported here. If you add a
delivery-facing capability to the crew mock loop, either wire it into the live
path in the same change or leave a `TODO` referencing this rule: until a real
`ClaudeAgentRuntime` replaces `MockAgentRuntime`, mock-loop changes alone do not
reach production. The reverse mistake is just as easy: a copy of prompt text in
`tick.sh` is never read (`runner/test/prompt-quarantine.test.sh` and
`product-context-block.test.sh` fail if one comes back), and
`runner/test/tick-dead-assignments.test.sh` fails on any variable `tick.sh`
assigns but never reads.

New context/close-path features should be **additive and fail-soft**: an absent
or erroring dependency (e.g. the memory CLI) must never block a delivery that has
otherwise passed its gates.
