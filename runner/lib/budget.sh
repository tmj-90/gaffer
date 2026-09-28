#!/usr/bin/env bash
# Per-day cost guard for unattended factory runs. MAX_TICKS bounds a SINGLE
# loop.sh invocation, but launchd re-runs loop.sh on a schedule — so MAX_TICKS
# alone can't bound a full day's spend. This tracks a per-CALENDAR-DAY tick count
# persisted in GAFFER_DATA (DAILY_COUNTER_FILE), surviving across loop.sh runs, so
# an overnight factory hard-stops once the day's cap is hit. The count is per tick
# that may have invoked `claude -p` (real cost) — a `no_work` poll spends nothing and
# is exempt (gaffer_tick_counts_toward_day_cap), so an idle daemon cannot burn the cap.
# shellcheck shell=bash

# Echo today's persisted tick count — 0 if there is no record, or the record is
# from an earlier day (a new calendar day resets the count).
gaffer_day_count() {
  local today d c
  today="$(date +%Y-%m-%d)"
  if [ -f "$DAILY_COUNTER_FILE" ]; then
    read -r d c < "$DAILY_COUNTER_FILE" || true
    if [ "$d" = "$today" ]; then echo "${c:-0}"; return; fi
  fi
  echo 0
}

# Increment and persist today's tick count. The read-modify-write below is NOT
# atomic on its own, so under GAFFER_CONCURRENCY>1 two workers bumping at once
# could both read the same count and clobber each other — LOSING a tick from the
# denial-of-wallet ledger (the cap could then never advance). We serialise the
# whole RMW under a dedicated lock when gaffer_with_lock is available (it is, via
# factory.config.sh). At concurrency 1 there is no contention so the lock is taken
# and released with no wait — behaviour is byte-identical to before.
gaffer_bump_day_count() {
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "${GAFFER_DATA:-$(dirname "$DAILY_COUNTER_FILE")}/.daycount.lock" \
      _gaffer_bump_day_count_unlocked
  else
    _gaffer_bump_day_count_unlocked
  fi
}

# The raw read-modify-write, run while holding .daycount.lock (or directly when no
# lock primitive is defined, e.g. a unit test sourcing budget.sh standalone).
_gaffer_bump_day_count_unlocked() {
  local today c
  today="$(date +%Y-%m-%d)"
  c=$(( $(gaffer_day_count) + 1 ))
  printf '%s %s\n' "$today" "$c" > "$DAILY_COUNTER_FILE"
}

# ── ATOMIC ADMISSION (reserve, then refund) ──────────────────────────────────
# Checking the cap, running the tick and THEN bumping the count is not atomic: N
# workers that all read "one slot left" all admit themselves against it, and the pool
# overshoots MAX_TICKS_PER_DAY by up to N-1. Reservation folds the check and the
# increment into ONE locked read-modify-write: a worker either owns a slot before it
# spawns anything, or it does not run. A tick that turns out to have spent nothing
# (`no_work`) gives its slot back (gaffer_refund_day_tick), so the counter still
# means "ticks that may have paid" exactly as before.
#
# gaffer_reserve_day_tick → 0 slot reserved (count advanced); 1 at/over the cap
# (nothing written); 2 could not persist (the caller must STOP — the cap can no
# longer be enforced, the same fail-stop as a failed bump).
gaffer_reserve_day_tick() {
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "${GAFFER_DATA:-$(dirname "$DAILY_COUNTER_FILE")}/.daycount.lock" \
      _gaffer_reserve_day_tick_unlocked
  else
    _gaffer_reserve_day_tick_unlocked
  fi
}
_gaffer_reserve_day_tick_unlocked() {
  local today c
  today="$(date +%Y-%m-%d)"
  c="$(gaffer_day_count)"
  if [ "${MAX_TICKS_PER_DAY:-0}" -gt 0 ] 2>/dev/null && [ "$c" -ge "$MAX_TICKS_PER_DAY" ]; then
    return 1
  fi
  printf '%s %s\n' "$today" "$((c + 1))" > "$DAILY_COUNTER_FILE" || return 2
  return 0
}
# gaffer_refund_day_tick — give back ONE reserved slot (floor 0, same day only).
gaffer_refund_day_tick() {
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "${GAFFER_DATA:-$(dirname "$DAILY_COUNTER_FILE")}/.daycount.lock" \
      _gaffer_refund_day_tick_unlocked
  else
    _gaffer_refund_day_tick_unlocked
  fi
}
_gaffer_refund_day_tick_unlocked() {
  local today c
  today="$(date +%Y-%m-%d)"
  c="$(gaffer_day_count)"
  [ "$c" -gt 0 ] || return 0
  printf '%s %s\n' "$today" "$((c - 1))" > "$DAILY_COUNTER_FILE"
}

