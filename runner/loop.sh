#!/usr/bin/env bash
# The factory driver: run ticks until the stop conditions hit. This is the whole
# "keeps running" mechanism — a thin loop around headless Claude ticks. Re-run it
# from cron/launchd to keep the factory alive across sittings.
#
# Stop conditions (factory.config.sh): MAX_TICKS, EMPTY_POLL_LIMIT, TICK_SLEEP.
# DRY_RUN=1 (default) makes every tick a no-op print.
#
# R-1: DELIBERATELY no `set -e`. This is a long-running supervisor loop and many
# commands here are EXPECTED to return non-zero in normal operation (a tick that
# finds no work, an `expire-claims` with nothing to reap, a `sed` that matches
# nothing). Under `set -e` any of those would abort the whole factory run — the
# opposite of "keep the factory alive across sittings". Instead of a blanket `-e`,
# the CRITICAL state-mutating calls below each carry explicit `|| { … }` handling
# so a real failure there is SURFACED (logged), not silently glided past. `-u`
# (unset-var) and `pipefail` stay on — those catch genuine bugs without aborting
# on expected non-zero exits.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"
mkdir -p "$GAFFER_DATA"

# R-10: fail closed before spinning any ticks. gaffer_timeout refuses to run an
# agent call unbounded when no perl/timeout/gtimeout exists; abort the whole run
# with a setup error here so we never start a loop that can't bound its calls.
gaffer_timeout_preflight || { echo "gaffer factory: aborting — no timeout primitive (setup error)." >&2; exit 1; }

# R-1 (cleanup): start a fresh run with no stale skip/backpressure markers. If
# this rm fails, a prior run's markers could wrongly suppress work this run — so
# surface it rather than letting the run proceed on a dirty slate.
rm -f "$GAFFER_DATA/.failed-tickets" "$GAFFER_DATA/.reviewed-tickets" "$GAFFER_DATA/.clarified-tickets" \
      "$GAFFER_DATA/.backpressure-repos" \
  || echo "gaffer factory: WARNING — could not clear stale run markers in $GAFFER_DATA; this run may wrongly skip work." >&2

echo "gaffer factory: starting (DRY_RUN=$DRY_RUN, max_ticks=$MAX_TICKS, stop_after_empty=$EMPTY_POLL_LIMIT, max_ticks_per_day=$MAX_TICKS_PER_DAY)"
# R-1 (expire-claims): reap stale claims from a prior interrupted run. Non-fatal
# (a fresh DB has none) but a real failure shouldn't pass silently — log it.
wg expire-claims >/dev/null 2>&1 \
  || echo "gaffer factory: WARNING — expire-claims failed; stale claims from a prior run may persist." >&2

# A-1: reclaim worktrees orphaned by a killed worker on a PRIOR run. expire-claims
# above released their claims (so the ticket is no longer claimed/in_progress);
# this sweeps the matching stale worktree dirs. Safe even at concurrency 1 — a
# clean data dir has none — and it NEVER touches a worktree whose ticket is still
# claimed/in_progress (a live worker's), so it's safe to run before the pool spins.
if declare -F gaffer_cleanup_orphaned_worktrees >/dev/null 2>&1; then
  _reclaimed="$(gaffer_cleanup_orphaned_worktrees 2>/dev/null | tr '\n' ' ')"
  [ -n "${_reclaimed// /}" ] && echo "gaffer factory: reclaimed orphaned worktree(s) for ticket(s): ${_reclaimed% }"
fi

RUN_STARTED="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"   # run start, for the trust report's run-scoping

