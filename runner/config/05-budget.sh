# shellcheck shell=bash
# runner/config/05-budget.sh: budgets: the factory USD ceiling, the per-call dollar cap, the live headroom
# summed from the usage ledger, the low-budget threshold and the cheap phases.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# H1 cost/budget visibility knobs.
# GAFFER_BUDGET_USD — operator spending ceiling in USD for the factory's total
#   spend (summed from the usage-ledger). Unset or 0 = unlimited (the default).
#   Example: GAFFER_BUDGET_USD=5.00 (stop routing to expensive models at $5).
#
#   TECH DEBT: this is a CUMULATIVE LIFETIME cap (total ledger spend), not per-run
#   or per-ticket — GAFFER_BUDGET_REMAINING = GAFFER_BUDGET_USD - lifetime_ledger.
#   So on a .gaffer that already has prior spend, a value below the lifetime total
#   leaves $0 headroom and pauses the NEXT delivery on budget_cap immediately
#   (observed: a $3 cap paused a $0.43 delivery mid-flight). It conflates two
#   different jobs: a lifetime governor (fine here) vs. "don't let ONE delivery
#   run away". The mid-delivery pause-on-cap should instead key off a PER-TICKET
#   budget (~$10 default, reusing the per-ticket delivery_budget_usd field),
#   independent of lifetime total. Tracked as tech debt — do NOT set a low
#   GAFFER_BUDGET_USD on an existing factory expecting per-delivery semantics.
#   (On a Max/Pro plan the $ figure is an API-equivalent estimate, not a charge.)
: "${GAFFER_BUDGET_USD:=}"
export GAFFER_BUDGET_USD

# GAFFER_MAX_CALL_USD — a HARD per-call dollar cap, passed to `claude --max-budget-usd`
#   so ONE runaway call is stopped while it runs (every other guard acts only between
#   calls). OPT-IN: empty (the default) = off, no flag, behaviour unchanged. When set,
#   each call's cap is the lowest of this value, the factory headroom
#   (GAFFER_BUDGET_REMAINING) and — for a delivery — the ticket's own remaining
#   ceiling (delivery_budget_usd / GAFFER_REWORK_BUDGET_USD minus its spend). A call
#   stopped by it is a `budget_cap` pause (work kept, one-click Continue), never a
#   turn-cap. Claude Code checks it between turns, so a call can overshoot by one turn.
#   OWNER DECISION PENDING: whether to ship a default (e.g. 5) and/or a default
#   per-ticket ceiling (GAFFER_REWORK_BUDGET_USD, e.g. 10) — both are empty today.
: "${GAFFER_MAX_CALL_USD:=}"
export GAFFER_MAX_CALL_USD

# gaffer_call_budget_usd [ticket-remaining]
# Echo the per-call `--max-budget-usd` value, or nothing when GAFFER_MAX_CALL_USD is
# unset (off) or a headroom is already ≤ 0 (the pre-spawn gates own that case).
# Parity with lib/worker.mjs callBudgetUsd.
gaffer_call_budget_usd() {
  [ -n "${GAFFER_MAX_CALL_USD:-}" ] || return 0
  awk -v c="${GAFFER_MAX_CALL_USD}" -v r="${GAFFER_BUDGET_REMAINING:-}" -v t="${1:-}" '
    function num(v) { return (v ~ /^[0-9]*\.?[0-9]+$/) }
    BEGIN {
      if (!num(c) || c + 0 <= 0) exit 0
      m = c + 0
      if (r != "" && r ~ /^-?[0-9]*\.?[0-9]+$/ && r + 0 < m) m = r + 0
      if (t != "" && t ~ /^-?[0-9]*\.?[0-9]+$/ && t + 0 < m) m = t + 0
      if (m > 0) printf "%.4f", m
    }' 2>/dev/null || true
}

# GAFFER_BUDGET_REMAINING — live USD headroom. Recomputed here from the ledger
# so the I1 router (gaffer_route_model) and Guard C (ask-on-cap) can read a
# real figure instead of "unlimited". Empty = unlimited (GAFFER_BUDGET_USD unset
# or ledger unreadable). Recomputed EVERY time factory.config.sh is sourced (once
# per tick, at source-time in tick.sh) and ALWAYS assigned — never `:=`.
# B28(b): it used to be an assign-if-unset, but the value is exported below, so
# loop.sh / worker.sh / the daemon computed it ONCE at process start and every
# tick.sh they spawned inherited that stale figure — the router's low-budget
# downgrade and the budget_cap pause never saw the spend the day's earlier ticks
# had booked. It is a DERIVED value, not an operator input: an inherited value is
# overwritten by the fresh ledger sum here.
if [ -n "${GAFFER_BUDGET_USD:-}" ] && command -v node >/dev/null 2>&1 \
   && [ -n "${GAFFER_USAGE_LEDGER:-}${GAFFER_DATA:-}" ]; then
  _gaffer_budget_remaining="$(node --input-type=module - <<'__BUDGET_JS__' 2>/dev/null || true