# gaffer_reserve_run_tick <counter-file> <max> — the PER-RUN pool budget, atomically.
# loop.sh used to give each of N workers ceil(MAX_TICKS/N) ticks, which admits
# N×ceil(MAX_TICKS/N) in total (10 ticks across 3 workers ⇒ 12; 1 tick across 4
# workers ⇒ 4). The pool now shares ONE counter: a worker reserves a run tick under
# the counter's lock before it starts one, and the pool total can never exceed <max>.
# Slots freed by an idle worker are naturally used by a busy one (no static shares).
# → 0 reserved; 1 budget exhausted; 2 could not persist (stop).
gaffer_reserve_run_tick() {
  local file="$1" max="$2"
  [ -n "$file" ] && [ -n "$max" ] || return 2
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "$file.lock" _gaffer_reserve_run_tick_unlocked "$file" "$max"
  else
    _gaffer_reserve_run_tick_unlocked "$file" "$max"
  fi
}
_gaffer_reserve_run_tick_unlocked() {
  local file="$1" max="$2" c
  c="$(cat "$file" 2>/dev/null | tr -dc '0-9')"; c="${c:-0}"
  [ "$c" -lt "$max" ] 2>/dev/null || return 1
  printf '%s\n' "$((c + 1))" > "$file" || return 2
  return 0
}
# gaffer_refund_run_tick <counter-file> — a reservation the worker could not use
# (e.g. it then failed the day-cap reservation) is handed back so the pool does not
# under-run its budget by the failed attempts.
gaffer_refund_run_tick() {
  local file="$1"
  [ -n "$file" ] || return 0
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "$file.lock" _gaffer_refund_run_tick_unlocked "$file"
  else
    _gaffer_refund_run_tick_unlocked "$file"
  fi
}
_gaffer_refund_run_tick_unlocked() {
  local file="$1" c
  c="$(cat "$file" 2>/dev/null | tr -dc '0-9')"; c="${c:-0}"
  [ "$c" -gt 0 ] || return 0
  printf '%s\n' "$((c - 1))" > "$file"
}

# gaffer_tick_counts_toward_day_cap <TICK_RESULT> — true when a finished tick may
# have spent (invoked a paid `claude -p`), so it must be counted against
# MAX_TICKS_PER_DAY. A `no_work` tick never spawns an agent: it polls the queue,
# finds nothing claimable and exits — so it must NOT consume the day cap. Before this
# every non-dry tick was counted, and an IDLE daemon (TICK_SLEEP=30, cap 50) burned
# the whole day's cap in ~37 minutes without delivering anything, then sat idle
# until midnight. Every OTHER result counts: the productive ones (worked / reviewed /
# tested / clarified / idle_drafted / maintenance_* / paused), an `error` (the agent
# may have run before a gate failed) and an EMPTY/unknown result (the outer timeout
# reaped a tick mid-agent — real spend with no result line). Conservative by design:
# only the one result that provably cost nothing is exempt.
gaffer_tick_counts_toward_day_cap() {
  case "${1:-}" in
    no_work) return 1 ;;
    *) return 0 ;;
  esac
}

# Return 0 (true) if running another tick today stays within the cap. A cap of
# 0 (or less) means unlimited — the guard is disabled.
gaffer_day_cap_ok() {
  [ "${MAX_TICKS_PER_DAY:-0}" -le 0 ] && return 0
  [ "$(gaffer_day_count)" -lt "$MAX_TICKS_PER_DAY" ]
}

