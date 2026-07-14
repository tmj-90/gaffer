# Epic — collapse the delivery runtime: strangle `tick.sh` into a typed `ClaudeAgentRuntime`

Status: **proposed** (not started). Owner: TBD. Gated behind: bookkeeping stable
(done — runner-owned-bookkeeping landed) + a green end-to-end regression harness
(exists). This is the [gaffer-v2 master plan](../README.md)'s **Track 4** — the
monolith break — and it is deliberately **last and cautious**.

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
- **P1 — Context assembly.** Move prompt + `.mcp.json` render + context-primer
  packet (`lib/context-primer.mjs` is already node) into the runtime. Golden-file
  test: the rendered prompt/MCP for a fixture ticket is identical to today's.
- **P2 — Launch + parse.** Move the `claude -p` spawn + result parse behind the
  runtime, still launched inside the existing sandbox provider. `tick.sh` calls it
  and consumes the structured result. Flag-gated; bash path kept.
- **P3 — DoD gate orchestration.** Move gate sequencing (`lib/dod.sh` logic) into
  typed code with per-gate unit tests; `tick.sh` invokes and renders.
- **P4 — Claim/worktree/submit orchestration.** The last and most safety-sensitive
  slice. Move claim→worktree→submit bookkeeping; `tick.sh` shrinks to: pick the
  ticket, set up env/sandbox, hand off to the runtime, tear down. Delete the
  superseded bash once `ts` has soaked a full autonomous trial.

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
