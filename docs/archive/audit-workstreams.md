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
- [x] C1 AFK daemon: `gaffer run [--daemon]` (lib/daemon.sh gaffer_run_daemon) re-runs loop.sh
      every --interval s on ANY platform, honours MAX_TICKS_PER_DAY, SIGINT/SIGTERM finishes the
      current pass then exits. gaffer-run-daemon.test.sh (6, bash 3.2). quickstart updated.
- [ ] C2 LAN QR 403: allow the initial tokenless SPA shell (gate the API, not the shell).
- [x] C3a pre-spawn budget gate: gaffer_budget_exhausted() parks BEFORE a spawn when cumulative
      spend >= the effective ceiling (per-ticket delivery_budget_usd wins over GAFFER_REWORK_BUDGET_USD);
      closes the cross-run gap the post-attempt bound couldn't. prespawn-budget-gate.test.sh (8, bash 3.2).
- [ ] C3b: count killed/timed-out (unknown-cost) calls as an estimate not $0 in the spend total
      (gaffer_ticket_rework_spend sums MEASURED only, so a repeatedly-killed runaway never accrues) — follow-up.
- [x] C4 sandbox on Linux: GAFFER_STRICT_REQUIRE=1 makes sandbox_wrap_cmd FAIL CLOSED on every
      no-OS-sandbox path (none/missing sandbox-exec/docker/unknown); tick.sh refuses to launch the
      agent (parks strict_require_unavailable). Default still warns+degrades. strict-require.test.sh
      (8, bash 3.2). Stretch: real docker provider (later).

## E — Publish gates (binary, before public)
- [x] Email history rewrite (git filter-repo over merged main) — DONE this session.
- [ ] Planning-agent allowlist — swap MultiEdit denylist for `--allowedTools Read Grep Glob`
      (currently the full denylist is the safe closure; allowlist needs MCP-tool handling).

## Hard call — "memory improves over time"
- [x] De-claim now (D): "durable, owned, portable knowledge the agent draws on".
- [ ] Make-real later (post-launch): A/B priming (un-primed control tickets) → real with/without
      memory delta. The only thing that proves the thesis. Not blocking launch.

## Order: D → A → B → C → E → B3. ALL DONE (deferred: C3b, B3 first-pass, memory make-real).

---

## B3 — autonomy signal redesign (DESIGN NOTE)

**Problem (from the audit re-scan).** The graduated-autonomy recommendation engine
(`packages/dispatch/src/services/autonomyRecommendationService.ts`) is effectively inert
at solo volume, for two reasons:
1. **MIN_SAMPLES=10 dormant.** Buckets are keyed **per-repo × per-risk** (`computeRecommendations`,
   `${row.repoId} ${row.riskLevel}`). A solo operator never accrues 10 ground-truth decisions
   in ANY single repo×risk bucket, so no bucket clears the floor → the engine never fires.
2. **`approved_unchanged` ~always true.** The merge gate rests on the unchanged rate, but
   there is no reviewer-edit-before-merge path, so every approval is "unchanged" → the signal
   is degenerate (doesn't vary) and can't discriminate.

**Decided approach.**
- **Cross-repo per-risk prior (fixes dormancy).** In addition to per-repo×risk buckets, fold
  the same ground-truth rows into a **per-RISK** bucket aggregated across all repos. Emit a
  lower-confidence "cross-repo prior" (`repoId="*"`, "across all repos", confidence ×0.8) for a
  (risk × gate) that clears MIN_SAMPLES at the risk level but did NOT already fire with stronger
  same-repo evidence. This is the "re-scope MIN_SAMPLES to per-risk / cross-repo prior" the plan
  names — same-repo evidence still wins; the prior only fills the solo-scale gap.
- **Honest merge gate.** Require the merge gate to clear BOTH the unchanged rate AND the REAL,
  varying approve-vs-reject **agreement rate** (`approvals/total`), so a degenerate unchanged=100%
  cannot alone grant auto-merge. (The agreement rate == "approve-without-changes-requested rate";
  it genuinely varies at solo scale because rejections happen.)
- **First-pass / bounce-free rate (follow-up).** The strongest future signal — approvals NOT
  preceded by a rejection of the *same ticket* — needs `ticket_id` + ordering added to
  `ReviewDecisionRow` and its query (today it carries neither). Tracked as a follow-up, not this pass.

**Test plan.** Extend `autonomy-recommendation.test.ts`: (a) 10 low-risk decisions spread over 3
repos (no single repo at 10) now yield a cross-repo prior; (b) a strong same-repo bucket
suppresses the redundant cross-repo prior for that risk; (c) a merge bucket with unchanged=100%
but agreement < threshold does NOT recommend merge.

**Status: DONE** — cross-repo per-risk prior implemented (autonomyRecommendationService.ts); 3 tests added (fires at solo volume, weaker than same-repo, suppressed when same-repo fires); 19 total. First-pass/bounce-free rate remains the documented follow-up (needs ticket_id+ordering on ReviewDecisionRow).

---

## PR summary — feat/audit-workstreams

Executes the audit-driven push (Depth 6→7.5, Breadth 8→9, Offering 6.5→8) as a sequenced set
of small, tested commits. All work is on `feat/audit-workstreams`; every change is green under
bash 5 + bash 3.2 and the dispatch suite (1225).

**A — hermetic live-path e2e (keystone).** `e2e-tick-live.test.sh` drives the REAL
`worker_deliver` seam (the production `env -i $CLAUDE_BIN -p …` spawn) with a stub-but-real
agent, then the real DoD+hygiene gates on the real diff and the real token-gated submit. No
prior test drove the production worker path — this closes the "tested-but-not-real" gap.

**C — fixable "never works" → works.**
- C2 LAN-QR: serve the static SPA shell before the DNS-rebinding Host-check (public, no data), so
  a phone's first LAN load isn't a 403; API stays Host+token gated (negative-control test).
- C3a pre-spawn budget gate: park before burning a turn once cumulative spend ≥ the ceiling.
- C4 `GAFFER_STRICT_REQUIRE=1`: fail closed when no OS sandbox is available (honest on Linux).
- C1 `gaffer run --daemon`: portable AFK loop (re-run loop.sh, honour the day cap, graceful stop)
  so the factory keeps working unattended on Linux, not just macOS.

**B — differentiators.** B1 (spec→decompose) + B2 (product-context priming) verified green.
B3: cross-repo per-risk prior so the autonomy engine isn't dormant at solo volume (same-repo
evidence still wins; the prior is weaker + suppressed when same-repo fires).

**D — honesty ledger.** Confirmed already softened in the prior pass (API-equiv cost caveat,
"learns into" not "improves", macOS-only sandbox, supervised-by-default).

**E — allowlist decision.** Documented in SECURITY.md: keep the complete write/exec denylist for
the read-only planning agents (they connect MCP; an allowlist would sever it).

**Deferred (documented follow-ups):** C3b (attribute an estimate to killed/timed-out calls);
B3 first-pass/bounce-free rate (needs ticket_id+ordering on ReviewDecisionRow); the memory
"improves over time" make-real (A/B priming, post-launch).

**New tests:** e2e-tick-live, prespawn-budget-gate, strict-require, gaffer-run-daemon (bash);
+3 autonomy cross-repo, +3 host-check LAN-QR (dispatch). Full runner bash suite (75) green.
