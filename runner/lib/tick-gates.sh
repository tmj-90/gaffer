#!/usr/bin/env bash
# runner/lib/tick-gates.sh
# The delivery gates and the submit / rework / park decision: claim release and park,
# the cross-run no-commit counter, the per-ticket budget gate, the runner-owned
# submit, and the bounded delivery attempt loop (GUARD B) with every downstream gate.
#
# Sourced by runner/tick.sh only (required there: a missing file fails the tick
# closed). Function definitions only, so sourcing it runs nothing. Every body was
# moved verbatim out of tick.sh; the functions read and write tick.sh's globals
# (NUM, SHOW, WT_ROWS, CLAIM_TOKEN, ...) exactly as the inline code did, and the
# gaffer_tick_* / _gaffer_idle_* wrappers declare no locals, so every assignment in
# them stays global. See runner/CLAUDE.md for the map of the tick phases.

# Release/park the runner-held delivery claim (RUNNER-OWNED-BOOKKEEPING). $1 =
# ready|refining|blocked, $2 = reason. Optional structured park metadata for the
# board card + the activity trail: $3 = reason-code (e.g. rework_exhausted), $4 =
# attempt reached, $5 = attempt ceiling, $6 = paused-until ISO (reason-code
# usage_limit: the ticket.usage_limited event carries when the window resets). With a token (normal delivery) the matching
# claim is released; without one (a resumed in_progress delivery) the ticket is
# transitioned tokenlessly via the same guarded runner-release path. `blocked` is the
# VISIBLE terminal park for an exhausted rework loop — a human never wonders where the
# ticket went. Best-effort + logged.
gaffer_release_delivery() {
  local to="$1" reason="$2" code="${3:-}" attempt="${4:-}" maxa="${5:-}" until="${6:-}"
  # DRY_RUN never claims, so it never releases — keep it side-effect-free.
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  # REPLAY MANIFEST: a release ends the open attempt (the usage window, an auth or budget
  # refusal, an empty delivery, any park) unless a sharper outcome was already written.
  declare -F gaffer_manifest_finish >/dev/null 2>&1 && gaffer_manifest_finish "released:$to${code:+:$code}"
  local extra=()
  [ -n "$code" ]    && extra+=(--reason-code "$code")
  [ -n "$attempt" ] && extra+=(--attempt "$attempt")
  [ -n "$maxa" ]    && extra+=(--max "$maxa")
  [ -n "$until" ]   && extra+=(--paused-until "$until")
  # BOUNDED RETRY. A single failed control-plane call used to be final: the claim
  # stayed live until its TTL, the ticket sat 'claimed' and a human was paged — for
  # what is usually a transient (a busy SQLite writer under GAFFER_CONCURRENCY>1, a
  # slow node start-up). Three attempts with a short back-off self-heal that; a
  # persistent failure is logged WITH the CLI's own error tail so it is diagnosable,
  # not a bare "needs a human". (Seen once on a macOS CI runner: 1 of 4 identical
  # jobs failed the release and stranded the ticket.)
  local _tok=() _verb="released claim on" _fail="could not release claim on" _out="" _try
  if [ -n "${CLAIM_TOKEN:-}" ]; then _tok=(--token="$CLAIM_TOKEN"); else _verb="transitioned"; _fail="could not transition"; fi
  for _try in 1 2 3; do
    if _out="$(wg runner-release "$NUM" --to "$to" ${_tok[@]+"${_tok[@]}"} --reason "$reason" ${extra[@]+"${extra[@]}"} 2>&1)"; then
      local _suffix=""; [ "$_try" -gt 1 ] && _suffix=" after $_try attempts"
      log "$_verb #$NUM → $to ($reason)$_suffix"
      GAFFER_CLAIM_RESOLVED=1
      case "$to" in blocked|refining) _GAFFER_TICK_PARKED=1 ;; esac
      return 0
    fi
    [ "$_try" -lt 3 ] && sleep "$_try"
  done
  # DIAGNOSABLE: a release that fails because the claim is already gone is usually the
  # AGENT having moved the ticket itself (it parked to `blocked` on a decision it opened,
  # which drops the claim). Say so — "needs a human — 3 attempts failed" for a ticket that
  # is already correctly parked and visible sent an operator chasing a phantom.
  local _now_status
  _now_status="$(wg ticket show "$NUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '')"
  case "$_now_status" in
    claimed|in_progress|"")
      log "WARNING — $_fail #$NUM → $to ($reason); needs a human — 3 attempts failed, last error: $(printf '%s' "$_out" | tail -n 3 | tr '\n' ' ' | cut -c1-300)" ;;
    *)
      log "NOTE — $_fail #$NUM → $to: the ticket is already '$_now_status' (moved during the attempt — typically the agent parked it on a decision it opened); nothing further to release. Last error: $(printf '%s' "$_out" | tail -n 1 | cut -c1-200)" ;;
  esac
  # The claim is now resolved by the normal flow (a release we tried and already
  # logged). Mark it so the EXIT crash trap does NOT re-attempt the release with
  # the now-void token and page a spurious "needs a human" (N3).
  GAFFER_CLAIM_RESOLVED=1
}

# ── FINDING-3: CROSS-RUN no-commit failure counter ───────────────────────────
# A per-ticket counter that survives runs (the skip-file is per-run only), kept
# as one small file per ticket under $GAFFER_DATA — the same durability domain
# as the usage ledger the cost bound reads. Dispatch's rework-attempt records
# only cover the in-delivery recoverable loop (wg runner-rework), and this
# failure path must keep working even when the dispatch call itself is what
# failed — so the runner owns this counter locally. Increment is taken under
# the same lock helper as the skip-file so concurrent workers never lose a count.
gaffer_nocommit_file() { printf '%s/.nocommit-failures/%s' "$GAFFER_DATA" "$1"; }
gaffer_nocommit_count() { local _f _n; _f="$(gaffer_nocommit_file "$1")"; _n="$(cat "$_f" 2>/dev/null || echo 0)"; case "$_n" in ''|*[!0-9]*) _n=0 ;; esac; printf '%s' "$_n"; }
_gaffer_nocommit_record_unlocked() { local _f _n; _f="$(gaffer_nocommit_file "$1")"; mkdir -p "${_f%/*}" 2>/dev/null; _n="$(gaffer_nocommit_count "$1")"; _n=$((_n + 1)); printf '%s' "$_n" > "$_f"; printf '%s' "$_n"; }
gaffer_nocommit_record() { _gaffer_locked .nocommit.lock _gaffer_nocommit_record_unlocked "$1"; }
gaffer_nocommit_clear() { rm -f "$(gaffer_nocommit_file "$1")" 2>/dev/null || true; }

# FINDING-3: bounded release for the no-commit / wrong-branch failure paths.
# These paths drop the branch and used to release the claim straight back to
# `ready` — but the skip-file that stops a re-pick is per-RUN, and the per-ticket
# cost ceiling lives in _recover_or_park behind gaffer_any_branch_has_commits,
# which a no-commit crash never reaches. Net: a deterministically-crashing agent
# burned one full `claude -p` per run, forever, at ESCALATING cost (accumulated
# ledger spend feeds the difficulty router). This wrapper applies the SAME
# double-bound as the in-delivery rework loop, but ACROSS runs:
#   • counter < GAFFER_MAX_NOCOMMIT_FAILURES AND spend < the per-ticket ceiling
#     → release to `ready` exactly as before (the recoverable path stays
#     recoverable); the durable counter records the failure;
#   • bound hit (either side) → park VISIBLY to `blocked` via the same
#     rework_exhausted machinery _recover_or_park uses (reason-code on the card,
#     ticket.blocked event, memory demotion) so a human is paged the same way.
# The counter clears here on park, on a successful submit, and on any park out
# of the delivery pipeline — a flaky-then-fixed ticket is never poisoned.
# Numeric-safe awk comparisons. Ticket/config numeric fields (delivery_budget_usd,
# rework spend) originate in the DB, where SQLite NUMERIC affinity can store a
# non-numeric string verbatim — and epics/tickets can be AI-drafted. Passing values
# via `awk -v` (NOT string-interpolated into the program body) means such a value can
# never be parsed as awk source. Empty/garbage coerces to 0. Each returns 0 (success)
# when the comparison holds, matching the previous `awk 'BEGIN{exit !(…)}'` contract.
_num_pos() { awk -v x="${1:-0}" 'BEGIN{exit !(x + 0 > 0)}' 2>/dev/null; }                # x > 0
_num_ge() { awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN{exit !(a + 0 >= b + 0)}' 2>/dev/null; } # a >= b
_num_le() { awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN{exit !(a + 0 <= b + 0)}' 2>/dev/null; } # a <= b

gaffer_release_or_park_nocommit() {
  # $2 (optional) = what the parked trail says happened (default: no commits produced).
  local reason="$1" detail="${2:-the agent produced no commits}"
  # DRY_RUN never claims → never releases and never counts; keep it side-effect-free.
  if [ "${DRY_RUN:-0}" = "1" ]; then gaffer_release_delivery ready "$reason"; return 0; fi
  local _max="${GAFFER_MAX_NOCOMMIT_FAILURES:-${GAFFER_MAX_DELIVERY_ATTEMPTS:-3}}"
  [ "$_max" -ge 1 ] 2>/dev/null || _max=3
  local _n; _n="$(gaffer_nocommit_record "$NUM" 2>/dev/null || echo 1)"
  case "$_n" in ''|*[!0-9]*) _n=1 ;; esac
  # Cost side of the double-bound: the SAME effective ceiling _recover_or_park
  # resolves — the ticket's own delivery_budget_usd (TRACK-3a) when set, else the
  # factory-wide GAFFER_REWORK_BUDGET_USD — against the ticket's cumulative
  # MEASURED ledger spend. A crash-looping ticket with real spend past the
  # ceiling parks immediately, even with counter headroom left.
  local _cost_exhausted=0 _ticket_budget _eff_ceiling _spent=0
  _ticket_budget="$(printf '%s' "${SHOW:-}" | jget 'd.ticket.delivery_budget_usd' 2>/dev/null || true)"
  case "$_ticket_budget" in ""|None|null) _ticket_budget="" ;; esac
  if [ -n "$_ticket_budget" ] && _num_pos "$_ticket_budget"; then
    _eff_ceiling="$_ticket_budget"
  else
    _eff_ceiling="${GAFFER_REWORK_BUDGET_USD:-}"
  fi
  if [ -n "$_eff_ceiling" ] && _num_pos "$_eff_ceiling"; then
    _spent="$(gaffer_ticket_rework_spend "$NUM" 2>/dev/null || echo 0)"
    if _num_ge "$_spent" "$_eff_ceiling"; then
      _cost_exhausted=1
      log "NOCOMMIT: #$NUM hit the per-ticket cost ceiling (spent \$${_spent} ≥ \$${_eff_ceiling}) with no committed work — parking to blocked (no unbounded cross-run burn)"
    fi
  fi
  if [ "$_n" -lt "$_max" ] && [ "$_cost_exhausted" -eq 0 ]; then
    gaffer_release_delivery ready "$reason (no-commit failure $_n/$_max across runs)"
    return 0
  fi
  local _why="$_max no-commit failures across runs"
  [ "$_cost_exhausted" -eq 1 ] && _why="the per-ticket cost ceiling (spent \$${_spent} ≥ \$${_eff_ceiling}) with no committed work"
  # Terminal park — same VISIBLE machinery as _recover_or_park's rework_exhausted:
  # the reason-code lands on the board card (last_review_feedback) and the
  # ticket.blocked event pages a human; the durable note records the trail.
  wg attach-evidence "$NUM" --type manual_note \
    --summary "PARKED (rework_exhausted): $reason — after $_why; $detail, needs a human" >/dev/null 2>&1 || true
  gaffer_release_delivery blocked "$reason — parked after $_why; needs a human" rework_exhausted "$_n" "$_max"
  # MEMORY FEEDBACK LOOP: served knowledge did not help this ticket — demote + flag.
  gaffer_recall_feedback blocked
  # Reset the cross-run counter: the ticket has left the delivery pipeline; when a
  # human unblocks it the retry budget starts fresh (never permanently poisoned).
  gaffer_nocommit_clear "$NUM"
  log "NOCOMMIT: parked #$NUM (→ blocked, rework_exhausted) after $_why — VISIBLE on the board; cross-run counter cleared for the post-human retry"
  return 0
}

