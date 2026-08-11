# Epic — collapse the delivery runtime: strangle `tick.sh` into a typed `ClaudeAgentRuntime`

Status: **in progress.** P0/P1a (seam) ✅, P1b (context assembly) ✅, P2 (launch +
parse) ✅ (realised in the runner's own `worker.sh`/`worker.mjs` seam), P3 (DoD
text-processing) ✅, P4 (claim/worktree/submit) — pure-logic helpers seamed, the
orchestration + the single-runtime collapse remain. **Every landed seam is additive
and flag-gated with the bash/awk path as the still-live DEFAULT — no default has
flipped to `ts` yet (that is soak-gated, see below).** Owner: TBD. This is the
[gaffer-v2 master plan](../README.md)'s **Track 4** — the monolith break — and it is
deliberately **last and cautious**.

## Why

`runner/tick.sh` is the live delivery runtime: it claims a ticket, resolves scope,
builds a worktree per write-repo, renders the MCP + prompt, launches `claude -p`,
runs the DoD gates, and submits for review. It is ~3k lines of **safety-critical
bash**. The problem isn't its length — it's the language for *this* job:

- **No types, no unit seams.** The parts that enforce containment (worktree
  isolation, env stripping, the bootstrap install allowance, write-root
  computation, gate outcomes) are the parts a bug turns into a containment breach,
  and they're the hardest to test in bash.
- **Two runtimes, one real.** Crew has an `AgentRuntime` interface whose only
  implementation is `MockAgentRuntime` (the `--dry-run` harness every crew test
  uses). The *live* runtime is `tick.sh → claude -p`. Delivery features that land
  only in the crew mock path never run for the real agent (lore `xa2t2m78`).

So: move the logic that wants types into a typed, unit-tested `ClaudeAgentRuntime`
behind the existing crew seam; leave `tick.sh` as the thin OS/process plumbing bash
is actually good at.

## Non-goals / guardrails

- **Not a rewrite.** `tick.sh` encodes hard-won, production-proven safety behaviour.
  A big-bang port is the single most likely way to *regress security*. Every slice
  is additive-then-cutover behind a flag, with the old path deletable only after the
  new one is regression-green.
- **The safety hook stays at the tool boundary.** The PreToolUse `safety-hook.mjs`
  runs in-process inside `claude -p` regardless of who launches it. Containment must
  never depend on the migration being perfect.
- **Keep the crew mock loop.** It's the dry-run test harness; this epic gives it a
  *second* (real) implementation, it doesn't replace it.
- **`sandbox-exec`/docker launch stays shell-adjacent.** Spawning the sandboxed
  process at the OS boundary is a legitimate bash job; the runtime calls out to it.

## Mechanism — strangler-fig via the `AgentRuntime` seam

1. Define `ClaudeAgentRuntime implements AgentRuntime` in `packages/crew` (or a new
   `packages/runtime`) that owns: prompt+MCP assembly, launching the sandboxed
   `claude -p`, parsing the result envelope (reuse `lib/worker.mjs parseResult`),
   and returning `{resultText, usage, capHit, stopReason}`.
2. `tick.sh` calls the runtime for the phases it has moved, via a single `node`
   entrypoint, and keeps orchestration (claim, worktree add/teardown, gate
   sequencing, submit) until those move too.
3. Each moved slice ships behind `GAFFER_RUNTIME=ts|bash` (default `bash`), flips to
   `ts` only after its slice is regression-green, and the bash path is deleted in a
   *later* commit once `ts` has soaked.

## Phased slices (each = own PR, own tests, own regression gate)

- **P0 — Spike + seam (no behaviour change). ✅ DONE** (`packages/crew/src/runtime/claudeAgentRuntime.ts`).
  Stood up `ClaudeAgentRuntime` behind the crew seam: `parseClaudeEnvelope` (tolerant
  parse of the `claude -p --output-format json` envelope) + `mapEnvelopeToRunResult`
  (the pure bridge where the envelope and `AgentRunResult` contracts meet) + the
  runtime class (maps a captured envelope, injectable like `MockAgentRuntime`). 11
  tests incl. a REAL captured envelope. No `tick.sh` cutover, no live spawn.
  **Finding surfaced for P1:** the seam `run(packet): AgentRunResult` is SYNC — a
  live spawn needs it async (`Promise<AgentRunResult>`), which touches
  `MockAgentRuntime` + the impl-loop caller. That interface change is P1's first job.
- **P1a — Async seam. ✅ DONE.** Made `AgentRuntime.run` return `Promise<AgentRunResult>`
  (a real runtime spawns a process; the mock resolves immediately). Threaded
  `async`/`await` through `runImplementationLoop` (+ its inner + the on_failure
  wrapper) and all callers — the crew CLI (`cli/index.ts`, which was silently about
  to serialize a `Promise` as `{}` — caught + fixed) and 8 test files. crew: 550
  tests green, typecheck + build clean, behaviour unchanged. This unblocks a live
  `ClaudeAgentRuntime.run()` that awaits a `claude -p` spawn.
