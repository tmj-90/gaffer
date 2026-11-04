# shellcheck shell=bash
# runner/config/08-guards.sh: recoverable-delivery guards: the per-ticket spend helpers (GUARD B), ask and
# pause on cap (GUARD C), the usage-pause default, the dashboard URL, the reap grace.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# --- Recoverable-delivery guard (GUARD B) ------------------------------------
# When the agent produced ≥1 commit but a DOWNSTREAM gate (DoD / hygiene /
# minimalism / empty-but-committed) failed, the delivery is RECOVERABLE: the
# branch holds salvageable work, so the failure path PRESERVES the branch
# (tears down only the disposable worktree), attaches the gate output to the
# ticket as a rework note, and RE-INVOKES the delivery agent on the SAME branch
# with that feedback — bounded by this cap. Only after the attempts (OR the
# per-ticket rework budget, GAFFER_REWORK_BUDGET_USD) are exhausted is the ticket
# parked to the VISIBLE `blocked` column WITH the branch + full feedback trail (a
# structured `rework_exhausted` reason) — never silently discarded, never lost to
# the board. Set to 1 to disable retry (one attempt, then park). The cap itself
# (GAFFER_MAX_DELIVERY_ATTEMPTS, total attempts per tick, ≥1) is defined + exported
# once above, alongside the claim TTL it feeds — this guard only consumes it.

# _gaffer_ticket_spend <ticket> <all|delivery>
# Sum this ticket's spend from the usage ledger: measured total_cost_usd, else a
# killed/timeout call's labelled estimate. Prints a decimal USD figure (0 when
# unmeasured or no ledger). Unmeasured ("unknown") records with no estimate
# contribute 0 (honest: we never invent a cost). Scope `all` counts every agent
# call booked against the ticket (delivery, bootstrap, review, security-review,
# clarify, eval-judge, tester, merge-resolver); `delivery` only the delivery turns.
_gaffer_ticket_spend() {
  local ticket="$1" scope="${2:-all}"
  command -v node >/dev/null 2>&1 || { printf '0'; return 0; }
  local ledger="${GAFFER_USAGE_LEDGER:-${GAFFER_DATA:+$GAFFER_DATA/usage-ledger.jsonl}}"
  [ -n "$ledger" ] && [ -f "$ledger" ] || { printf '0'; return 0; }
  # JSONL parsing via the ONE shared ledger reader (lib/estimate.mjs parseLedger);
  # the cost summation stays here — estimate.mjs's honesty contract forbids it
  # from reading total_cost_usd. Degrade path unchanged: any node/module failure
  # prints 0 (we never invent a cost).
  [ -f "${GAFFER_ESTIMATE_LIB:-}" ] || { printf '0'; return 0; }
  GAFFER_RW_TICKET="$ticket" GAFFER_RW_LEDGER="$ledger" GAFFER_RW_SCOPE="$scope" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const { parseLedger } = await import(pathToFileURL(process.env.GAFFER_ESTIMATE_LIB).href);
    const want=String(process.env.GAFFER_RW_TICKET);
    const deliveryOnly=process.env.GAFFER_RW_SCOPE==="delivery";
    let text="";
    try { text=readFileSync(process.env.GAFFER_RW_LEDGER,"utf8"); } catch {}
    let spend=0;
    for (const r of parseLedger(text)) {
      if (deliveryOnly && r.kind!=="delivery") continue;
      if (String(r.ticket)!==want) continue;
      const c=r.total_cost_usd;
      if (typeof c==="number" && Number.isFinite(c) && c>=0) { spend+=c; continue; }
      // Part A: count a killed/timeout ESTIMATE too (measured cost is "unknown").
      const e=r.estimated_cost_usd;
      if (typeof e==="number" && Number.isFinite(e) && e>=0) spend+=e;
    }
    process.stdout.write(spend.toFixed(6));
  ' 2>/dev/null || printf '0'
}

# gaffer_ticket_total_spend <ticket>
# EVERY agent call's spend for the ticket — the DOUBLE-BOUND's cost side. The
# per-ticket ceiling (delivery_budget_usd / GAFFER_REWORK_BUDGET_USD) bounds the
# whole rework loop, and that loop includes the review rounds that send work back,
# so the reviewers' (often strong-tier) spend counts too. Used by the pre-spawn
# gate, the post-attempt rework bound and the no-commit park in tick.sh.
gaffer_ticket_total_spend() { _gaffer_ticket_spend "$1" all; }

# gaffer_ticket_delivery_spend <ticket>
# Only the ticket's DELIVERY turns. The router's --historical-cost difficulty signal
# reads this: route-model.mjs's HIGH/LOW_HISTORICAL_USD thresholds are sized for
# delivery spend, and adding a review round would push nearly every reviewed ticket
# to "hard" and over-route it to the strong tier.
gaffer_ticket_delivery_spend() { _gaffer_ticket_spend "$1" delivery; }

