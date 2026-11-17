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
| `01-settings.sh` | the fourteen settings (spec, strict validation, the `settings.json` loader), `_gaffer_derive`, the old-key migration, the environment-only keys |
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

Order rules a change must keep: `01` runs before every default (the settings are read
and validated there); a setting's table (`_gaffer_derive`) runs at the place in its part
where the values it assigns were defaulted, before anything reads them; a knob defaulted
from another (`: "${B:=$A}"`, or a table value `@A`) stays after `A`; a function called
while the config loads (`gaffer_model_flag`, the autonomy checks in `15`,
`gaffer_git_harden`) is defined above its call; the libs load last. Add a knob to the part
of its area, never a new part for one knob; a new part needs its line in the parts block,
its header and marker (`runner/test/config-parts.test.sh` checks all of it).
`scripts/config-reference.mjs` reads the parts in the block's order.

## The fourteen settings and their tables

A person sets FOURTEEN things (`_GAFFER_SETTINGS_SPEC` in `01-settings.sh`: name, kind,
accepted values, default, one line); `settings.json`, the README and `docs/CONFIG.md`
know only them. Every other knob is derived from exactly one setting by that setting's
table, `_gaffer_derive <SETTING> <<'_GAFFER_TABLE_'`, in the part of its area:

- A row that changes with the setting holds one value per accepted value (spec order),
  and its `: "${NAME:=...}"` line is removed: the table is where the value is written.
  Values: a literal, `""`, `-` (left unset), `@NAME` (another value), `@?NAME` (unset when
  that is empty). `?NAME` keeps an explicit empty value (`=` instead of `:=`).
- A value that does not change keeps its `: "${NAME:=default}"` line (with its trailing
  comment) and gets a `~` row in its setting's table, so the documents and the dashboard
  know which setting it belongs to. A value read where it is used (`EXTRA_KNOBS`) gets a
  `~` row too.
- The rule that cannot bend: with no settings, and with each setting at its default,
  every derived value equals what it was. `runner/test/config-defaults.test.sh` checks the
  real config against `runner/test/fixtures/config-defaults/*.txt` (made by
  `test/lib/config-dump.sh` before the settings existed). A new knob extends the dump by
  itself; a changed default needs the fixture regenerated on purpose, said in the commit.
- A real environment variable for a derived name always wins (the one override, kept for
  good). A non-default preset's values are exported (the mode table is `--no-export`, as
  the mode always was).
- An old `settings.json` key (`_GAFFER_MIGRATION_MAP`: the key, the setting that decides
  it now, how to compare) is ignored with one warning, unless it is stricter than the
  derived value; then it still applies. A new dashboard key is never added there: a new
  person-facing choice is a setting value, not a key.

What the documents list follows from the code. `node scripts/config-reference.mjs` writes
`docs/CONFIG.md` (the fourteen), `docs/CONFIG-ADVANCED.md` (every derived value by setting)
and `runner/config/settings-schema.json` (the same for the dashboard and
`gaffer config show`), and fails when a default line has no setting deciding it, a value
is written in a table and a default line, an old key's setting does not own it, or a lib's
fallback disagrees with the default preset:

- A name the runner derives or sets for a child, a test seam, or a package's own variable
  is not a knob: assign it plainly (`NAME="${NAME:-default}"`) and add it to
  `INTERNAL_NAMES` or `TEST_SEAMS`. The generator fails if a listed name still has a `:=`
  line or no longer occurs in the source. A runner-only file path is better as a
  `_GAFFER_` name, which also keeps it out of the agent env and the re-source record
  (never for a value derived from a setting: a `_GAFFER_` export is not re-derived by a
  child).
- A name only the operator's real environment may set (a credential, the worker
  provider, the sandbox opt-out, the uncapped switch) is in `ENV_ONLY` there and in
  `_GAFFER_ENV_ONLY_KEYS`.
- A family of knobs that only make sense together is one knob (`GAFFER_ROLE_MAX_TURNS`,
  `GAFFER_ROLE_MODELS`, `GAFFER_SANDBOX_LIMITS`, `GAFFER_LITE_MAX_DIFF`). An old name
  replaced by one stays honoured for a release: its reader still reads it after the new
  knob, the config warns with `_gaffer_deprecated` (defined in `01-settings.sh`, so
  every later part can call it; once per process tree), and `DEPRECATED` in the
  generator lists it. `runner/test/config-diet.test.sh` pins each family's default.
