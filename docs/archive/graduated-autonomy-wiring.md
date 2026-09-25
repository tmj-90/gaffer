# Design spec — wire graduated autonomy to the ship path (Option 1)

Status: **proposal, for decision.** Author: factory review follow-up to PR #30.
Decision owner: Tom.

## Why this exists

PR #30 shipped `GAFFER_MODE` (supervised / autonomous / strict) — a good front door,
but it consolidated the **blunt global flags**, not the **graduated per-repo/risk
policy**. An external review flagged the coherence gap the audit exists to catch:
*"graduated autonomy governs what ships"* is not true today — the binary global switch
is the only thing wired to the runner's ship decision.

This spec is the **cheaper-than-it-looks** fix, because the policy layer is already
built and the approve chokepoint is already policy-aware. It is a **last-mile wiring**,
not a re-architecture.

## What already exists (verified in code)

- **Policy store + semantics** — `autonomyPolicyRepository` (`(repo × risk × gate) →
  mode ∈ {auto, off, recommend}`) and `autonomyPolicyService`:
  `isAutonomyAllowed(lookup, repoIds, risk, gate, env) = envAllowsAuto(gate,env) ||
  policyGrantsAuto(...)`. **Env is the floor; a policy row can only ADD an allow-path,
  never subtract.** Fail-closed: no write repo ⇒ deny; every write repo must carry an
  `auto` row; risk/gate match exactly.
- **Approve chokepoint is wired** — `core.ts:596` calls `isAutonomyAllowed(this.autonomyPolicy, …)`
  for the `approve` gate. So `wg review approve` already respects the policy.
- **Recommender / cross-repo prior** — present (Spec 2 Phase 3 work), surfacing
  suggested `(repo,risk,gate)` grants for the operator to promote.

## The gap (precise)

1. **The runner bypasses the policy.** `runner/tick.sh:718` enters the AFK
   approve→merge block on raw `AUTO_MERGE=1 && MERGE_ON_AGENT_REVIEW=1`. With env
   **off**, the runner never attempts the policy-aware approve one line below — so an
   *earned* `(repoX, risk=low)` grant does nothing in an unattended run. This is the
   single load-bearing bypass.
2. **The `merge` gate has no blocking env-term.** `envAllowsAuto('merge')` returns
   `true` always (by design, "awaiting a blocking default"), so the merge policy is a
   no-op — the `approve` gate is the only real gate today.
3. **No mode exposes the middle gear.** `GAFFER_MODE` has only the two env-floor
   extremes: `supervised` (env off) and `autonomous` (env on). There is no posture that
   means "env off, but ship what the policy has earned."

Net: `GAFFER_MODE=autonomous` sets the env floor high globally, which the additive
policy cannot claw back — so it ships everything, everywhere, at every risk.

## Target model — three gears from ONE decision function

Make the runner's ship decision call `isAutonomyAllowed` per the ticket's
`(write-repos, risk, gate)` instead of the raw env flags. Then all three postures fall
out of the *same* function, with **no change to the safety invariant**:

