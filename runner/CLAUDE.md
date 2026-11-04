# runner/: maintainer guide

This directory is the **LIVE production agent runtime**. `tick.sh` drives one
delivery/review/clarify tick by shelling out to `claude -p`; `lib/*` assembles
the context the agent receives and runs the delivery gates. The safety layer is
`safety-hook.mjs` with its rules in `safety-hook-core.mjs`, `lib/hook/` and
`lib/dangerous-commands.mjs`: never weaken any of them.

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

## The config: `factory.config.sh` and `runner/config/`

`factory.config.sh` is what every script sources (the parent and again every child).
It keeps, in place, the prologue (the operator's environment, the strict
`settings.json` read, the re-source unset-and-rederive step, `RUNNER_DIR` /
`GAFFER_HOME` / `GAFFER_DATA`) and the `_GAFFER_DV_` record block at the end. Between
them it sources `runner/config/NN-area.sh` in a fixed order, and stops the process
(fail closed) when a part is missing or did not load to its last line, its marker
`_GAFFER_CONFIG_PART=NN-area`. A part is never sourced on its own: it reads what the
parts before it set, so the order is the old top-to-bottom order of the one file.

| Part | Holds |
|---|---|
| `01-settings.sh` | `settings.json` values applied as defaults (env wins); the environment-only keys |
| `02-paths.sh` | product locations, databases, memory audit log, code index, ledger reader |
| `03-wiring.sh` | the agent CLI wiring; the worker provider knobs |
| `04-models.sh` | plan / implement models, `*_EXPLICIT`, `gaffer_model_flag`, the router registry |
| `05-budget.sh` | USD ceiling, per-call cap, live headroom, low-budget threshold, cheap phases |
| `06-routing.sh` | `gaffer_route_model` and its record; the planning debate |
| `07-limits.sh` | timeouts and turn caps, DoD gate knobs, sandbox resources, daemon, attempts, claim TTL, outer bound, rework bounds |
| `08-guards.sh` | per-ticket spend helpers, ask / pause on cap, usage pause, dashboard URL, reap grace |
| `09-render.sh` | `gaffer_timeout`, sed escaping, MCP and prompt render helpers |
| `10-locks.sh` | `gaffer_with_lock` and the lock helpers |
| `11-agent-env.sh` | `gaffer_agent_env` and the provider env pass-through |
| `12-identity.sh` | `DISPATCH_*_CMD`, the factory agent's name, id files and log |
| `13-stop.sh` | self-operation ban, `DRY_RUN`, tick and day caps, concurrency |
| `14-usage.sh` | usage ledger, killed-call estimate, `gaffer_usage_record` and friends |
| `15-modes.sh` | `GAFFER_MODE` presets, autonomy requires containment, review / merge / push flags |
| `16-sandbox.sh` | strict mode and the sandbox provider; hygiene, minimalism, greenfield, backpressure |
| `17-cli.sh` | `wg` / `fg` / `lg`, the DB-var guard, the JSON helpers |
| `18-review.sh` | resume report, ship plan, lite classifier, security second opinion, reviewer verdict |
| `19-libs.sh` | the `runner/lib/*.sh` helper libs (sandbox, worker, budget, ...) |
| `20-gates.sh` | idle-lane knobs, PR creation, CI gate, eval judge, experiments, review rules, their libs, git hardening |

Order rules a change must keep: `01` runs before every default (env, then
`settings.json`, then the mode, then the default); the `GAFFER_MODE` arms in `15` fill
before the plain defaults after them; a knob defaulted from another (`: "${B:=$A}"`)
stays after `A`; a function called while the config loads (`gaffer_model_flag`, the
autonomy checks in `15`, `gaffer_git_harden`) is defined above its call; the libs load
last. Add a knob to the part of its area, never a new part for one knob; a new part
needs its line in the parts block, its header and marker
(`runner/test/config-parts.test.sh` checks all of it).
`scripts/config-reference.mjs` reads the parts in the block's order.