# gaffer_ticket_rework_spend <ticket> — the historical name, kept for the tick.sh
# callers and test stubs. It is the TOTAL (all kinds), the figure the ceiling uses.
gaffer_ticket_rework_spend() { gaffer_ticket_total_spend "$1"; }
export -f _gaffer_ticket_spend gaffer_ticket_total_spend gaffer_ticket_delivery_spend gaffer_ticket_rework_spend 2>/dev/null || true

# --- Ask-on-cap guard (GUARD C) ----------------------------------------------
# When a mid-delivery agent call HITS a cap rather than failing a gate — it ran
# to the turn cap (num_turns at/over GAFFER_MAX_TURNS) or Claude reported a
# max-turns stop reason — the work is incomplete-but-not-broken. Instead of
# silently discarding it, the tick PRESERVES the branch, emits a `ticket_parked`
# notify event (ticket#, spend, dashboard URL; redaction honours
# GAFFER_NOTIFY_REDACT), and parks the ticket as needs-human-review. This cap is
# the turn count at/above which a call is treated as cap-hit; it defaults to the
# turn cap itself so a call that consumed every turn is caught.
: "${GAFFER_CAP_DETECT_TURNS:=${GAFFER_MAX_TURNS:-60}}"   # num_turns ≥ this ⇒ cap-hit
export GAFFER_CAP_DETECT_TURNS

# --- Pause-on-cap (PAUSE-ON-CAP) ---------------------------------------------
# On a mid-delivery cap-hit (turn cap) or budget-cap with committed work, PAUSE the
# delivery IN PLACE instead of tearing the worktree down: keep the worktree + branch
# alive, set the ticket `paused`, persist the resume context, notify, and wait for a
# human's one-click Continue (re-enter the SAME worktree) / Stop (tear down + abandon).
# Set to 0 to fall back to the legacy park-to-refining + teardown behaviour.
: "${GAFFER_PAUSE_ON_CAP:=1}"        # 1 = pause+keep worktree (default); 0 = legacy park+teardown
export GAFFER_PAUSE_ON_CAP
# USAGE-WINDOW PAUSE: minutes to pause admission after a usage-limit / rate-limit
# refusal when the CLI printed no reset time (a printed reset wins). Floor 10 minutes,
# enforced in lib/usage-pause.mjs whatever this says; junk falls back to 60.
: "${GAFFER_USAGE_PAUSE_DEFAULT_MIN:=60}"
export GAFFER_USAGE_PAUSE_DEFAULT_MIN
# (GAFFER_MAX_RESUMES_PER_TICK was removed: nothing read it. A tick delivers ONE
# ticket, so it re-enters at most one Continue'd paused ticket — first, before any
# new claim — and the next tick takes the next one.)
# Dashboard base URL embedded in the cap-hit / park / loop-end notify so the operator
# can click straight through to the ticket from their phone.
#
# BUG #6: the loop runs as a SEPARATE process from the dashboard, so it never sees
# the `--lan` (http://<LAN>:<port>) URL the dashboard computes + exports only inside
# its own process — the loop-end ping would deep-link to loopback, unreachable from a
# phone. `gaffer dashboard --lan` now PERSISTS the reachable base to
# $GAFFER_DATA/dashboard-url; read it here so the loop (and status.sh) deep-link to
# the SAME URL the dashboard serves. Precedence: an explicit env override always wins;
# else the persisted LAN url; else the loopback default (the degrade path when not
# running under --lan — `gaffer dashboard` without --lan removes the persisted file).
if [ -z "${GAFFER_DASHBOARD_URL:-}" ] && [ -s "$GAFFER_DATA/dashboard-url" ]; then
  _gaffer_persisted_url="$(head -1 "$GAFFER_DATA/dashboard-url" 2>/dev/null | tr -d ' \t\r\n')"
  case "$_gaffer_persisted_url" in
    http://*|https://*) GAFFER_DASHBOARD_URL="$_gaffer_persisted_url" ;;
  esac
  unset _gaffer_persisted_url
fi
: "${GAFFER_DASHBOARD_URL:=http://127.0.0.1:${DISPATCH_API_PORT:-8787}}"
export GAFFER_DASHBOARD_URL

# FINDING-6 (b): TERM->KILL grace (seconds) for gaffer_timeout's process-group
# reaper. On a timeout/kill the reaper TERMs the child group first so tick.sh's
# crash trap can run its cleanup — crucially the claim-release `wg` call (node
# startup + a local HTTP round-trip) plus worktree teardown — and only KILLs the
# group once this grace expires. The old hardcoded ~2s grace realistically
# SIGKILLed that release mid-flight, stranding the ticket `claimed` for the rest
# of its lease. 30s comfortably covers release + teardown while still bounding a
# TERM-ignoring runaway; keep it well under the claim-TTL headroom
# (GAFFER_CLAIM_TTL − GAFFER_TICK_OUTER_TIMEOUT, 180s at defaults).
: "${GAFFER_REAP_GRACE:=30}"
export GAFFER_REAP_GRACE

_GAFFER_CONFIG_PART=08-guards