| GAFFER_MODE | Env floor | Runner asks `isAutonomyAllowed` | Result |
|---|---|---|---|
| `supervised` (default) | approve=0, merge=held | env=false, no policy ⇒ **deny** | human approves everything (today) |
| `graduated` **(new)** | approve=0, merge=held | env=false, **policy grants earned rows** | ships what you've earned, **holds the rest** |
| `autonomous` | approve=1, merge=fire | env=true ⇒ **allow** | ships everything (today's autonomous) |

The `graduated` gear needs **no new grant mechanism** — it is precisely the existing
`env-off + policy-adds` invariant, finally reachable because the runner now consults it.

## Changes (surgical)

### A. Runner consults the policy, not raw flags — `runner/tick.sh` (the one real fix)
Replace the `if [ AUTO_MERGE=1 && MERGE_ON_AGENT_REVIEW=1 && -n RBRANCH ]` gate with a
policy-aware decision per ticket:
- On a clean agent verdict + a delivery branch, ask dispatch **"is auto approve+merge
  permitted for THIS ticket?"** — a new read-only decision surface the runner can call:
  `wg ticket auto-decision <N> --gate approve` and `--gate merge` (returns allow/deny by
  running `isAutonomyAllowed` with the ticket's write-repos + risk). No new policy logic
  — it reuses `core.ts`'s existing decision.
- Approve only if `approve` is allowed; merge only if `merge` is allowed. A denied
  ticket stays `in_review` for a human (today's supervised behaviour), byte-identical.
- Keep the existing "CHANGES verdict → rework" path unchanged.

Alternative (even smaller): keep the runner attempting `wg review approve` on every
clean verdict and let the **already-policy-aware** approve refuse when not permitted —
then the runner's outer gate is just "there is a clean verdict + branch", and
`isAutonomyAllowed` does 100% of the gating. Prefer this if `wg review approve` already
refuses on a false decision (verify); it removes the env flags from the runner entirely.

### B. Give the `merge` gate a blocking env-term — `autonomyPolicyService.ts`
`envAllowsAuto('merge')` → return `env.AUTO_MERGE === "1" && env.MERGE_ON_AGENT_REVIEW === "1"`
instead of `true`. This is the "blocking default" the file's own comment anticipates.
Now a `merge` policy row is load-bearing (env off + `auto` merge row = merge fires for
earned repos only). **Back-compat:** `autonomous` sets both flags ⇒ term stays `true`;
a human REST approval path must keep auto-merging (audit it stays byte-identical — this
is the one regression-risk line).

### C. Add the `graduated` posture — `factory.config.sh` + `settings.ts` + Settings UI
- `GAFFER_MODE=graduated` sets the env floor to **supervised** (approve=0, merge held)
  — the policy is the only allow-path. It is *not* a new flag cluster; it is
  "supervised env + the runner consults the policy" (which change A makes the default
  behaviour, so `graduated` is really just "supervised env, and you've set policy rows").
- Settings UI: the mode selector gains the third option with copy that says plainly
  *"ships what each repo has earned at its risk level; everything else waits for you."*
  Link to the per-repo policy editor (already exists).

### D. Close the recommender loop — dashboard (optional, follow-on)
Surface `recommend` rows as one-click "promote to auto" so the earned-trust path is
discoverable. The prior/recommender already compute candidates; this is UX only.

## Invariants preserved (must not weaken)
- **Env-first OR**: policy only ever ADDS an allow-path (unchanged). `graduated` works
  because env is *off*, not because policy subtracts.
- **Fail-closed**: no write repo ⇒ deny; every write repo needs an `auto` row; exact
  risk/gate match; a `changes` verdict never merges.
- **Agent can't self-approve**: the reviewer agent still never approves; the *runner*
  (deterministic, trusted) acts on the verdict — unchanged. The delivery agent's env is
  still scrubbed of the token.
- **Human path byte-identical**: a human REST approve still auto-merges as today.

## Migration / back-compat
- No `GAFFER_MODE`, no policy rows → env floor = supervised → identical to today.
- `GAFFER_MODE=autonomous` → env on → identical to today's autonomous (ships all).
- The only new *runtime* is `graduated`, which is inert until the operator adds `auto`
  policy rows. So this ships dark and safe.

## Test plan
- Unit (dispatch): `envAllowsAuto('merge')` now respects the flags; `isAutonomyAllowed`
  matrix (env×policy×risk×gate) incl. the merge term; no-policy-rows ⇒ pre-change
  behaviour (the existing no-regression pin must still pass).
- Runner (bash, DRY_RUN + stub decision CLI): supervised → deny → in_review; graduated
  with an `auto` row for (repo,risk=low,approve+merge) → a low-risk ticket ships, a
  high-risk one holds; autonomous → all ship. Multi-write-repo: one uncovered repo holds.
- Regression: full runner suite + auto-merge/strict/greenfield/autonomy-mode green;
  human-approve auto-merge byte-identical.

## Scope estimate
**Small–Medium.** A: one runner block + a small read-only `auto-decision` CLI (reusing
`core.ts`). B: one function + tests. C: config + one settings def + UI option. D:
optional. The heavy lifting (policy store, decision fn, approve wiring, recommender) is
already done — this connects the last wire.

## Open decisions for Tom
1. **Do this at all** (Option 1) vs relabel the policy advisory (Option 2). This spec is
   Option 1.
2. **Runner integration shape** — new `auto-decision` CLI (explicit) vs "let the
   policy-aware approve refuse" (smaller, if `wg review approve` already enforces).
3. **`merge` blocking term** — wire `AUTO_MERGE && MERGE_ON_AGENT_REVIEW` as the merge
   env-term now (recommended, makes merge policy real) vs leave merge always-fire and
   gate solely on `approve`.
4. **Mode surface** — a distinct `graduated` value (clearest) vs document that
   "supervised + policy rows = graduated" and skip a third label.

Independent of this decision, ship now: the docs fix that `strict` == `autonomous` on
Linux (the OS sandbox is `sandbox-exec`, macOS-only), and a SECURITY.md line stating
which layer governs shipping **today** so the story matches runtime.
