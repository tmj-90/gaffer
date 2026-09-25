# Finishing specs — build queue (after Spec-Driven Development)

Build order (cheapest/compounding first). Each = own phased build with tests baked in (vitest unit
+ hermetic behavioral runner tests vs real CLI + temp DB + real git + **negative control in every
suite** + E2E; never weaken the safety hook). All on `feat/ui-redesign-terminal` per operator
("do on same branch, loop until all done"). Decisions below are **locked to the recommended pick**.

---

## Spec 1 — Factory Health / ROI Surface  (FIRST — ~90% synthesis over data already collected)
Raw signals all exist; only epic-granularity cost rollup is missing. Read model + endpoint + view.

**Phase 1 — aggregator + endpoint.**
- New `packages/dispatch/src/health/healthAggregator.ts` — mirror `cost/costAggregator.ts` (reuse `readLedgerRows`/`resolveLedgerPath`) but KEEP the fields cost drops: cost-per-shipped (total_usd ÷ delivered-since-done), spend-by-kind, token mix (input/output/cache per model), **measured-vs-unknown coverage %** (the invisible honesty gap), daily spend series, cost-of-rework (rework_attempts × ticket cost), duration/latency.
- `GET /api/health` in `server.ts` right after the `/api/cost` block (~:1885) — same GET-guard→resolver→sendJson capped-list pattern.
- Fix the double-definition: cycle-time/throughput computed twice today (server `boardService.cycleTimeByState` vs client recompute in `renderOverview`). Make `/api/health` the ONE authoritative server-side definition; Overview reads it.
- Tests: vitest unit on healthAggregator (zero-state, all-unknown ledger, mixed measured/unmeasured, cost-per-shipped with zero shipped = no div-by-zero, negative control = a row that must not count); `api-health.test.ts` (model `api-cost.test.ts`).

**Phase 2 — view + the two orphaned data sources.**
- `renderHealth` in app.js, registered in VIEWS/NAV, reusing `kpiCard`+`svgSpark` (bento match): ROI KPI row (Cost/feature, Hit-rate, Spend-by-kind, Rework-cost share, Measured-coverage %).
- Wire two DEAD sources: small `skillsTelemetryAggregator` (JSONL reader) for selected-vs-applied skill hit-rate (skills-telemetry.jsonl has zero consumers); a memory CLI read verb via `memoryReader.ts` for recall-effectiveness trend (graceful `available:false` when memory DB absent — memory pkg is standalone).
- Tests: `web-health-view.test.ts` (model `web-settings-view.test.ts`); behavioral test for the memory read verb vs temp memory DB; skill-telemetry aggregator unit.
- **DECISION (locked): DEFER epic-level "cost per feature"** — ticket-level ROI ships now; spec-driven gives the feature grain for free later.

---

## Spec 2 — Graduated Autonomy  (SECOND — consumes Spec 1's agreement stats)
Binary autonomy flags → per-repo, per-risk recommendations backed by track record. Agreement data
exists in `work_events` `ticket.transitioned` (payload.to + reason + actor_type), bucketable by
`tickets.risk_level` + `ticket_repos`. Copy `SuggestionService` (recommend-with-confidence, never
auto-enforce). Two gaps: no "approved unchanged vs edited" signal; flat settings.json can't hold
per-repo×per-risk.

**Phase 1 — capture the missing signal (first; backfills over time).**
- Add `approved_unchanged` at approve time in `reviewGateService.approveReview` (~:118): compare recorded delivery SHA vs merge SHA (both tracked). Emit on the transition payload. Without it the recommendation overstates.
- Tests: unit on approveReview recording unchanged-vs-edited (both cases); negative control = an edited delivery must NOT count as unchanged.

**Phase 2 — recommendation service (read-only, advisory).**
- New `autonomyRecommendationService.ts` (model `SuggestionService`): EventRepository-style join → per-repo/per-risk agreement + unchanged rates → `{recommendation, confidence, reasons[]}`, never auto-applies. Surface in Settings next to `autonomyDial` (app.js ~:4280): "approved 38/40 low-risk in api-repo unchanged — enable auto-merge for risk=low here?"
- Tests: unit on rate computation (zero-sample→no rec; MIN_SAMPLES discipline from estimate.mjs), threshold boundaries, negative control (repo below threshold → no rec).

**Phase 3 — graduated storage + enforcement.**
- New `autonomy_policy` table (repo_id, risk_level, gate ∈ {approve,merge,memory}, mode ∈ {off,recommend,auto}, enabled_by, enabled_at, evidence_json). Bump SCHEMA_VERSION + repository.
- Enforce at the ONE chokepoint: replace raw `process.env.DISPATCH_ALLOW_AGENT_APPROVE === "1"` in `reviewGateService.ts:121` with a per-repo/per-risk policy lookup that **falls back to the global env flag** (no regression). Same for merge trigger (`server.ts:1136`), optionally MEMORY_AUTO_APPROVE later. Store evidence snapshot per enablement (reversible: flip row to off). Preserve the reviewGateService security-invariant comment block.
- Tests: unit on policy lookup + env fallback (no regression when no row); behavioral E2E (auto policy risk=low lets agent-approve through, risk=high still blocks; flip to off re-gates).
- **DECISION (locked): enablement = EXPLICIT CONFIRM with the evidence shown** (trust boundary; matches supervised-by-default).