# PRE-SPAWN BUDGET GATE (C3). Returns 0 (true = EXHAUSTED → do NOT spawn) when the
# ticket's cumulative MEASURED spend has reached its effective ceiling — the ticket's
# own delivery_budget_usd (TRACK-3a) when set, else the factory-wide
# GAFFER_REWORK_BUDGET_USD. No ceiling configured → return 1 (never gate). Sets
# GAFFER_BUDGET_SPENT / GAFFER_BUDGET_CEIL for the caller's message. Mirrors the
# post-attempt rework bound (the cost side of _recover_or_park, in the attempt loop
# below) but gates BEFORE the spawn, closing the cross-run gap: a ticket that already
# burned its budget in a prior run would otherwise spawn one more turn before the
# post-attempt bound caught it.
gaffer_budget_exhausted() {
  local _num="$1" _tb _ceil _spent
  _tb="$(printf '%s' "${SHOW:-}" | jget 'd.ticket.delivery_budget_usd' 2>/dev/null || true)"
  case "$_tb" in ""|None|null) _tb="" ;; esac
  if [ -n "$_tb" ] && _num_pos "$_tb"; then _ceil="$_tb"; else _ceil="${GAFFER_REWORK_BUDGET_USD:-}"; fi
  { [ -n "$_ceil" ] && _num_pos "$_ceil"; } || return 1
  _spent="$(gaffer_ticket_rework_spend "$_num" 2>/dev/null || echo 0)"
  _num_ge "$_spent" "$_ceil" || return 1
  GAFFER_BUDGET_SPENT="$_spent"; GAFFER_BUDGET_CEIL="$_ceil"; return 0
}

# gaffer_ticket_budget_remaining <num>
# Echo the ticket's remaining USD under its effective ceiling (the same ceiling
# gaffer_budget_exhausted resolves: delivery_budget_usd, else GAFFER_REWORK_BUDGET_USD)
# minus its cumulative spend; nothing when no ceiling is configured. Feeds the
# opt-in per-call cap (gaffer_call_budget_usd) so one call cannot overshoot it.
gaffer_ticket_budget_remaining() {
  local _num="$1" _tb _ceil _spent
  _tb="$(printf '%s' "${SHOW:-}" | jget 'd.ticket.delivery_budget_usd' 2>/dev/null || true)"
  case "$_tb" in ""|None|null) _tb="" ;; esac
  if [ -n "$_tb" ] && _num_pos "$_tb"; then _ceil="$_tb"; else _ceil="${GAFFER_REWORK_BUDGET_USD:-}"; fi
  { [ -n "$_ceil" ] && _num_pos "$_ceil"; } || return 0
  _spent="$(gaffer_ticket_rework_spend "$_num" 2>/dev/null || echo 0)"
  awk -v c="$_ceil" -v s="$_spent" 'BEGIN{printf "%.6f", (c+0)-(s+0)}' 2>/dev/null || true
}

# Submit a passed delivery for review (RUNNER-OWNED-BOOKKEEPING). With a runner-held
# token (normal delivery) it uses the claim-gated submit (claimed → in_review,
# completing the claim; a leased resume goes in_progress → in_review the same way); a
# tokenless resume fallback is moved straight to in_review. $1 = reason. Returns
# non-zero (logged) on failure.


gaffer_submit_delivery() {
  local reason="$1"
  local _rc _err
  # Capture stderr (discard stdout) so a submit FAILURE reason ("claim expired",
  # "not in a claimable state", "SQLite locked") reaches the log instead of /dev/null —
  # the caller's park path already handles the non-zero rc, but silently losing the
  # WHY made a transient submit failure needlessly hard to triage.
  if [ -n "${CLAIM_TOKEN:-}" ]; then
    _err="$(wg submit "$NUM" --token="$CLAIM_TOKEN" --reason "$reason" 2>&1 >/dev/null)"
    _rc=$?
  else
    _err="$(wg ticket move "$NUM" in_review --as system 2>&1 >/dev/null)"
    _rc=$?
  fi
  [ "$_rc" -ne 0 ] && [ -n "$_err" ] &&
    log "submit for #$NUM failed (rc=$_rc): $(printf '%s' "$_err" | tr '\n' ' ' | cut -c1-300)"
  # VERIFY AFTER WRITE: a submit that reports success but did not land (observed once
  # in the browser regression: rc=0, no transition event, ticket still `claimed`) used
  # to be invisible — the tick logged "submitted" and moved on while the claim stayed
  # live and the ticket never reached review. Re-read the status through a FRESH CLI
  # process; anything but in_review is treated as a failed submit so the caller's
  # park path handles it and the WHY is in the log.
  if [ "$_rc" -eq 0 ]; then
    local _st
    _st="$(wg ticket show "$NUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '')"
    if [ "$_st" != "in_review" ]; then
      log "SUBMIT-VERIFY: #$NUM submit reported success but the ticket reads '${_st:-unknown}' (expected in_review) — treating as a failed submit"
      _rc=1
    fi
  fi
  # On a successful submit the claim is COMPLETED (claimed → in_review): the token
  # is consumed. Mark the claim resolved so the EXIT crash trap doesn't re-release
  # it with the void token and page a spurious "needs a human" (N3). On failure we
  # leave it 0 so the caller's park path (or a genuine crash) still resolves it.
  [ "$_rc" -eq 0 ] && GAFFER_CLAIM_RESOLVED=1
  return "$_rc"
}

# GUARD B: the bounded attempt loop, launch + every gate. Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_delivery_attempts() {
  # ── GUARD B: recoverable-delivery attempt loop ──────────────────────────────
  # The agent invocation + every DOWNSTREAM gate (DoD / hygiene / minimalism /
  # empty-but-committed) run inside this bounded loop. A RECOVERABLE failure (the
  # agent produced ≥1 commit but a gate failed) PRESERVES the branch, attaches the
  # gate's output as a rework note, and `continue`s to re-invoke the SAME agent on
  # the SAME branch with that feedback — up to GAFFER_MAX_DELIVERY_ATTEMPTS. When
  # attempts exhaust, the recoverable handler parks the ticket to `refining` WITH
  # the branch + feedback (never silent-discards). UNRECOVERABLE failures (no
  # commit / empty / crash / safety / cap-hit) keep today's behaviour and break
  # out of the loop via their own `exit 0`. The INVARIANT — a delivery with ≥1
  # commit NEVER has its branch deleted by the failure path — is enforced by
  # routing every committed-branch failure through gaffer_cleanup_worktrees with
  # NO drop-branch.
  _MAX_DELIVERY_ATTEMPTS="${GAFFER_MAX_DELIVERY_ATTEMPTS:-3}"
  [ "$_MAX_DELIVERY_ATTEMPTS" -ge 1 ] 2>/dev/null || _MAX_DELIVERY_ATTEMPTS=1
  _DELIV_ATTEMPT=0
  # ESCALATION + REAL FEEDBACK state (RUNNER-OWNED REWORK LOOP):
  #   _REWORK_HISTORY  — the accumulated, distilled real failures from EVERY prior
  #                      attempt (the crux: the actual failing test + assertion, not a
  #                      gate-name summary). Fed into the next attempt's prompt so the
  #                      agent can self-correct; the FINAL attempt sees the full trail.
  #   _REWORK_BLOCK    — the per-attempt prompt suffix built from the history + the
  #                      escalation posture (rethink / stronger model). Empty on attempt 1.
  _REWORK_HISTORY=""
  _REWORK_BLOCK=""
  #   _LAST_REAL_FAILURE — the distilled failure of the previous attempt. An attempt
  #                        that reproduces it BYTE-FOR-BYTE is not converging; the loop
  #                        parks then instead of paying the remaining attempts (WASTE
  #                        CONTROL — a live run paid three turns against one unchanged
  #                        failing assertion).
  _LAST_REAL_FAILURE=""

  # _recover_or_park <gate-name> <feedback-text> [real-failure-detail]
  # A RECOVERABLE gate failure (branch carries ≥1 commit). PRESERVES the branch —
  # tears down ONLY the disposable worktree — records the REAL failure (the distilled
  # failing test + assertion, arg 3 when present; else the summary) for the next
  # attempt, then decides against the DOUBLE-BOUND (attempt cap AND per-ticket cost):
  #   • budget/attempts remain → _DELIV_OUTCOME=retry; the ticket stays VISIBLY
  #     in_progress with "reworking · attempt N/M" + the latest failure on its card
  #     (wg runner-rework), and the caller `continue`s so the loop re-invokes the
  #     escalated agent on the same branch with the accumulated feedback;
  #   • cap OR per-ticket cost ceiling hit → park the ticket to the VISIBLE `blocked`
  #     column (rework_exhausted) WITH the branch + full feedback trail, then
  #     _DELIV_OUTCOME=parked so the caller exits. The branch is NEVER dropped here.
  _recover_or_park() {
    local gate="$1" feedback="$2" detail="${3:-}"
    # TICK DEADLINE: how long this attempt's gates took after the agent returned — the
    # next attempt needs about as much again on top of the agent call.
    _GATE_SECS_LAST=$(( $(date +%s) - ${_T_AGENT_DONE:-$(date +%s)} ))
    # The REAL failure fed to the next attempt: the distilled assertion/error when the
    # caller captured one, else the human summary. This is the crux of (b) — the agent
    # sees the actual failing test, not just "tests@repo failed".
    local real="${detail:-$feedback}"
    # FIX-BRANCH (rework + park): from here on the branch carries ≥1 commit — it is
    # salvageable work whatever happens next (a retry, the park, a kill mid-rework).
    # Raise retention NOW so the EXIT trap tears down only the worktree. The park path
    # used to `exit` with KEEP=0 (retention is otherwise raised just before submit,
    # AFTER the gates), and the trap `drop-branch`ed the very branch the log had just
    # called PRESERVED — a live run lost a five-commit bootstrap branch that way.
    GAFFER_KEEP_DELIVERY_BRANCH=1
    # AGENT-SIDE PARK: the agent may itself have moved the ticket to `blocked` during
    # this attempt (mark_ticket_blocked through the dispatch MCP, typically after opening
    # a human_required decision; the decision alone does not change the status). Its
    # claim is gone with that transition, so another attempt burns a paid agent turn on
    # a ticket that already waits on a human, and the runner's own release then fails
    # CLAIM_INVALID. End the loop instead: keep the branch, drop the worktree, leave the
    # ticket where the agent parked it, and skip it for the rest of this run.
    local _cur_status
    _cur_status="$(wg ticket show "$NUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '')"
    if [ "$_cur_status" = "blocked" ]; then
      GAFFER_CLAIM_RESOLVED=1
      gaffer_cleanup_worktrees
      gaffer_skip_ticket "$NUM"
      log "RECOVER: #$NUM is already 'blocked' (the agent parked it on a decision during attempt $_DELIV_ATTEMPT) — ending the rework loop without another attempt; branch $WORK_BRANCH PRESERVED, worktree removed"
      gaffer_manifest_finish "park:agent-blocked"
      _DELIV_OUTCOME="parked"
      return 0
    fi
    # NOT CONVERGING: the same distilled failure as the previous attempt (identical text)
    # means the rework changed nothing that mattered. Park now — the next attempt would
    # be a third paid turn against the same wall, and a human is the right reader.
    local _repeat=0
    if [ "$_DELIV_ATTEMPT" -ge 2 ] && [ -n "$_LAST_REAL_FAILURE" ] && [ "$real" = "$_LAST_REAL_FAILURE" ]; then
      _repeat=1
    fi
    _LAST_REAL_FAILURE="$real"
    # Accumulate the full trail so the FINAL (stronger-model) attempt sees every prior
    # failure, not just the latest — bounded so a chatty run can't unbound the prompt.
    _REWORK_HISTORY="${_REWORK_HISTORY}
