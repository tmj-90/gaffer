# Crew package — surface audit and dead-code decision

`packages/crew` is 121 files / ~19.5k lines. This audit answers one question: which
of it the factory actually runs. It was produced by following imports from every
entry point the runner and the package `bin`s invoke, and it records the decision
taken so the question is not re-litigated silently.

## What the runner calls

| Entry point | Called from | Status |
| --- | --- | --- |
| `crew init` | `setup.sh`, `demo.sh`, `bin/onboard-run.mjs`, the browser regression | live |
| `crew skills --stack` | `tick.sh` (fallback when `SKILLS` is empty) | live |
| `crew doctor` | `status.sh` | live |
| `crew repo onboard --standalone` | `gaffer onboard`, the dashboard's Onboard button, `lib/greenfield.sh` | live |
| `crew idle` | `tick.sh`, only with `IDLE_DRAFT_WHEN_IDLE=1` (dashboard toggle) | opt-in |
| `crew maintain` | `tick.sh`, only with `GAFFER_MAINTENANCE=1` | opt-in |
| the eight `runtime/**/*Cli.js` | prompt / MCP / context renders, DoD distill, worktree key, hygiene, minimalism, CI parse | live — the **only** implementation since the bash twins were deleted |
| `eval/evalLedgerCli.js`, `eval/deliveryJudgeCli.js` | `gaffer eval`; the judge only with `GAFFER_EVAL_JUDGE=1` | live / opt-in |

Roughly **63 files / 9.8k lines are live by default**; **28 files / 4.7k lines**
(`loops/*`, `ingest/*`, the decomposer adapters) run only through `idle` /
`maintain`, and every individual loop and ingest source is `enabled: false` in the
config template, so on a default factory they are dormant until the dashboard
switches them on.

## What nothing calls

| Reached only via | Files | Lines |
| --- | --- | --- |
| `crew run` (the mock implementation loop) | `loops/implementationLoop.ts`, `safety/postconditions.ts`, `hooks/*` (engine, builtins, types), `context/ticketIntent.ts`, `runtime/agentRuntime.ts` | ~1,500 |
| `crew stats` | `ops/stats.ts` | 148 |
| `crew-mcp` (the package's own MCP server; the delivery agent's `.mcp.json` never lists it) | `mcp/*`, `context/packet.ts`, `context/tokens.ts`, `memory/scopeLore.ts` | ~1,600 |
| `crew safety check` / `crew-mcp` | the TypeScript safety classifier (`commandGuard`, `gitGuard`, `fsGuard`, `rootAccess`, `branchPolicy`, `decision`, `forbiddenActions`) | ~490 |
| tests only | `dispatch/fakeClient.ts`, `runtime/claudeAgentRuntime.ts`, `runtime/context/assembleContext.ts`, the `src/index.ts` barrel | ~1,140 |
| unused subcommands | `repo rescan`, `repo clarify-capture`, `scan`, `ingest` (as a command) | — |

Also: `packages/crew/02-runtime-architecture.md` lists commands that do not exist
(`scan-repos`, `run-loop …`, `validate-config`, `explain-policy`), and the crew
README documents `scan`, `run`, `stats`, `safety check` as user-facing.

## Decision

1. **Keep, as specification and seam:** `runtime/agentRuntime.ts`,
   `runtime/claudeAgentRuntime.ts`, `runtime/wiring.ts`, `context/ticketIntent.ts`,
   `context/packet.ts`. `docs/tick-sh-runtime-migration.md` names them as the P0
   seam for the single-runtime collapse (the typed spawn replacing `worker.sh`),
   and `tick.sh` / `lib/context-primer.sh` cite two of them as the source their
   bash mirrors. They are dead at runtime today and that is stated here; deleting
   them would abandon the documented end state rather than finish it. The collapse
   itself needs a live model credential to trial and is out of scope for this pass.
2. **Keep, as the parity oracle:** the TypeScript safety classifier. The live guard
   is `runner/safety-hook.mjs` + `lib/dangerous-commands.mjs`; the TS port exists so
   `safety-hook-parity.test.ts` and `root-access-parity.test.ts` can prove the two
   agree (the guarantee `docs/AUTOMATION_TESTING_PLAN.md` documents). Deleting it
   deletes the proof.
3. **Keep, opt-in and documented as such:** `loops/*`, `ingest/*`, `crew-mcp`. They
   are advertised product surface (README, ARCHITECTURE) reachable from the
   dashboard's idle-loop toggle or by running the MCP server; dormant is not dead.
4. **Candidates to delete — a product call, not made here:** `crew run` (mock-only
   demo; `runner/CLAUDE.md` already calls it that) with `implementationLoop.ts`,
   `hooks/*` and `postconditions.ts`; `crew stats`; `repo rescan` /
   `clarify-capture`; the `scan` and `ingest` commands. Together ~2,000 lines. They
   are documented as user-facing commands, so removing them changes the advertised
   CLI. Recommended order if approved: retire `crew run` + hooks first (largest,
   least honest — a mock loop presented as a command), then `stats`, then fold
   `rescan`/`clarify-capture` into `repo onboard` flags or drop them.
5. **Fix now:** the two docs that promise non-existent commands
   (`02-runtime-architecture.md`) — corrected in this change.

## Method and caveats

Static import graph over `src/` (type-only imports counted as references), split
per CLI subcommand by what each action calls, not by what `cli/index.ts` loads
(it loads every module on any `crew` call). One dynamic import exists
(`dispatch/realClient.ts` builds the `dispatch` specifier at runtime); no others.
Re-run the audit after any change to `cli/index.ts` or the runner's `fg …` calls.