- **P1b — Context assembly. ✅ DONE.** The three delivery-context renders now have
  golden-tested typed renderers reached through flag-gated bash seams (default bash):
  the delivery/bootstrap **prompt** (`renderPromptCli` ← `deliveryPrompt.ts`, via
  `gaffer_render_delivery_prompt` in `factory.config.sh`), the **`.mcp.json`** runtime
  (`renderMcpCli`, via `gaffer_render_mcp_runtime`), and the **context-primer** file-
  cards + product-context blocks (`renderContextPrimerCli` ← `contextPrimer.ts`, via
  the seams in `lib/context-primer.sh`). Each is proven byte-identical to the bash by
  a `*-parity` test driving BOTH runtimes + a `capture-context-golden.sh` real-tick
  zero-diff under bash AND ts. `GAFFER_RUNTIME=ts` selects the typed path.
- **P2 — Launch + parse. ✅ DONE** (realised in the runner's own seam, not the crew
  runtime). The single `claude -p` spawn lives in `worker_deliver` (`lib/worker.sh`,
  with `GAFFER_WORKER_PROVIDER` dispatch — `claude-code` real + fail-closed stubs) and
  the `--output-format json` result parse lives in `lib/worker.mjs`'s `parseResult`
  (the bash cap/spend guards call its `parse-result` CLI; `usage-ledger.mjs` imports
  the same extractors). The crew `ClaudeAgentRuntime` is the P0 typed BRIDGE (maps a
  pre-captured envelope); wiring it as the live spawn — retiring `worker.sh`'s spawn —
  is the single-runtime collapse below.
- **P3 — DoD gate orchestration. ✅ DONE (text-processing).** The DoD output/verdict
  helpers are typed behind `dodDistillCli` (`GAFFER_DOD_DISTILL=ts`): `distillOutput`,
  `extractFailure`, `summarizeGates`, `executedCount` — each byte-identical to the awk
  (`dod-distill-parity.test.sh`). The gate **sequencer** (`gaffer_run_dod_gates` /
  `gaffer_dod_run_one`) stays in bash **by design** — it spawns the gate commands next
  to the in-process safety hook; only its pure logic was portable.
- **P4 — Claim/worktree/submit orchestration. 🚧 IN PROGRESS.** The pure-logic helpers
  in the claim→worktree→submit path are seamed behind `GAFFER_RUNTIME=ts` (default
  bash), each byte-identical to the bash via a `*-parity` test that drives BOTH
  runtimes: the **worktree-leaf** derivation (`worktreeKey`), the delivery-hygiene
  **forbidden-path** policy (`forbiddenPath`, a batch scan), the **minimalism**
  post-condition (`checkMinimalism`) + its **diff-stats** input (`diffStats`), and the
  **CI-gate** check-status verdict (`parseChecks`). The orchestration proper — the
  claim/worktree add+teardown and submit bookkeeping (git/process side-effects) — and
  the collapse below remain. `tick.sh` shrinks to pick-ticket → env/sandbox → hand off
  → tear down only once those move.

### Landed typed seams (all default-bash, flag-gated, byte-identical)

| Live bash | Typed module + CLI | Flag |
|---|---|---|
| `gaffer_render_delivery_prompt` | `deliveryPrompt.ts` / `renderPromptCli` | `GAFFER_RUNTIME=ts` |
| `gaffer_render_mcp_runtime` | `mcpConfig.ts` / `renderMcpCli` | `GAFFER_RUNTIME=ts` |
| `gaffer_prime_context_block` / `gaffer_product_context_block` | `contextPrimer.ts` / `renderContextPrimerCli` | `GAFFER_RUNTIME=ts` |
| `gaffer_dod_distill_output` / `_extract_failure` / `_summary_line` / `_executed_count` | `dod/*.ts` / `dodDistillCli` | `GAFFER_DOD_DISTILL=ts` |
| worktree-leaf (`tick.sh` WT_ROWS loop) | `worktree/worktreeKey.ts` / `worktreeKeyCli` | `GAFFER_RUNTIME=ts` |
| `gaffer_assert_clean_delivery` forbidden-path scan | `hygiene/forbiddenPath.ts` / `hygieneCli` | `GAFFER_RUNTIME=ts` |
| `gaffer_check_minimalism` / `gaffer_diff_stats` | `minimalism/*.ts` / `minimalismCli` | `GAFFER_RUNTIME=ts` |
| `gaffer_parse_checks` | `ci/parseChecks.ts` / `ciGateCli` | `GAFFER_RUNTIME=ts` |

**The default flip (`bash/awk → ts`) has NOT happened for any seam** — per the
strangler discipline the defaults flip only after `ts` has soaked green in a real
autonomous trial, in separate commits, and the bash is deleted later still.

## Regression gate (every slice)

- The full end-to-end regression (onboarded path → done+merged; greenfield 3-phase
  epic → done; docker containment red-team) must stay green **with `GAFFER_RUNTIME`
  in both `bash` and `ts`** for the slice under test.
- New typed code carries unit tests + a negative control (a deliberately-broken
  fixture that must fail closed).
- No slice merges until its bash and ts paths produce identical delivery artifacts
  on the fixture suite.

## True single-runtime collapse (the end state, separate from this epic)

Once P0–P4 land and soak, `MockAgentRuntime` and `ClaudeAgentRuntime` are the two
implementations of one seam, the live path is typed and tested, and `tick.sh` is
thin process/sandbox plumbing. Deleting the last bash delivery branch is its own
final, cautious PR gated on a clean autonomous trial — **not** part of the initial
cutover.