if [ "${GAFFER_CONCURRENCY:-1}" -gt 1 ] 2>/dev/null; then
  # ── Parallel path (opt-in: GAFFER_CONCURRENCY>1) ──────────────────────────
  # Spawn a pool of N worker.sh processes that each loop claim→deliver via tick.sh
  # until the queue is drained, wait on them all, then aggregate their per-worker
  # result files. The shared per-run MAX_TICKS budget is divided across the pool
  # (rounded up) so the pool's TOTAL ticks still honour MAX_TICKS. Each worker
  # carries the SAME per-tick wall-clock cap as the serial path.
  N="$GAFFER_CONCURRENCY"
  WORKER_MAX_TICKS=$(( (MAX_TICKS + N - 1) / N ))
  export WORKER_MAX_TICKS
  WORKERS_DIR="$GAFFER_DATA/.workers"
  rm -rf "$WORKERS_DIR"; mkdir -p "$WORKERS_DIR"
  echo "gaffer factory: parallel mode — spawning $N worker(s) (each up to $WORKER_MAX_TICKS tick(s); MAX_TICKS=$MAX_TICKS total)."
  pids=()
  i=0
  while [ "$i" -lt "$N" ]; do
    bash "$HERE/worker.sh" "$i" &
    pids+=("$!")
    i=$((i + 1))
  done
  # Wait for every worker; a non-zero worker exit is logged but never aborts the
  # join (we still want the other workers' results + cleanup).
  for p in "${pids[@]}"; do
    wait "$p" || echo "gaffer factory: WARNING — a worker (pid $p) exited non-zero." >&2
  done
  # Aggregate per-worker result files: "<worked> <reviewed> <clarified> <idle> <nowork> <error> <ticks>".
  ticks=0; tot_worked=0; tot_reviewed=0; tot_clarified=0; tot_idle=0; tot_nowork=0; tot_error=0
  for rf in "$WORKERS_DIR"/*.result; do
    [ -f "$rf" ] || continue
    read -r w r c idl nw er tk < "$rf" || continue
    tot_worked=$((tot_worked + ${w:-0})); tot_reviewed=$((tot_reviewed + ${r:-0}))
    tot_clarified=$((tot_clarified + ${c:-0})); tot_idle=$((tot_idle + ${idl:-0}))
    tot_nowork=$((tot_nowork + ${nw:-0})); tot_error=$((tot_error + ${er:-0}))
    ticks=$((ticks + ${tk:-0}))
  done
  echo "gaffer factory: parallel run aggregated — ticks=$ticks worked=$tot_worked reviewed=$tot_reviewed clarified=$tot_clarified idle_drafted=$tot_idle no_work=$tot_nowork error=$tot_error."

  # A-1: final orphan sweep — a worker killed DURING this run leaves a stale
  # worktree; its claim is reaped on the NEXT run's expire-claims, but sweep the
  # now-unclaimed ones we can already see. NEVER touches a claimed/in_progress
  # ticket's worktree, so a (now-finished) pool leaves only genuinely-stale dirs.
  if declare -F gaffer_cleanup_orphaned_worktrees >/dev/null 2>&1; then
    _reclaimed_end="$(gaffer_cleanup_orphaned_worktrees 2>/dev/null | tr '\n' ' ')"
    [ -n "${_reclaimed_end// /}" ] && echo "gaffer factory: end-of-run reclaimed orphaned worktree(s): ${_reclaimed_end% }"
  fi

  echo "gaffer factory: done after $ticks tick(s)."
  if [ -f "$HERE/run-summary.sh" ]; then
    echo
    SUMMARY_SINCE="$RUN_STARTED" bash "$HERE/run-summary.sh" || true
  fi
  exit 0
fi

# ── Serial path (DEFAULT: GAFFER_CONCURRENCY=1) ───────────────────────────────
# Byte-for-byte the pre-A-1 loop. At concurrency 1 the factory runs EXACTLY as it
# always has — the parallel machinery above is fully bypassed.
ticks=0
empties=0
while [ "$ticks" -lt "$MAX_TICKS" ]; do
  if ! gaffer_day_cap_ok; then
    echo "gaffer factory: per-day cap (MAX_TICKS_PER_DAY=$MAX_TICKS_PER_DAY, used $(gaffer_day_count)) reached — stopping."
    break
  fi
  ticks=$((ticks + 1))
  # Wrap the whole tick in the same per-call wall-clock cap so a runaway claude -p
  # (or a tick wedged anywhere) can't burn unbounded wall-clock. A small slack is
  # added over GAFFER_TICK_TIMEOUT so the inner per-call timeout fires first (and is
  # logged with context) before this outer guard reaps the tick.
  out="$(gaffer_timeout "$((GAFFER_TICK_TIMEOUT + 60))" bash "$HERE/tick.sh")"
  # R-1 (counting): this tick has spent (every tick invokes claude -p). Persist the
  # per-day count NOW — it is the denial-of-wallet guard's only ledger. If the bump
  # silently failed, the day cap would never advance and an overnight run could
  # blow past MAX_TICKS_PER_DAY. So if it fails, log it AND stop the run rather than
  # keep spending unbounded against a cap we can no longer enforce.
  if ! gaffer_bump_day_count; then
    echo "gaffer factory: ERROR — could not persist the per-day tick count; the day cap can no longer be enforced. Stopping to avoid unbounded spend." >&2
    break
  fi
  res="$(echo "$out" | sed -n 's/^TICK_RESULT=//p' | tail -1)"
  echo "tick $ticks/$MAX_TICKS → ${res:-unknown}"

  if [ "$res" = "no_work" ]; then
    empties=$((empties + 1))
    if [ "$empties" -ge "$EMPTY_POLL_LIMIT" ]; then
      echo "gaffer factory: $empties consecutive empty polls — stopping."
      break
    fi
  else
    empties=0
  fi

  [ "$ticks" -lt "$MAX_TICKS" ] && sleep "$TICK_SLEEP"
done
echo "gaffer factory: done after $ticks tick(s)."

# End-of-run report: landed / failed-safe / parked / re-queued / oversized /
# per-repo pressure / cleanup state. Best-effort — never let a reporting hiccup
# change the loop's exit status.
if [ -f "$HERE/run-summary.sh" ]; then
  echo
  SUMMARY_SINCE="$RUN_STARTED" bash "$HERE/run-summary.sh" || true
fi