── attempt $_DELIV_ATTEMPT — $gate ──
$real
"
    _REWORK_HISTORY="$(printf '%s' "$_REWORK_HISTORY" | tail -c 8000)"
    # NOTE (dedupe): the failure text used to ALSO be attached here as a manual_note
    # evidence record — persisting it twice per attempt. The durable persistence now
    # lives in exactly one place per outcome: the retry path's `wg runner-rework
    # --failure` (appends the full block to the ticket's rework trail + event) and
    # the park path's release reason (last_review_feedback + ticket.blocked event).

    # DOUBLE-BOUND — cost side: stop the loop if this ticket's cumulative measured
    # rework spend has reached the per-ticket ceiling, even when attempts remain. No
    # unbounded token burn on one stubborn ticket.
    local _cost_exhausted=0
    # TRACK-3a: the FIRST-CLASS per-ticket delivery budget (tickets.delivery_budget_usd,
    # inherited from the epic) is the ceiling when set; else the factory-wide env
    # default (GAFFER_REWORK_BUDGET_USD). A per-ticket budget lets an operator cap one
    # expensive ticket without touching the global default.
    local _ticket_budget _eff_ceiling
    _ticket_budget="$(printf '%s' "${SHOW:-}" | jget 'd.ticket.delivery_budget_usd' 2>/dev/null || true)"
    case "$_ticket_budget" in ""|None|null) _ticket_budget="" ;; esac
    if [ -n "$_ticket_budget" ] && _num_pos "$_ticket_budget"; then
      _eff_ceiling="$_ticket_budget"
    else
      _eff_ceiling="${GAFFER_REWORK_BUDGET_USD:-}"
    fi
    if [ -n "$_eff_ceiling" ] \
       && _num_pos "$_eff_ceiling"; then
      local _spent; _spent="$(gaffer_ticket_rework_spend "$NUM" 2>/dev/null || echo 0)"
      if _num_ge "$_spent" "$_eff_ceiling"; then
        _cost_exhausted=1
        local _src="factory default"; [ -n "$_ticket_budget" ] && _src="per-ticket budget"
        log "REWORK: #$NUM hit the ${_src} cost ceiling (spent \$${_spent} ≥ \$${_eff_ceiling}) on attempt $_DELIV_ATTEMPT — parking to blocked (no unbounded burn)"
      fi
    fi

    if [ "$_DELIV_ATTEMPT" -lt "$_MAX_DELIVERY_ATTEMPTS" ] && [ "$_cost_exhausted" -eq 0 ] && [ "$_repeat" -eq 0 ]; then
      # VISIBILITY: keep the ticket in its live column but surface the rework state +
      # the latest real failure on the card ("Reworking · attempt N/M"). No status
      # change — it stays claimed/in_progress (visible), never routed to refining.
      local _next=$((_DELIV_ATTEMPT + 1))
      local _short; _short="$(printf '%s' "$real" | grep -v '^[[:space:]]*$' | head -1)"
      # FAILURE-DIAGNOSIS: pass BOTH the short one-line reason (the board chip) AND
      # the FULL distilled failure ($real — the real failing test + assertion/stack)
      # so the durable per-ticket trail keeps the full block, not the truncated
      # summary. Fail-soft: a persist error never fails the delivery loop.
      [ "${DRY_RUN:-0}" = "1" ] || wg runner-rework "$NUM" --attempt "$_next" --max "$_MAX_DELIVERY_ATTEMPTS" \
        --reason "${gate}: ${_short:-failed}" --gate "$gate" --failure "$real" >/dev/null 2>&1 || true
      # Preserve the branch; tear down only the worktree so the next attempt re-adds
      # a fresh worktree on the SAME branch (the branch ref + its history live in the
      # real repo between attempts).
      gaffer_cleanup_worktrees
      log "RECOVER: #$NUM $gate failed on attempt $_DELIV_ATTEMPT — branch $WORK_BRANCH PRESERVED; re-invoking the agent with the real failure (attempt $_next/$_MAX_DELIVERY_ATTEMPTS)"
      gaffer_manifest_finish "rework:$gate"
      _DELIV_OUTCOME="retry"
      return 0
    fi

    # Cap OR per-ticket cost ceiling hit — park to the VISIBLE `blocked` column WITH
    # the branch + feedback (rework_exhausted). NEVER drop the branch: a delivery with
    # commits keeps its salvageable work. RUNNER-OWNED-BOOKKEEPING: the runner holds
    # the claim and has NOT submitted (the gate ran pre-submit), so the ticket is
    # `claimed`/`in_progress` — release/park it via the runner-release path so the
    # claim is freed AND a human immediately sees it on the board (never `refining`,
    # which hides in the draft column). A stray in_review ticket is unreachable here
    # (the runner submits only AFTER the gate passes); if one ever occurred the
    # runner-release transition is a no-op that logs a loud WARNING — fail-safe.
    local _why="rework budget"; [ "$_cost_exhausted" -eq 0 ] && _why="$_MAX_DELIVERY_ATTEMPTS attempts"
    [ "$_repeat" -eq 1 ] && _why="an identical failure on attempts $((_DELIV_ATTEMPT - 1)) and $_DELIV_ATTEMPT (not converging; $((_MAX_DELIVERY_ATTEMPTS - _DELIV_ATTEMPT)) attempt(s) not spent)"
    local _reason="$gate failed after $_why: $real (branch $WORK_BRANCH preserved)"
    # FAILURE TRAIL: the attempt that used up the bounds failed too, so it goes on the
    # trail like every earlier one (same numbering: the failure of attempt N is filed
    # as N+1), BEFORE the park. `--final` appends the trail row only — no "reworking"
    # card or event; the release below sets the parked card. Without it the ticket page
    # read "Attempt N/N not taken" for an attempt that was tried. Fail-soft.
    local _fshort; _fshort="$(printf '%s' "$real" | grep -v '^[[:space:]]*$' | head -1)"
    gaffer_manifest_finish "park:$gate"
    [ "${DRY_RUN:-0}" = "1" ] || wg runner-rework "$NUM" --attempt "$((_DELIV_ATTEMPT + 1))" --max "$_MAX_DELIVERY_ATTEMPTS" \
      --reason "${gate}: ${_fshort:-failed}" --gate "$gate" --failure "$real" --final >/dev/null 2>&1 || true
    gaffer_release_delivery blocked "$_reason" rework_exhausted "$_DELIV_ATTEMPT" "$_MAX_DELIVERY_ATTEMPTS"
    # MEMORY FEEDBACK LOOP: this ticket exhausted rework and parked to blocked —
    # the knowledge served into its context did NOT help. Demote + flag it.
    gaffer_recall_feedback blocked
    log "RECOVER: parked #$NUM (→ blocked, rework_exhausted) after $_why — branch $WORK_BRANCH PRESERVED for rework, VISIBLE on the board"
    # Tear down ONLY the worktree; the branch survives for rework.
    gaffer_cleanup_worktrees
    gaffer_skip_ticket "$NUM"
    log "delivery PARKED for #$NUM — $gate not met (rework_exhausted, $_why); worktree removed, branch $WORK_BRANCH PRESERVED, VISIBLE in blocked"
    _DELIV_OUTCOME="parked"
    return 0
  }

  # ESCALATION LADDER — build the per-attempt prompt suffix + implement-model flag.
  # Sets two globals read by the invocation below:
  #   _REWORK_BLOCK       — appended to the base PROMPT so the re-invoked agent sees
  #                         the REAL prior failure(s) + its escalation posture.
  #   _ATTEMPT_IMPL_FLAG  — the model flag for THIS attempt (routed model by default;
  #                         the FINAL attempt escalates to the rework model,
  #                         _GAFFER_REWORK_MODEL from GAFFER_ROLE_MODELS rework=).
  # Attempt 1: routed model, no rework suffix (base prompt).
  # Attempt 2..(max-1): RETHINK — same model, but re-plan the approach (the prior
  #                     approach failed the SAME gate; a tweak won't do) with the trail.
  # Attempt max: STRONGER MODEL + the FULL feedback history (the last shot before a
  #              human is pulled in).
  gaffer_build_escalation() {
    local attempt="$1"
    _ATTEMPT_IMPL_FLAG="$ROUTE_IMPL_FLAG"
    _REWORK_BLOCK=""
    [ "$attempt" -le 1 ] && return 0
    local is_final=0
    [ "$attempt" -ge "$_MAX_DELIVERY_ATTEMPTS" ] && is_final=1
    # Model escalation only on the FINAL attempt (and only if a strong model is set
    # and the loop actually has >1 attempt to climb).
    local posture
    if [ "$is_final" = "1" ] && [ "$_MAX_DELIVERY_ATTEMPTS" -gt 1 ] && [ -n "${_GAFFER_REWORK_MODEL:-}" ]; then
      _ATTEMPT_IMPL_FLAG="--model $_GAFFER_REWORK_MODEL"
      posture="FINAL REWORK ATTEMPT (attempt $attempt/$_MAX_DELIVERY_ATTEMPTS) — you are the STRONGEST model on this ticket and this is the LAST attempt before it is parked to \`blocked\` for a human. The previous attempts failed the gate below. Do NOT repeat them: read the FULL failure trail, form a correct fix, and make every gate pass."
    else
      posture="RETHINK (attempt $attempt/$_MAX_DELIVERY_ATTEMPTS) — your previous approach FAILED the same gate. Do NOT just tweak it: step back, RE-PLAN the approach from the failure below (optionally narrow the scope to the smallest correct change), then implement and make the gate pass."
    fi
    # The failure trail is UNTRUSTED gate output — quarantine it (same envelope as the
    # prior-review-feedback block) so an injected string in a test name can't steer the agent.
    local _trail_q; _trail_q="$(gaffer_quarantine rework-feedback "$_REWORK_HISTORY" 2>/dev/null || printf '%s' "$_REWORK_HISTORY")"
    _REWORK_BLOCK="
REVIEW FEEDBACK — THIS DELIVERY WAS REWORKED. $posture
The block below is the ACTUAL failure(s) from your prior attempt(s) on this SAME
branch (the failing test name + the assertion/error), not a summary. The prior
attempt's commits are still on this branch — keep what is right and fix what failed.
Fix EXACTLY this:
$_trail_q
"
  }

  # ── TICK DEADLINE GUARD (GAFFER_TICK_DEADLINE_GUARD) ────────────────────────
  # The outer per-tick bound is sized for agent calls only (attempts × timeout + 2 min)
  # but this tick also spent the merge lane, setup and each attempt's install, gates
  # and AC checks; a live run had its FINAL strong-model attempt killed mid-flight —
  # spend wasted, nothing recorded, the branch at the trap's mercy, and the next tick
  # re-claiming from attempt 1. Before starting an attempt, require the time left to
  # cover one full agent call plus what the previous attempt's gates took; otherwise
  # hand the ticket to the next tick with its branch kept (released to ready, bounded
  # across runs through the same counter as a no-commit failure). Gate/AC timeouts
  # are clamped to the time left so a gate cannot outlive the bound either.
  # Attempt 1 is never refused for a short budget (nothing is spent yet, and a slow
  # merge lane or first install would otherwise park a ticket that was never tried):
  # its agent call is instead clamped to the time left, so the call's own timeout
  # (pause-eligible, work kept) fires before the outer bound would kill the tick. It
  # is handed off only when no time is left at all.
  _GATE_SECS_LAST=0; _T_AGENT_DONE=""
  _DOD_TIMEOUT_CFG="${GAFFER_DOD_TIMEOUT:-900}"; _DOD_INSTALL_TIMEOUT_CFG="${GAFFER_DOD_INSTALL_TIMEOUT:-$_DOD_TIMEOUT_CFG}"
  _TICK_TIMEOUT_CFG="${GAFFER_TICK_TIMEOUT:-1800}"; _AGENT_TIMEOUT="$_TICK_TIMEOUT_CFG"
  gaffer_deadline_short() {
    local rem need
    rem="$(gaffer_tick_remaining)"
    need=$(( _TICK_TIMEOUT_CFG + ${_GATE_SECS_LAST:-0} ))
    _AGENT_TIMEOUT="$_TICK_TIMEOUT_CFG"
    [ "$rem" -lt "$need" ] || return 1
    _DEADLINE_REM="$rem"; _DEADLINE_NEED="$need"
    if [ "$_DELIV_ATTEMPT" -le 1 ] && [ "$rem" -ge 1 ]; then
      [ "$rem" -lt "$_AGENT_TIMEOUT" ] && _AGENT_TIMEOUT="$rem"
      log "DEADLINE: #$NUM attempt 1 has ${rem}s before the outer per-tick bound (needs ~${need}s) — starting it with the agent call clamped to ${_AGENT_TIMEOUT}s"
      return 1
    fi
    return 0
  }
  gaffer_deadline_handoff() {
    local why="attempt $_DELIV_ATTEMPT/$_MAX_DELIVERY_ATTEMPTS needs ~${_DEADLINE_NEED}s (GAFFER_TICK_TIMEOUT ${_TICK_TIMEOUT_CFG}s + ${_GATE_SECS_LAST:-0}s of gates) but only ${_DEADLINE_REM}s are left before the outer per-tick bound"
    log "DEADLINE: #$NUM $why — not starting it; the next tick continues on branch $WORK_BRANCH"
    # Keep the branch (a retry already tore the worktree down, so its commits can only
    # be seen on the branch itself); an empty one is simply re-created next tick.
    GAFFER_KEEP_DELIVERY_BRANCH=1
    gaffer_cleanup_worktrees
    if [ "$_RESUMING" = "1" ]; then
      gaffer_resume_abort "tick deadline: $why"
    else
      gaffer_release_or_park_nocommit "tick deadline: $why; branch kept for the next tick" \
        "the rework ladder did not fit inside one tick's outer bound"
    fi
    gaffer_skip_ticket "$NUM"
  }
  gaffer_clamp_gate_timeouts() {
    local rem; rem="$(gaffer_tick_remaining)"
    [ "$rem" -ge 1 ] || rem=1
    GAFFER_DOD_TIMEOUT="$_DOD_TIMEOUT_CFG"; GAFFER_DOD_INSTALL_TIMEOUT="$_DOD_INSTALL_TIMEOUT_CFG"
    [ "$rem" -lt "$GAFFER_DOD_TIMEOUT" ] 2>/dev/null && GAFFER_DOD_TIMEOUT="$rem"
    [ "$rem" -lt "$GAFFER_DOD_INSTALL_TIMEOUT" ] 2>/dev/null && GAFFER_DOD_INSTALL_TIMEOUT="$rem"
    return 0
  }

  while [ "$_DELIV_ATTEMPT" -lt "$_MAX_DELIVERY_ATTEMPTS" ]; do
  _DELIV_ATTEMPT=$((_DELIV_ATTEMPT + 1))
  _DELIV_OUTCOME=""
  if [ "${DRY_RUN:-0}" != "1" ] && gaffer_deadline_short; then
    gaffer_deadline_handoff
    result error; exit 0
  fi
  # RUNNER-OWNED-BOOKKEEPING: heartbeat the runner-held claim at the start of each
  # attempt so the lease covers the whole delivery even across retries (belt-and-
  # braces with the generously-sized GAFFER_CLAIM_TTL). No-op when the runner holds
  # no token (a tokenless resume fallback). Best-effort — a failed heartbeat is logged, and
  # the generous TTL still covers the delivery.
  [ -n "${CLAIM_TOKEN:-}" ] && { wg heartbeat -- "$CLAIM_TOKEN" >/dev/null 2>&1 || log "heartbeat for #$NUM claim failed (non-fatal; TTL still covers the delivery)"; }
  # ESCALATION: pick THIS attempt's implement-model + rework prompt suffix from the
  # ladder (routed model + base prompt on attempt 1; rethink; then stronger model +
  # full failure trail on the final attempt).
  gaffer_build_escalation "$_DELIV_ATTEMPT"
  if [ "$_DELIV_ATTEMPT" -gt 1 ]; then
    log "delivery for #$NUM — re-invoking agent (attempt $_DELIV_ATTEMPT/$_MAX_DELIVERY_ATTEMPTS) on branch $WORK_BRANCH [impl-model: ${_ATTEMPT_IMPL_FLAG:-default}]"
  fi
  # On a retry the prior worktree was torn down (branch preserved); re-add a fresh
  # worktree on the SAME branch so the agent re-delivers from the recorded feedback.
  if [ "$_DELIV_ATTEMPT" -gt 1 ]; then
    while IFS=$'\t' read -r rid rname rpath rbase rwt; do
      [ -n "$rpath" ] || continue
      rbase="${rbase:-main}"
      git -C "$rpath" rev-parse --git-dir >/dev/null 2>&1 || continue
      git -C "$rpath" worktree prune >/dev/null 2>&1 || true
      mkdir -p "$WORKTREES_BASE"
      # Re-checkout the EXISTING branch (no -B reset) so the prior attempt's commits
      # are the starting point for rework. Fall back to -B off base if the branch
      # somehow vanished (defensive — it should always exist).
      if ! git -C "$rpath" worktree add "$rwt" "$WORK_BRANCH" >/dev/null 2>&1; then
        if git -C "$rpath" worktree add -B "$WORK_BRANCH" "$rwt" "$rbase" >/dev/null 2>&1; then
          _BRANCH_CREATED_THIS_TICK+="$rpath"$'\n'
          _gaffer_note_branch_cut "$rpath"        # re-cut off base: a new base commit
        fi
      fi
      gaffer_link_node_modules "$rpath" "$rwt"
    done <<< "$WT_ROWS"
    # A branch re-cut off base above has a new base commit (others keep theirs).
    _gaffer_record_delivery_bases
    # RE-INSTALL the agent environment into the FRESH worktree. The rework
    # teardown destroyed the untracked runner config with the old worktree — a
    # fresh checkout has NO .claude/settings.json (the safety-hook wiring!),
    # no skills mount and no brief. FAIL-CLOSED: never launch an attempt
    # uncontained — an install failure is THIS attempt's failure (retry with
    # the reason, or park when the bounds are spent); the agent is NOT run.
    if ! gaffer_install_agent_env; then
      _recover_or_park "agent-env-install" "could not install the agent environment (safety-hook settings, skills mount, brief) into the retry worktree — the agent was NOT launched for this attempt (fail closed)"
      [ "$_DELIV_OUTCOME" = "retry" ] && continue
      result error; exit 0
    fi
  fi
  gaffer_tick_launch_attempt   # lib/tick-launch.sh: pre-spawn budget gate, launch via the worker seam, post-call accounting

  # A failed delivery (non-zero rc): classify RECOVERABLE vs UNRECOVERABLE.
  #   • UNRECOVERABLE (no commit on any branch / crash / timeout with no work):
  #     roll back the worktrees AND delete the gaffer/ branch so a botched run
  #     leaves the real repo 100% clean — today's behaviour, unchanged.
  #   • RECOVERABLE (≥1 commit produced before the non-zero exit): the branch
  #     holds salvageable work, so PRESERVE the branch, attach the rc as feedback,
  #     and retry-or-park (GUARD B). The INVARIANT: a delivery with ≥1 commit is
  #     never branch-dropped by a failure path.
  if [ "$rc" -ne 0 ]; then
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      _recover_or_park "agent-exit" "agent exited non-zero (rc=$rc) after committing work — retrying on the same branch with this context"
      [ "$_DELIV_OUTCOME" = "retry" ] && continue
      result error; exit 0
    fi
    gaffer_manifest_finish "failed:no-commit" "$rc"
    gaffer_cleanup_worktrees drop-branch
    # RUNNER-OWNED-BOOKKEEPING: nothing was produced — release the runner-held claim
    # back to `ready` so a later tick can retry cleanly (skip-file prevents a re-pick
    # THIS run), BOUNDED across runs (FINDING-3): after GAFFER_MAX_NOCOMMIT_FAILURES
    # such failures (or once the per-ticket cost ceiling is spent) the wrapper parks
    # to `blocked` (rework_exhausted) instead — a deterministic agent crash can no
    # longer burn one full agent call per run forever.
    gaffer_release_or_park_nocommit "delivery failed: agent exited non-zero (rc=$rc) with no commits; branch dropped for retry"
    gaffer_skip_ticket "$NUM"
    log "delivery FAILED for #$NUM (rc=$rc) — no commits produced; removed worktrees + branch $WORK_BRANCH; skipping it for the rest of this run"
    result error; exit 0
  fi

  # Branch assertion (FG-008: "verifies current branch after agent execution"):
  # the runner created each WORKTREE on the ticket branch, so EACH worktree's HEAD
  # MUST still be on a gaffer/ branch (and NOT the repo's default branch) — recording
  # a delivery on the wrong branch would attribute work to it. In single-repo mode this
  # is exactly today's single-repo assertion, just checked on the worktree.
  # BRANCH-SWITCH RECOVERY: an agent that switched away (`checkout -b x`, `switch -c`,
  # a detached `checkout <sha>`, back onto the default branch) used to get the whole
  # delivery failed with the ticket branch DELETED — a rework's reviewed commits with
  # it — while its own commits were stranded on an unswept branch, and the failure was
  # counted as "no commits". Now, per worktree:
  #   • HEAD still contains $WORK_BRANCH and every commit on top of it was made by the
  #     agent (none was reachable from any ref at spawn, see _PRESPAWN_REFS): fast-
  #     forward $WORK_BRANCH to HEAD and check it out again (same commit, so uncommitted
  #     edits carry over) and carry on to the gates. A branch the agent CREATED is then
  #     deleted once fully contained; a branch that existed before the spawn (the
  #     user's) is never deleted, and if the agent committed on it, it is put back to
  #     its pre-spawn sha (the commits now live on $WORK_BRANCH);
  #   • otherwise (diverged, or HEAD carries commits that existed before the spawn,
  #     e.g. the agent checked out a user's branch): leave $WORK_BRANCH as it was, KEEP
  #     the stray branch (logged with its sha for a human to salvage), put the worktree
  #     back on $WORK_BRANCH so a retry runs on the right branch, and retry-or-park when
  #     the ticket branch carries commits. Only a branch with nothing on it is dropped.
  _BS_FAIL=""; _BS_FAIL_REPO=""
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    rbase="${rbase:-main}"
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    HEAD_BRANCH="$(git -C "$rwt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
    case "$HEAD_BRANCH" in
      "$WORK_BRANCH") continue ;;
      "$rbase"|"") : ;;
      gaffer/*) continue ;;  # on a runner-owned branch as expected
      *) : ;;
    esac
    _bs_head="$(git -C "$rwt" rev-parse --verify --quiet HEAD 2>/dev/null || echo '')"
    _bs_pre=""
    case "$HEAD_BRANCH" in
      ""|HEAD) : ;;
      *) _bs_pre="$(gaffer_snapshot_sha "$_PRESPAWN_REFS" "$rpath" "$HEAD_BRANCH" || true)" ;;
    esac
    _bs_why="does not contain $WORK_BRANCH"
    if [ -n "$_bs_head" ] && git -C "$rwt" merge-base --is-ancestor "$WORK_BRANCH" "$_bs_head" 2>/dev/null; then
      _bs_why="carries commits that existed before the agent ran (not the agent's work)"
      if gaffer_commits_all_new "$_PRESPAWN_REFS" "$rpath" "$WORK_BRANCH" "$_bs_head" \
         && git -C "$rwt" checkout -q -B "$WORK_BRANCH" "$_bs_head" >/dev/null 2>&1; then
        log "RECOVERED branch switch for #$NUM in ${rname:-repo}: the agent left $WORK_BRANCH for '${HEAD_BRANCH:-?}' but only built on it — $WORK_BRANCH fast-forwarded to $(printf '%s' "$_bs_head" | cut -c1-12) and checked out again"
        case "$HEAD_BRANCH" in
          ""|HEAD|gaffer/*) : ;;
          *) if [ -z "$_bs_pre" ]; then
               # The agent created it: delete it once it holds nothing $WORK_BRANCH lacks.
               if [ "$(git -C "$rpath" rev-parse --verify --quiet "refs/heads/$HEAD_BRANCH" 2>/dev/null)" = "$_bs_head" ]; then
                 git -C "$rpath" branch -D "$HEAD_BRANCH" >/dev/null 2>&1 \
                   && log "RECOVERED branch switch for #$NUM: deleted the agent's stray branch '$HEAD_BRANCH' (fully contained in $WORK_BRANCH)"
               fi
             elif [ "$_bs_pre" != "$_bs_head" ] \
                  && ! grep -qxF "branch refs/heads/$HEAD_BRANCH" <<<"$(git -C "$rpath" worktree list --porcelain 2>/dev/null)"; then
               # A pre-existing branch the agent committed on: put it back (compare-and-
               # swap, so a concurrent move by its owner wins) — the commits are on $WORK_BRANCH.
               git -C "$rpath" update-ref "refs/heads/$HEAD_BRANCH" "$_bs_pre" "$_bs_head" >/dev/null 2>&1 \
                 && log "RECOVERED branch switch for #$NUM: restored pre-existing branch '$HEAD_BRANCH' to $(printf '%s' "$_bs_pre" | cut -c1-12) (the agent's commits are on $WORK_BRANCH)"
             fi ;;
        esac
        continue
      fi
    fi
    # Diverged, foreign commits, or HEAD unreadable: never move $WORK_BRANCH; the stray
    # work stays where the agent put it. Re-checkout $WORK_BRANCH so the worktree (and
    # any retry) is on it.
    log "BRANCH SWITCH: #$NUM worktree for ${rname:-repo} ($rwt) is on '${HEAD_BRANCH:-?}' at ${_bs_head:-unknown}, which $_bs_why — $WORK_BRANCH left as it was, '${HEAD_BRANCH:-?}' / ${_bs_head:-?} kept for a human to salvage"
    git -C "$rwt" checkout -q -f "$WORK_BRANCH" >/dev/null 2>&1 || true
    _BS_FAIL="worktree HEAD '${HEAD_BRANCH:-?}' (${_bs_head:-?}) $_bs_why"
    _BS_FAIL_REPO="${rname:-repo} ($rwt)"
  done <<< "$WT_ROWS"
  if [ -n "$_BS_FAIL" ]; then
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      # The ticket branch carries work (a rework's reviewed commits, or this attempt's):
      # recoverable, never dropped. The feedback tells the agent to stay on the branch.
      _recover_or_park "branch" "you switched branches ($_BS_FAIL in $_BS_FAIL_REPO); commit ONLY on $WORK_BRANCH — never create, switch or detach branches"
      [ "$_DELIV_OUTCOME" = "retry" ] && continue
      result error; exit 0
    fi
    gaffer_cleanup_worktrees drop-branch
    gaffer_release_or_park_nocommit "delivery failed: $_BS_FAIL; $WORK_BRANCH had no commits and was dropped"
    gaffer_skip_ticket "$NUM"
    log "delivery FAILED for #$NUM — $_BS_FAIL in $_BS_FAIL_REPO; $WORK_BRANCH had no commits (removed with the worktrees), not recording delivery"
    result error; exit 0
  fi

  # ── Auto-commit safety net ─────────────────────────────────────────────────
  # Agents sometimes EDIT files but STOP WITHOUT running git commit; the change then
  # vanishes as an "empty" (0-commit) branch and the ticket is
  # parked, losing correct work. If a write-repo worktree has uncommitted changes,
  # commit them on the gaffer/ branch so a forgotten commit never drops the work.
  # Runner config is git-excluded + hygiene-forbidden, so this captures only the
  # real delivery; the minimalism/hygiene gates still inspect the committed diff.
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    if [ -n "$(git -C "$rwt" status --porcelain 2>/dev/null)" ]; then
      # Exclude non-deliverables at the `git add` itself (pathspec), so this can't be
      # defeated by gitignore gaps (the node_modules SYMLINK the runner creates escapes
      # the `node_modules/` dir-pattern) or by exclude-file state. Deterministic.
      # BUG 4 fix: also exclude nested node_modules (packages/*/node_modules etc.)
      # using the glob pathspec; the top-level ':(exclude)node_modules' alone does
      # NOT match paths like packages/web/node_modules added by workspace symlinks.
      git -C "$rwt" add -A -- . \
        ':(exclude)node_modules' ':(exclude,glob)**/node_modules/**' \
        ':(exclude).claude' ':(exclude)CLAUDE.factory.md' \
        ':(exclude).mcp.json' ':(exclude,glob)mcp-runtime*.json' ':(exclude)dist' ':(exclude)build' \
        ':(exclude).next' ':(exclude)coverage' \
        ':(exclude).terraform' ':(exclude,glob)**/.terraform/**' >/dev/null 2>&1
      # The commit needs an identity; the repo's own when it has one (a host with none, such
      # as a CI runner, parked every uncommitted delivery as empty before this).
      _ac_ids=()
      git -C "$rwt" config user.email >/dev/null 2>&1 || _ac_ids=(-c user.email=gaffer@factory -c user.name=gaffer)
      if _ac_err="$(git -C "$rwt" ${_ac_ids[@]+"${_ac_ids[@]}"} commit -q -m "deliver #$NUM: $TITLE" 2>&1 >/dev/null)"; then
        log "auto-committed uncommitted changes for #$NUM in ${rname:-repo} (agent edited but did not commit)"
      else
        log "auto-commit failed for #$NUM in ${rname:-repo}: $(printf '%s' "$_ac_err" | tr '\n' ' ' | cut -c1-200)"
      fi
    fi
  done <<< "$WT_ROWS"

  # ── Re-queue/park policy: EMPTY delivery (0 commits / no diff) → PARK ───────
  # A delivery that produced no change is never blind-retried: the agent couldn't
  # action the ticket as specified. RUNNER-OWNED-BOOKKEEPING: the runner holds the
  # claim and has NOT submitted (the gate runs pre-submit), so it releases/parks the
  # held claim to `refining` (needs triage) directly — replacing the old status-probe
  # fallback that existed only because the AGENT used to submit and might not have.
  # Computed across ALL write repos: empty only if EVERY write repo's branch diff is
  # empty.
  ANY_DIFF=0
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    rbase="${rbase:-main}"
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    if [ -n "$(git -C "$rwt" diff --name-only "$rbase"...HEAD 2>/dev/null)" ]; then ANY_DIFF=1; break; fi
  done <<< "$WT_ROWS"
  if [ "$ANY_DIFF" = "0" ]; then
    log "EMPTY delivery for #$NUM — 0 commits / no diff across all write repos; parking (no blind retry)"
    wg attach-evidence "$NUM" --type manual_note \
      --summary "PARKED: empty delivery (no diff produced) — routing to refinement, not retrying blindly" >/dev/null 2>&1 || true
    gaffer_release_delivery refining "empty delivery: agent produced no change — needs clarification/refinement"
    # FINDING-3: the ticket leaves the delivery pipeline (human triage) — reset the
    # cross-run no-commit counter so the post-refinement retry budget starts fresh.
    gaffer_nocommit_clear "$NUM"
    gaffer_cleanup_worktrees drop-branch
    gaffer_skip_ticket "$NUM"
    log "delivery PARKED for #$NUM — empty; removed worktrees + branch $WORK_BRANCH"
    result error; exit 0
  fi

  # ── Stabilisation gate 1: DELIVERY HYGIENE (HARD FAIL) ──────────────────────
  # BEFORE we record/submit the delivery, assert each write repo's branch diff is
  # hygienic. This catches the leaks a large unattended run produced: a copied
  # source tree in a repo root (src.ticket9/), a leaked .crew/events.jsonl,
  # self-referential/broken symlinks (node_modules -> itself, .claude/skills), or
  # any node_modules path added OR deleted. A violation PARKS the ticket (review
  # reject --to refining with the reason, or block as a fallback) and FAILS the
  # tick — the delivery is NEVER submitted/recorded. HYGIENE_ENFORCE=0 downgrades
  # the hard fail to a logged warning (debugging only).
  HYGIENE_REASONS=""
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    rbase="${rbase:-main}"
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    _hy="$(gaffer_assert_clean_delivery "$rwt" "$rbase" 2>/dev/null)" || \
      HYGIENE_REASONS+="[${rname:-repo}] $_hy"$'\n'
  done <<< "$WT_ROWS"
  HYGIENE_REASONS="$(printf '%s' "$HYGIENE_REASONS" | sed '/^$/d')"
  if [ -n "$HYGIENE_REASONS" ]; then
    log "HYGIENE: delivery for #$NUM is NOT hygienic:"$'\n'"$HYGIENE_REASONS"
    if [ "${HYGIENE_ENFORCE:-1}" = "1" ]; then
      # RECOVERABLE (GUARD B): the agent produced commits — a hygiene violation
      # (a leaked path on the branch) is fixable on a re-delivery, and the
      # invariant forbids dropping a committed branch. Preserve the branch, attach
      # the violation as feedback, and retry-or-park. The next attempt re-checks
      # out the SAME branch and the feedback names the offending paths to remove.
      _HY_FLAT="$(printf '%s' "$HYGIENE_REASONS" | tr '\n' ' ')"
      if gaffer_any_branch_has_commits "$WT_ROWS"; then
        _recover_or_park "hygiene" "delivery hygiene violation — remove these leaked paths and re-deliver: $_HY_FLAT"
        [ "$_DELIV_OUTCOME" = "retry" ] && continue
        result error; exit 0
      fi
      # No commits (e.g. a leak that is purely a worktree artifact with no diff):
      # there is nothing salvageable on the branch — drop it. RUNNER-OWNED-
      # BOOKKEEPING: release/park the held claim to refining directly (pre-submit).
      wg attach-evidence "$NUM" --type manual_note \
        --summary "PARKED: delivery hygiene violation (not submitted):"$'\n'"$HYGIENE_REASONS" >/dev/null 2>&1 || true
      gaffer_release_delivery refining "delivery hygiene violation: $_HY_FLAT"
      # FINDING-3: leaves the delivery pipeline — reset the cross-run no-commit counter.
      gaffer_nocommit_clear "$NUM"
      gaffer_cleanup_worktrees drop-branch
      gaffer_skip_ticket "$NUM"
      log "delivery FAILED for #$NUM — hygiene violation, no commits; parked, removed worktrees + branch $WORK_BRANCH, not recording delivery"
      result error; exit 0
    else
      log "HYGIENE_ENFORCE=0 — logging the violation but NOT failing the tick (debugging mode)"
    fi
  fi

  # ── Stabilisation gate 2: MINIMALISM post-condition ─────────────────────────
  # Compute files/lines from the PRIMARY write repo's branch diff and require a
  # recorded smallest-change note. A MISSING note is flagged needs_human_review by
  # default (the human judges minimality from the diff at review); with
  # MINIMALISM_REQUIRE_NOTE=1 it FAILS the post-condition (back to rework) so an
  # unjustified change can't glide through an unsupervised run. An OVERSIZED diff
  # does NOT fail — it flags the ticket needs_human_review: oversized_diff visibly
  # (recorded as an evidence note) and proceeds. Size is judged on its own: a
  # delivery with a missing or boilerplate note that is ALSO over a cap carries
  # both flags (GAFFER_MINIMALISM_OVERSIZED), never just the first one found.
  if git -C "$PRIMARY_REPO" rev-parse --git-dir >/dev/null 2>&1; then
    read -r _MZ_FILES _MZ_LINES <<< "$(gaffer_diff_stats "$PRIMARY_REPO" "$DEFAULT_BRANCH")"
    # The smallest-change note is whatever the agent recorded as evidence: the NEWEST
    # evidence row carrying a "smallest-change"/"smallest change" marker (the
    # minimalism + record-evidence skills emit one; on a resume, the runner-recorded
    # "resume agent report"), never the runner's own flag rows or events.
    _MZ_NOTE="$(wg ticket show "$NUM" 2>/dev/null | gaffer_json smallest-change-note 2>/dev/null || echo '')"
    _MZ_CHANGED="$(git -C "$PRIMARY_REPO" diff --name-only "$DEFAULT_BRANCH"...HEAD 2>/dev/null | tr '\n' ' ')"
    # Run in THIS shell (NOT a $() subshell) so gaffer_check_minimalism's
    # GAFFER_MINIMALISM_REASON / GAFFER_MINIMALISM_VERDICT globals propagate here. A $()
    # subshell loses them, and the references below then hit "unbound variable" under
    # `set -u` — failing the gate OPEN. The verdict is read from the global, never a
    # fixed scratch file: $GAFFER_DATA is shared by every worker under
    # GAFFER_CONCURRENCY>1, and a shared .mz-verdict let one delivery read another's.
    GAFFER_MINIMALISM_VERDICT=""
    gaffer_check_minimalism "${_MZ_FILES:-0}" "${_MZ_LINES:-0}" "$_MZ_NOTE" "$_MZ_CHANGED" >/dev/null 2>&1 || true
    _MZ_VERDICT="${GAFFER_MINIMALISM_VERDICT:-}"
    : "${GAFFER_MINIMALISM_REASON:=minimalism check produced no reason}"   # belt: never unbound under set -u
    case "$_MZ_VERDICT" in
      missing_note)
        # Missing smallest-change note is a FLAG by default (needs_human_review) — the
        # delivery proceeds to REVIEW where the human judges minimality from the actual
        # diff (now visible in the UI). Set MINIMALISM_REQUIRE_NOTE=1 to HARD-FAIL (park)
        # on a missing note instead, for fully-unsupervised runs that need the gate.
        if [ "${MINIMALISM_REQUIRE_NOTE:-0}" = "1" ]; then
          log "MINIMALISM: #$NUM has NO smallest-change note — failing (MINIMALISM_REQUIRE_NOTE=1) ($_MZ_FILES files / $_MZ_LINES lines)"
          # RECOVERABLE (GUARD B): a committed diff with a missing smallest-change
          # note is fixable on a re-delivery (the agent records the note). The diff
          # is non-empty here (asserted earlier), so the branch carries commits —
          # preserve it, attach the reason as feedback, and retry-or-park.
          _recover_or_park "minimalism" "minimalism post-condition failed — $GAFFER_MINIMALISM_REASON (computed: ${_MZ_FILES} files / ${_MZ_LINES} lines); record a smallest-change note and re-deliver"
          [ "$_DELIV_OUTCOME" = "retry" ] && continue
          result error; exit 0
        else
          log "MINIMALISM: #$NUM missing smallest-change note — flagging needs_human_review (not failing); human judges minimality from the diff at review"
          wg attach-evidence "$NUM" --type manual_note \
            --summary "needs_human_review: missing smallest-change note ($GAFFER_MINIMALISM_REASON) — judge minimality from the diff" >/dev/null 2>&1 || true
        fi ;;
      oversized_diff)
        # Visible flag, NOT a fail: record a review note + proceed to submit.
        log "MINIMALISM: #$NUM oversized — flagging needs_human_review:oversized_diff ($GAFFER_MINIMALISM_REASON)"
        wg attach-evidence "$NUM" --type manual_note \
          --summary "needs_human_review: oversized_diff — $GAFFER_MINIMALISM_REASON" >/dev/null 2>&1 \
          && log "MINIMALISM: recorded oversized_diff flag on #$NUM" || true ;;
      check_failed)
        # The typed check could not run (packages/crew not built, or the CLI
        # errored). A gate that cannot decide never waves a delivery through:
        # recoverable, because a rebuilt factory re-runs the same check.
        log "MINIMALISM: #$NUM check could not run — $GAFFER_MINIMALISM_REASON; not submitting"
        _recover_or_park "minimalism" "minimalism check could not run — $GAFFER_MINIMALISM_REASON"
        [ "$_DELIV_OUTCOME" = "retry" ] && continue
        result error; exit 0 ;;
      unverified_note)
        # Note present but references no changed file → likely boilerplate. Flag
        # for human review (not a hard fail — a conceptual note can be legitimate).
        log "MINIMALISM: #$NUM unverified note — flagging needs_human_review:unverified_minimalism_note ($GAFFER_MINIMALISM_REASON)"
        wg attach-evidence "$NUM" --type manual_note \
          --summary "needs_human_review: unverified_minimalism_note — $GAFFER_MINIMALISM_REASON" >/dev/null 2>&1 \
          && log "MINIMALISM: recorded unverified_note flag on #$NUM" || true ;;
      ok)
        log "MINIMALISM: #$NUM within caps ($_MZ_FILES files / $_MZ_LINES lines)" ;;
      *)
        # Empty/unrecognised verdict = gaffer_check_minimalism crashed or produced no
        # output. A crash must NOT be treated as a pass (the `ok` arm above) — that would
        # silently skip the gate. Fail closed: flag for human review, or hard-fail when the
        # note gate is required for unsupervised runs.
        log "MINIMALISM: #$NUM verdict check produced no/unknown output ('$_MZ_VERDICT') — failing closed (NOT treating as within-caps)"
        if [ "${MINIMALISM_REQUIRE_NOTE:-0}" = "1" ]; then
          _recover_or_park "minimalism" "minimalism gate produced no verdict (internal error) — re-deliver"
          [ "$_DELIV_OUTCOME" = "retry" ] && continue
          result error; exit 0
        else
          wg attach-evidence "$NUM" --type manual_note \
            --summary "needs_human_review: minimalism gate produced no verdict (internal error) — judge minimality from the diff" >/dev/null 2>&1 || true
        fi ;;
    esac
    # OVERSIZED alongside a note flag: the verdict token names only the note problem,
    # so the size flag is attached on its own here (an oversized_diff verdict already
    # attached it above).
    case "$_MZ_VERDICT" in
      missing_note|unverified_note)
        if [ -n "${GAFFER_MINIMALISM_OVERSIZED:-}" ]; then
          log "MINIMALISM: #$NUM is ALSO oversized — flagging needs_human_review:oversized_diff ($GAFFER_MINIMALISM_OVERSIZED)"
          wg attach-evidence "$NUM" --type manual_note \
            --summary "needs_human_review: oversized_diff — $GAFFER_MINIMALISM_OVERSIZED" >/dev/null 2>&1 \
            && log "MINIMALISM: recorded oversized_diff flag on #$NUM" || true
        fi ;;
    esac
  fi

  # ── Stabilisation gate 2.5: DEFINITION OF DONE (I3 — HARD FAIL) ─────────────
  # The single biggest "factory, not vibe" lever. The diff is non-empty (asserted
  # above) and the work lives in the throwaway worktrees. BEFORE the ticket is
  # allowed to rest in the human review lane, the RUNNER (never the agent) runs the
  # enabled DoD gates — tests / typecheck / lint — DETERMINISTICALLY in each write
  # repo's delivery worktree, each bounded by gaffer_timeout.
  #   ALL pass/skip → proceed (record + submit as today).
  #   ANY fail      → AUTO-REJECT back to refining/rework (the same path R-6/HYGIENE
  #                   hardened), record the failing gate name + an output tail as
  #                   evidence, drop the branch. A human never sees a failed gate;
  #                   the next attempt gets the gate output as review feedback.
  # A gate with NO configured command is SKIPPED (logged), not failed. A delivery
  # where ZERO gates actually executed is a HARD FAIL by default (the work was not
  # verified); set GAFFER_ALLOW_NO_DOD=1 to waive this for repos with no runnable
  # gates (see factory.config.sh). GAFFER_DOD=0 turns enforcement off entirely.
  # Per-gate toggles
  # (GAFFER_DOD_TESTS/TYPECHECK/LINT, default on) are env-only: crew.yaml's
  # `definition_of_done` block is NOT read here (crew doctor warns when it is
  # changed). Commands come from each repo's dispatch
  # test_command/lint_command; typecheck (no dispatch field) runs
  # GAFFER_DOD_TYPECHECK_CMD, else the command auto-detected from the repo's
  # package.json (gaffer_dod_typecheck_cmd in lib/dod.sh). DoD is best-effort RESILIENT: a gate command that itself
  # errors to spawn is treated as a FAIL with a clear message, never a crash.
  gaffer_clamp_gate_timeouts   # TICK DEADLINE: no gate outlives the outer bound
  # The passing DoD checklist, kept for the eval judge's test_adequacy grading (the
  # results file is removed below, long before the post-submit judge runs).
  _DOD_JUDGE_TESTS=""
  if gaffer_dod_enabled; then
    # Per-repo commands from the dispatch payload, keyed by repo id (fallback name):
    #   id|name <TAB> test_cmd <TAB> lint_cmd
    # First line is the sentinel `@@DOD_PARSE_OK@@` emitted ONLY when the payload
    # parsed — so an unparseable payload is detected, never
    # silently treated as "no commands" (which would fail the gate OPEN).
    # parse failure → no sentinel, non-zero (exit 3)
    DOD_CMD_MAP="$(echo "$SHOW" | gaffer_json dod-cmd-map 2>/dev/null || true)"
    if ! grep -q '^@@DOD_PARSE_OK@@$' <<<"$DOD_CMD_MAP"; then   # here-string: a pipe can SIGPIPE-miss under pipefail
      # Could not parse the dispatch payload. Do NOT
      # fail the gate OPEN by pretending no commands are configured: surface it as a
      # visible WARNING and FAIL the delivery closed so a human looks, rather than
      # silently shipping unverified work.
      log "DoD: WARNING — could not parse the dispatch payload for #$NUM gate commands (malformed SHOW); FAILING CLOSED — parking, not submitting"
      wg attach-evidence "$NUM" --type test_output \
        --summary "DoD: FAIL"$'\n'"$(printf '{"dod":"FAIL","gates":[{"gate":"config","repo":"-","status":"FAIL","rc":"-","note":"could not resolve DoD gate commands from the dispatch payload"}]}')" >/dev/null 2>&1 \
        && log "DoD: recorded config-FAIL evidence on #$NUM" \
        || log "DoD: WARNING — could not attach config-FAIL evidence on #$NUM"
      # RUNNER-OWNED-BOOKKEEPING: release/park the held claim to refining (pre-submit;
      # the branch is preserved for a human to fix the config + re-run).
      gaffer_release_delivery refining "Definition of Done could not run: gate commands unresolved from the dispatch payload"
      # GUARD B invariant: the agent committed work before this CONFIG failure
      # (the diff was asserted non-empty above), so the branch carries salvageable
      # work — PRESERVE it (worktree-only teardown). Re-invoking the agent cannot
      # fix an unresolvable gate-command/env problem, so this does NOT retry; it
      # parks once with the branch kept for a human to resolve the config + re-run.
      # Raise retention BEFORE exiting: the EXIT trap otherwise `drop-branch`es the
      # branch this tick created — the very branch the log calls PRESERVED.
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_cleanup_worktrees
      gaffer_skip_ticket "$NUM"
      log "delivery FAILED for #$NUM — DoD gate commands unresolvable; parked, removed worktree, branch $WORK_BRANCH PRESERVED (config problem — needs a human), not recording delivery"
      result error; exit 0
    fi
    # Strip the sentinel line; the remainder is the real id<TAB>test<TAB>lint map.
    DOD_CMD_MAP="$(printf '%s\n' "$DOD_CMD_MAP" | grep -v '^@@DOD_PARSE_OK@@$')"
    # Resolved per-gate enables (default ON; mirror the schema default). A loop /
    # orchestrator that read crew.yaml can export these to honour a repo override.
    _DOD_TESTS_ON="${GAFFER_DOD_TESTS:-1}"
    _DOD_TC_ON="${GAFFER_DOD_TYPECHECK:-1}"
    _DOD_LINT_ON="${GAFFER_DOD_LINT:-1}"
    # GATE INTEGRITY: has a HUMAN allowed this ticket to change its tests? Read FRESH
    # (not from the tick-start SHOW) so an allowance set while the agent worked counts.
    # Fails closed: an unreadable ticket means no allowance (the row FLAGs, never FAILs).
    _DOD_ALLOW_TESTS="$(wg ticket show "$NUM" 2>/dev/null \
      | jget '(d.ticket && d.ticket.allow_test_changes === 1) ? 1 : 0' 2>/dev/null || echo 0)"
    [ "$_DOD_ALLOW_TESTS" = "1" ] || _DOD_ALLOW_TESTS=0
    # Build the gate-runner input: one row per write repo with its resolved commands.
    DOD_ROWS=""
    while IFS=$'\t' read -r rid rname rpath rbase rwt; do
      [ -n "$rwt" ] || continue
      git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
      _dkey="${rid:-$rname}"
      _dlabel="${rname:-${rid:-repo}}"
      # Look up this repo's commands from the map (exact id/name match).
      _drow="$(printf '%s\n' "$DOD_CMD_MAP" | awk -F'\t' -v k="$_dkey" '$1==k{print; exit}')"
      _dtest="$(printf '%s' "$_drow" | awk -F'\t' '{print $2}')"
      _dlint="$(printf '%s' "$_drow" | awk -F'\t' '{print $3}')"
      # typecheck has no dispatch field: GAFFER_DOD_TYPECHECK_CMD (an override for every
      # repo), else the command auto-detected from this repo's package.json, read from
      # the base branch first so a delivery cannot delete the gate away.
      # GATE INTEGRITY: the commit the delivery was cut from (recorded before the agent
      # ran); the base branch name only when none was resolved.
      _dbase="$(_gaffer_delivery_base_for "$rpath")"
      [ -n "$_dbase" ] || _dbase="$rbase"
      _dtc="$(gaffer_dod_typecheck_cmd "$rwt" "$_dbase")"
      [ -z "${GAFFER_DOD_TYPECHECK_CMD:-}" ] && [ -n "$_dtc" ] && [ "$_DOD_TC_ON" = "1" ] \
        && log "DoD: typecheck gate for ${_dlabel} runs the auto-detected '$_dtc' (package.json script; GAFFER_DOD_TYPECHECK_CMD overrides it)"
      # Empty command fields MUST be the sentinel `-`: TAB is IFS-whitespace, so the
      # gate runner's `read` would collapse adjacent empty tabs and shift columns.
      [ -n "${_dtest// /}" ] || _dtest="-"
      [ -n "${_dtc// /}" ]   || _dtc="-"
      [ -n "${_dlint// /}" ] || _dlint="-"
      # GATE INTEGRITY: the base commit the delivery was cut from (the gate reads each
      # command's package.json script from that commit and appends an integrity row)
      # plus the human's allowance. `-` when unknown: integrity then FLAGs the gap.
      DOD_ROWS+="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' \
        "$_dlabel" "$rwt" "$_DOD_TESTS_ON" "$_DOD_TC_ON" "$_DOD_LINT_ON" \
        "$_dtest" "$_dtc" "$_dlint" "${_dbase:--}" "$_DOD_ALLOW_TESTS")"$'\n'
    done <<< "$WT_ROWS"
    DOD_ROWS="${DOD_ROWS%$'\n'}"

    # Pre-gate ENABLER (NOT a gate): a fresh delivery worktree has no node_modules,
    # so the test gate cannot run. Auto-install deps in EACH worktree, bounded +
    # fail-soft, BEFORE the gate runs — inside the SAME validation sandbox as the gates
    # (GAFFER_DOD_WRAP, stripped env; refused under strict-require with no wrap). This never crashes the tick and never passes
    # the gate — on a failed/timed-out install the gate still runs and fails loudly
    # exactly as today. Disable with GAFFER_DOD_INSTALL=0 (or GAFFER_GREENFIELD_INSTALL=0)
    # for byte-identical-to-today behaviour. Separate loop from the row-builder above
    # so the enabler stays visibly distinct from gate-command resolution.
    if gaffer_dod_install_enabled; then
      while IFS=$'\t' read -r _iid _iname _ipath _ibase _iwt; do
        [ -n "$_iwt" ] || continue
        git -C "$_iwt" rev-parse --git-dir >/dev/null 2>&1 || continue
        _pm="$(gaffer_dod_install_deps "$_iwt")"
        case "$_pm" in
          SKIPPED:sandbox_unavailable:*) log "DoD-install: REFUSED — GAFFER_STRICT_REQUIRE=1 and no validation sandbox wraps the ${_pm#SKIPPED:sandbox_unavailable:} install in $_iwt (#$NUM); nothing was executed (fail closed), the test gate will surface missing deps" ;;
          FAILED:timeout:*) log "DoD-install: WARN — ${_pm#FAILED:timeout:} install TIMED OUT in $_iwt (#$NUM); test gate will surface it" ;;
          FAILED:*)         log "DoD-install: WARN — ${_pm#FAILED:} install failed in $_iwt (#$NUM); test gate will surface it" ;;
          ?*)               log "DoD-install: installed ${_iname:-repo} deps via '$_pm' in the worktree for #$NUM" ;;
        esac
      done <<< "$WT_ROWS"
    fi

    if [ -n "$DOD_ROWS" ]; then
      DOD_RESULTS="$GAFFER_DATA/.dod-$NUM.results"
      if printf '%s\n' "$DOD_ROWS" | gaffer_run_dod_gates "$DOD_RESULTS"; then
        log "DoD: #$NUM PASSED — $(gaffer_dod_summary_line "$DOD_RESULTS")"
        gaffer_dod_log_integrity "$DOD_RESULTS"
        gaffer_manifest_gates "$DOD_RESULTS"
        # Zero executed gates means no gate commands are configured (all skipped):
        # the delivery was never actually verified. FAIL by default so a
        # misconfigured repo cannot silently ship unverified work. Opt out with
        # GAFFER_ALLOW_NO_DOD=1 only for repos that genuinely have no runnable
        # gates (see factory.config.sh for documentation of this knob).
        if [ "$(gaffer_dod_executed_count "$DOD_RESULTS")" -eq 0 ]; then
          if [ "${GAFFER_ALLOW_NO_DOD:-0}" = "1" ]; then
            log "DoD: WARNING — #$NUM passed with ZERO gates executed (GAFFER_ALLOW_NO_DOD=1 waiver active); configure test_command / lint_command to remove this opt-out"
          else
            log "DoD: FAILING #$NUM — zero DoD gates executed (all skipped); no test_command or lint_command configured. Set GAFFER_ALLOW_NO_DOD=1 to allow deliveries with no runnable gates (see factory.config.sh)"
            rm -f "$DOD_RESULTS"
            _recover_or_park "definition-of-done" "Definition of Done: zero gates executed — no test_command or lint_command configured; configure gate commands or set GAFFER_ALLOW_NO_DOD=1"
            [ "$_DELIV_OUTCOME" = "retry" ] && continue
            result error; exit 0
          fi
        fi
        # Record the green checklist as evidence so the reviewer sees a pre-verified
        # board (the Review view renders it). Best-effort; never blocks a passing
        # delivery.
        _DOD_EV="$(gaffer_dod_evidence_summary "$DOD_RESULTS" PASS)"
        [ -n "$_DOD_EV" ] && wg attach-evidence "$NUM" --type test_output \
          --summary "$_DOD_EV" >/dev/null 2>&1 \
          && log "DoD: recorded PASS checklist evidence on #$NUM" || true
        # FLAKY RERUN (lib/dod.sh): a tests gate that went red under the pool and passed
        # at concurrency 1 did not cost an attempt — flag it for the reviewer.
        if grep -q $'\tflaky-suspected$' "$DOD_RESULTS" 2>/dev/null; then
          log "DoD: #$NUM tests passed only on the rerun at concurrency 1 — flaky suspected; flagging needs_human_review"
          wg attach-evidence "$NUM" --type manual_note \
            --summary "needs_human_review: flaky tests suspected — the tests gate failed under a parallel pool and passed when rerun at concurrency 1 (both runs are in the DoD evidence)" >/dev/null 2>&1 || true
        fi
        _DOD_JUDGE_TESTS="$(tail -c 20000 "$DOD_RESULTS" 2>/dev/null || true)"
        rm -f "$DOD_RESULTS"
      else
        # ── A gate FAILED → auto-reject back to rework (never a human's time) ──
        _DOD_SUM="$(gaffer_dod_summary_line "$DOD_RESULTS")"
        log "DoD: #$NUM FAILED — $_DOD_SUM; auto-rejecting back to rework (not submitting for review)"
        gaffer_dod_log_integrity "$DOD_RESULTS"
        gaffer_manifest_gates "$DOD_RESULTS"
        _DOD_EV="$(gaffer_dod_evidence_summary "$DOD_RESULTS" FAIL)"
        # THE CRUX of (b): distil the ACTUAL failure (failing test name + assertion/
        # error), not the gate-name summary, so the next attempt can self-correct.
        # Read it from the results file BEFORE it is removed below.
        _DOD_DETAIL="$(gaffer_dod_extract_failure "$DOD_RESULTS" 2>/dev/null || true)"
        # Record the failing checklist + output tail as evidence FIRST so the next
        # attempt gets it as review feedback (and the board shows why it bounced). A
        # FAILED attach is surfaced (not swallowed) — losing the feedback is a real
        # regression in the learning loop, so the warning must be visible.
        if [ -n "$_DOD_EV" ]; then
          wg attach-evidence "$NUM" --type test_output --summary "$_DOD_EV" >/dev/null 2>&1 \
            && log "DoD: recorded FAIL checklist evidence on #$NUM" \
            || log "DoD: WARNING — could not attach FAIL evidence on #$NUM; the next attempt will have no DoD gate feedback"
        else
          log "DoD: WARNING — empty DoD evidence summary for #$NUM (could not build the checklist); failing closed without recorded feedback"
        fi
        rm -f "$DOD_RESULTS"
        # RECOVERABLE (GUARD B) — THE ticket #64 case: the agent produced commits
        # but a downstream gate (tests / typecheck / lint) failed. This is exactly
        # the failure that must NEVER delete the branch. Preserve the branch,
        # attach the failing checklist as feedback, and retry-or-park: re-invoke
        # the ESCALATED agent on the SAME branch with the REAL failure as feedback, up
        # to GAFFER_MAX_DELIVERY_ATTEMPTS (or the per-ticket cost ceiling), then park to
        # the VISIBLE `blocked` column WITH branch + full feedback trail.
        _recover_or_park "definition-of-done" \
          "Definition of Done failed: $_DOD_SUM — fix the failing gate(s) and re-deliver" \
          "$_DOD_DETAIL"
        [ "$_DELIV_OUTCOME" = "retry" ] && continue
        result error; exit 0
      fi
    fi
  else
    log "DoD: enforcement OFF (GAFFER_DOD=${GAFFER_DOD:-unset}) — skipping the Definition-of-Done gate for #$NUM"
  fi

  # ── MACHINE-CHECKABLE ACCEPTANCE CRITERIA (runner-executed, runner-recorded) ──
  # Every AC carrying a `check_command` is executed HERE, in the primary write
  # worktree, by the runner — never the agent — and its verdict recorded through the
  # trusted `wg ac check-result` path (satisfied/failed + test_output evidence with
  # the exit code and output tail). Dispatch's done gate refuses a checked AC the
  # runner has not passed, so the agent's own record_ac_evidence cannot substitute.
  # A failing check is a RECOVERABLE gate failure exactly like DoD: keep the branch,
  # feed the real failure back, retry-or-park. Runs whether or not DoD is enabled —
  # the checks are per-ticket contracts, not per-repo gate config. See lib/ac-checks.sh.
  gaffer_clamp_gate_timeouts
  if command -v gaffer_run_ac_checks >/dev/null 2>&1 && [ "$(gaffer_ac_check_count "$SHOW")" -gt 0 ]; then
    AC_RESULTS="$GAFFER_DATA/.ac-check-$NUM.results"; : > "$AC_RESULTS"
    if gaffer_run_ac_checks "$NUM" "$SHOW" "$PRIMARY_REPO" "$AC_RESULTS"; then
      log "AC-check: #$NUM PASSED — $(gaffer_dod_summary_line "$AC_RESULTS")"
      rm -f "$AC_RESULTS"
    else
      _AC_SUM="$(gaffer_dod_summary_line "$AC_RESULTS")"
      log "AC-check: #$NUM FAILED — $_AC_SUM; auto-rejecting back to rework (not submitting for review)"
      _AC_DETAIL="$(gaffer_dod_extract_failure "$AC_RESULTS" 2>/dev/null || true)"
      rm -f "$AC_RESULTS"
      _recover_or_park "acceptance-check" \
        "Acceptance check failed: $_AC_SUM — make the acceptance criterion's check command pass and re-deliver" \
        "$_AC_DETAIL"
      [ "$_DELIV_OUTCOME" = "retry" ] && continue
      result error; exit 0
    fi
  fi

  # ── GUARD B: every gate passed → leave the recoverable-attempt loop ─────────
  # Reaching here means the agent delivered AND every downstream gate (empty /
  # hygiene / minimalism / DoD) passed on this attempt. Break out of the retry
  # loop into the success recording below. (Recoverable gate failures `continue`
  # the loop; unrecoverable ones already `exit 0`.)
  break
  done   # end GUARD B recoverable-delivery attempt loop
}
