# Audit workstreams — execution tracker

Living checklist for the audit-driven push (Depth 6→7.5, Breadth 8→9, Offering 6.5→8).
Sequenced by bang-for-buck. Updated as the loop makes progress.

## D — Honesty ledger (Offering, cheapest lever) — ~DONE (prior audit pass)
- [x] Cost/ROI dollars labelled "API-equivalent estimate, NOT real charges; killed/timed-out
      calls count $0" (`app.js` cost banner + README web-cost caveat).
- [x] "Improves the longer it runs" softened — README says the factory *learns into* memory
      (factual write), not "measurably improves".
- [x] Sandbox is macOS-only / Linux no-op stated at point of use (README §Safety, SECURITY.md).
- [x] Autonomy is supervised-by-default, hands-off is opt-in (README "You hold the gate").
- [ ] Final sweep: re-grep UI/comments for any residual unqualified claim; gate at point of use.

## A — Hermetic live-path e2e (Depth keystone) — DONE
Gap: `e2e-lifecycle.test.sh` hand-orchestrates the pieces (claim, worktree, stub, gate); it
never drives `tick.sh` → `worker_deliver`. Build a test that runs `DRY_RUN=0 bash tick.sh`
with the `claude -p` spawn replaced by a real stub (writes a file, emits the `{result}`
envelope) so the PRODUCTION path runs: worker_deliver → real worktree → gate on a real diff →
submit → bookkeeping. Done = it would catch the inert-feature cluster.
- [x] `runner/test/e2e-tick-live.test.sh` — drives the REAL worker_deliver seam (env-i claude
      spawn) with a stub agent; 8 checks; green bash 5 + bash 3.2.
- [x] Asserts: worker_deliver ran the agent in the worktree (real committed diff), envelope
      captured, REAL DoD+hygiene gates on the diff, REAL token-gated submit → in_review, claim done.
- [ ] (later) convert grep-of-source "wiring" tests to behavioural over time.

## B — Prove the already-wired differentiators (Breadth) — VERIFY
- [x] B1 spec→decompose: VERIFIED — spec-coverage + spec-clause-provenance tests green (21).
- [x] B2 product-context priming: VERIFIED — product-context-block.test.sh green (drives tick.sh, block non-empty).
- [ ] B3 graduated autonomy (design call): `approved_unchanged` ~always true + MIN_SAMPLES=10
      dormant at solo scale. Pivot the trust signal to one that varies (bounce-free streak /
      approve-without-changes-requested rate); re-scope MIN_SAMPLES (per-risk, cross-repo priors).

## C — Convert fixable "never works" → "works" (Depth + Offering)
- [ ] C1 AFK loop on Linux: ship a systemd/cron/`gaffer run --daemon` unit.
- [ ] C2 LAN QR 403: allow the initial tokenless SPA shell (gate the API, not the shell).
- [ ] C3 budget cap: pre-spawn budget gate + count killed/timed-out calls as an estimate not $0.
- [ ] C4 sandbox on Linux: STRICT_MODE=1 loudly refuses/warns on non-macOS (cheap+honest);
      stretch: real docker provider (later).

## E — Publish gates (binary, before public)
- [x] Email history rewrite (git filter-repo over merged main) — DONE this session.
- [ ] Planning-agent allowlist — swap MultiEdit denylist for `--allowedTools Read Grep Glob`
      (currently the full denylist is the safe closure; allowlist needs MCP-tool handling).

## Hard call — "memory improves over time"
- [x] De-claim now (D): "durable, owned, portable knowledge the agent draws on".
- [ ] Make-real later (post-launch): A/B priming (un-primed control tickets) → real with/without
      memory delta. The only thing that proves the thesis. Not blocking launch.

## Order: D (done) → A (keystone) → B (verify) → C (fixes) → E (allowlist) → B3 + memory-control.