// JSONL parsing is delegated to the ONE shared ledger reader (lib/estimate.mjs
// parseLedger — same tolerant semantics: blank lines skipped, a corrupt line
// dropped, never an abort). The COST SUMMATION stays HERE: the honesty
// contract of estimate.mjs forbids it from ever reading total_cost_usd.
// NOTE: keep quotes BALANCED in this heredoc — bash 3.2 (/bin/bash on macOS,
// used by the env-scrub tests) cannot parse an odd quote count inside $(…).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { parseLedger } = await import(pathToFileURL(process.env._GAFFER_ESTIMATE_LIB).href);
const ledger = process.env.GAFFER_USAGE_LEDGER ||
  (process.env.GAFFER_DATA ? join(process.env.GAFFER_DATA, 'usage-ledger.jsonl') : '');
if (!ledger) { process.stdout.write(''); process.exit(0); }
let text = '';
try { text = readFileSync(ledger, 'utf8'); } catch { /* missing ledger = 0 spend */ }
let spend = 0;
for (const r of parseLedger(text)) {
  const c = r.total_cost_usd;
  if (typeof c === 'number' && Number.isFinite(c) && c >= 0) { spend += c; continue; }
  // Part A: a KILLED/timeout call books no measured cost but a labelled ESTIMATE —
  // count it so an unattended run that keeps timing out cannot read as free.
  const e = r.estimated_cost_usd;
  if (typeof e === 'number' && Number.isFinite(e) && e >= 0) spend += e;
}
const budget = parseFloat(process.env.GAFFER_BUDGET_USD || '0');
if (budget <= 0) { process.stdout.write(''); process.exit(0); }
const remaining = Math.max(0, budget - spend);
process.stdout.write(remaining.toFixed(6));
__BUDGET_JS__
)"
  GAFFER_BUDGET_REMAINING="$_gaffer_budget_remaining"
  unset _gaffer_budget_remaining
else
  # No budget configured or node unavailable → unlimited (the pre-H1 default).
  GAFFER_BUDGET_REMAINING=""
fi
# GAFFER_BUDGET_LOW_THRESHOLD — the USD headroom at/under which the router biases
# one tier CHEAPER (the "cost-as-control" downgrade). Promoting cost to a real
# CONTROL (not just an observed number): when a budget IS configured but no explicit
# threshold is set, DERIVE one as a fraction of the budget so the downgrade actually
# fires as the factory approaches its ceiling — spend then steers routing instead of
# only being reported. Unset budget → 0 (inert, the pre-H1 default). An explicit
# operator value always wins.
if [ -z "${GAFFER_BUDGET_LOW_THRESHOLD:-}" ] && [ -n "${GAFFER_BUDGET_USD:-}" ] \
   && command -v awk >/dev/null 2>&1; then
  # Default: bias cheaper once headroom drops below 20% of the configured budget.
  # Pass both operator-config values via -v (NEVER interpolated into the awk program
  # body) so an awk-metacharacter value in settings.json — e.g. `1}; system("…")` — is
  # treated as inert data (`+0` coerces garbage to 0), never executed as awk code.
  GAFFER_BUDGET_LOW_THRESHOLD="$(awk \
    -v b="${GAFFER_BUDGET_USD}" \
    -v frac=0.20 \
    'BEGIN{b+=0; frac+=0; if(b>0) printf "%.6f", b*frac; else print 0}' 2>/dev/null || echo 0)"
fi
: "${GAFFER_BUDGET_LOW_THRESHOLD:=0}"
# GAFFER_CHEAP_PHASES — cost-as-control class knob (Settings). A comma/space list of
# PHASES whose work the operator wants biased toward the cheap tier. The router
# (route-model.mjs cheapClassFromEnv) reads this and biases one tier cheaper for a
# matching phase — but never overrides a high/critical-risk escalation. Empty
# (default) = no class is force-cheapened.
# SCOPE: the phases routed through gaffer_route_model are `implement` (tick.sh's
# delivery call), `review` (lib/review.sh — the primary reviewer AND the security
# second-opinion reviewer) and `clarify` (lib/clarify.sh), so those three values have
# an effect (e.g. "implement,review"). Other phases (self-review, test, onboarding,
# decompose…) use static model flags and do NOT consult this router; listing them
# here is inert.
: "${GAFFER_CHEAP_PHASES:=}"
export GAFFER_MODEL_REGISTRY GAFFER_BUDGET_REMAINING GAFFER_BUDGET_LOW_THRESHOLD GAFFER_CHEAP_PHASES

_GAFFER_CONFIG_PART=05-budget