# ── Per-UTC-day USD cap (Part B) ─────────────────────────────────────────────
# MAX_TICKS_PER_DAY caps the tick COUNT; GAFFER_DAILY_BUDGET_USD caps the DOLLARS
# spent in a UTC calendar day. The window spend is summed from the usage ledger —
# measured total_cost_usd PLUS killed/timeout estimated_cost_usd (Part A) — so a run
# that keeps timing out still counts against the cap. Both helpers DEGRADE TO SAFE:
# any node/ledger/parse failure yields 0 spend (never blocks a tick), mirroring
# gaffer_ticket_rework_spend's degrade path.

# Echo today's (UTC) USD spend from the ledger as a decimal — 0 when there is no
# ledger yet (nothing has been spent), or the literal `unknown` when the spend CANNOT
# be measured (node missing, the estimate lib missing, the reader failing). It used to
# print 0 in every failure case, which made the dollar cap availability-first: a
# broken reader read as "nothing spent" and never halted. With a cap configured,
# `unknown` now HALTS (gaffer_day_usd_cap_ok below) — fail closed, like the tick cap
# stopping when its counter cannot be persisted. Reuses the ONE shared JSONL reader
# (estimate.mjs parseLedger); the COST summation stays here (estimate.mjs's honesty
# contract forbids it from reading cost). "today" is the UTC date so the window
# matches the ledger's ISO `ts` prefix regardless of the host timezone.
gaffer_day_usd_spent() {
  local ledger="${GAFFER_USAGE_LEDGER:-${GAFFER_DATA:+$GAFFER_DATA/usage-ledger.jsonl}}"
  [ -n "$ledger" ] && [ -f "$ledger" ] || { printf '0'; return 0; }   # no ledger ⇒ nothing spent
  command -v node >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  [ -f "${GAFFER_ESTIMATE_LIB:-}" ] || { printf 'unknown'; return 0; }
  GAFFER_DAY_LEDGER="$ledger" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const { parseLedger } = await import(pathToFileURL(process.env.GAFFER_ESTIMATE_LIB).href);
    const today = new Date().toISOString().slice(0,10); // UTC calendar day
    let text="";
    try { text=readFileSync(process.env.GAFFER_DAY_LEDGER,"utf8"); } catch {}
    let spend=0;
    for (const r of parseLedger(text)) {
      if (typeof r.ts!=="string" || r.ts.slice(0,10)!==today) continue;
      const c=r.total_cost_usd;
      if (typeof c==="number" && Number.isFinite(c) && c>=0) { spend+=c; continue; }
      const e=r.estimated_cost_usd; // Part A killed/timeout estimate counts too
      if (typeof e==="number" && Number.isFinite(e) && e>=0) spend+=e;
    }
    process.stdout.write(spend.toFixed(6));
  ' 2>/dev/null || printf 'unknown'
}

# Return 0 (true) if starting new paid work today stays within the UTC-day USD cap.
# An empty or <=0 cap means OFF (unlimited) — the pre-Part-B default. The compare is
# done in awk with the cap/spend passed via -v (NEVER interpolated into the program
# body) so an awk-metacharacter settings value coerces to 0 (`+0`) and reads as OFF,
# never executes. Boundary: spent < cap ⇒ OK (proceed); spent == cap or over ⇒ NOT
# OK (halt) — same "at the cap halts" semantics as gaffer_day_cap_ok.
gaffer_day_usd_cap_ok() {
  local cap="${GAFFER_DAILY_BUDGET_USD:-}"
  [ -z "$cap" ] && return 0
  command -v awk >/dev/null 2>&1 || return 0
  awk -v c="$cap" 'BEGIN{exit !(c+0 > 0)}' 2>/dev/null || return 0   # cap<=0/garbage ⇒ OFF
  local spent; spent="$(gaffer_day_usd_spent)"
  # FAIL CLOSED: a cap is configured but today's spend cannot be measured ⇒ halt.
  # (A missing ledger is `0`, not `unknown` — a fresh factory is never blocked.)
  if [ "$spent" = "unknown" ]; then
    echo "gaffer: GAFFER_DAILY_BUDGET_USD=$cap is set but today's spend cannot be measured (node or the estimate lib unavailable, or the ledger unreadable) — halting rather than spending against an unenforceable cap" >&2
    return 1
  fi
  awk -v s="$spent" -v c="$cap" 'BEGIN{exit !(s+0 < c+0)}' 2>/dev/null
}