---

## Spec 3 — Worker Abstraction Seam  (THIRD — strategic refactor; ships the SEAM, not a 2nd worker)
Six open-coded `claude -p` sites (4 in tick.sh, 2 in .mjs) share one argv shape. Mirror `sandbox.sh`
provider-dispatch. Load-bearing risk: the PreToolUse safety hook is Claude-Code-native — a non-Claude
worker has NO in-process containment, gated on the OS-sandbox provider (today a macOS-only stub).

**Phase 1 — consolidate invocation (zero behavior change).** Collapse the 4 tick.sh sites into one `worker_deliver()` bash fn; collapse decompose.mjs + product-owner-run.mjs onto a `Worker.deliver` mjs export. Interface `{prompt, model, env, mcpConfig, cwd, timeout, maxTurns} → {resultText, usage, capHit, stopReason, rc}`. Tests: existing delivery/decompose/e2e suites stay green UNCHANGED (correctness proof for a pure refactor) + a unit asserting all sites route through the one fn.

**Phase 2 — extract the result parser.** Move all Claude-JSON-schema knowledge (scattered across usage-ledger.mjs, delivery-recovery.sh, run-summary.sh, factory.config.sh) behind one `parseResult()` seam owned by the worker (deepest coupling, highest-value). Tests: unit vs real Claude JSON fixtures (measured + unknown + cap-hit + error envelopes) = behavioral parity.

**Phase 3 — provider dispatch (one real impl, honest stubs).** `worker_deliver` dispatches on `GAFFER_WORKER_PROVIDER` (default `claude-code`) like sandbox.sh on SANDBOX_PROVIDER; codex/local are honest stubs that FAIL CLOSED ("not yet supported; safety-hook containment unavailable"). Parameterize `gaffer_agent_env` allowlist + model-flag emission (already registry-indirected). State the containment tension in SECURITY.md (non-Claude worker = no PreToolUse hook → can't run unattended at same posture until a real OS-sandbox provider exists). Tests: stub fails closed (behavioral); provider=claude-code byte-identical to today; parity test the safety-hook precondition still hard-gates the Claude path.
- **DECISION (locked): SEAM ONLY** — sandbox provider is a separable follow-on; the seam has value alone (the positioning answer to "just a Claude wrapper").

---

## Spec 4 — Tighten the AFK Loop  (LAST / continuous — small high-leverage stitches; pieces all built)
Push (webhook/Slack/desktop, redacted, non-blocking), LAN+token+DNS-rebinding, mobile one-tap approve,
clean resume all work. Gaps are SEAMS between them.

**Phase 1 — stitch notify→mobile (highest impact, tiny).** `runner/gaffer --lan` never sets `GAFFER_DASHBOARD_URL` → push deep-link absent/wrong (the single biggest gap). Export/persist `GAFFER_DASHBOARD_URL="http://$LAN:$DASH_PORT"` in the `--lan` block (gaffer ~:96) + feed into the tick env (~2 lines). Add a decision deep-link in `emitDecisionGate` (core.ts ~:1136) mirroring `ticketUrl`. Tests: unit that ticketUrl/decision-url build correctly when the var is set; behavioral that `--lan` exports it.

**Phase 2 — "come back to this" ping + config unification.** One closing idle ping at loop end (`loop.sh:100`) via the wired dispatch notify emit: "N awaiting review, M decisions" (the literal walk-away payoff, reuse the sink). Unify the two disjoint notify configs: point `status.sh notify()` at the same `GAFFER_NOTIFY_*` vars (or document the split loudly). Tests: behavioral loop-end summary ping w/ correct counts; negative control (nothing pending → no ping / explicit all-clear).

**Phase 3 — mobile ergonomics (optional polish).** Replace `window.prompt` reject-reason (app.js ~:5320) with preset quick-reason chips (one-handed reject); hide desktop-only j/k/a/r hints on touch. QR the LAN URL+token in `--lan` output via optional `qrencode` (graceful fallback to printed token). Tests: view test for reject chips; QR path degrades gracefully when qrencode absent.
- **DECISION (locked): NO persistent watch-loop** — approve already resumes merge synchronously; pings make the wait invisible; a daemon is a much larger surface change against the "not a daemon" simplicity.

---

### Global sequence
Spec-Driven entry (in build) → Health → Graduated Autonomy → Worker Seam → AFK Loop. Commit per
verified unit; author tmj-90, no trailer. Same branch (operator override of "separate PRs after #26").
