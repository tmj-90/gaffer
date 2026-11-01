#!/usr/bin/env bash
# Per-day cost guard for unattended factory runs. MAX_TICKS bounds a SINGLE
# loop.sh invocation, but launchd re-runs loop.sh on a schedule — so MAX_TICKS
# alone can't bound a full day's spend. This tracks a per-CALENDAR-DAY tick count
# persisted in GAFFER_DATA (DAILY_COUNTER_FILE), surviving across loop.sh runs, so
# an overnight factory hard-stops once the day's cap is hit. The count is per tick
# that may have invoked `claude -p` (real cost) — a `no_work` poll spends nothing and
# is exempt (gaffer_tick_counts_toward_day_cap), so an idle daemon cannot burn the cap.
# shellcheck shell=bash

# The calendar day every helper below keys on. GAFFER_TODAY_OVERRIDE is a TEST seam
# (the midnight-rollover proof in test/budget-admission.test.sh); production never sets it.
_gaffer_today() { if [ -n "${GAFFER_TODAY_OVERRIDE:-}" ]; then printf '%s' "$GAFFER_TODAY_OVERRIDE"; else date +%Y-%m-%d; fi; }

# Echo today's persisted tick count — 0 if there is no record, or the record is
# from an earlier day (a new calendar day resets the count).
gaffer_day_count() {
  local today d c
  today="$(_gaffer_today)"
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
  today="$(_gaffer_today)"
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
# gaffer_reserve_day_tick → 0 slot reserved (count advanced) and PRINTS the
# reservation's calendar day (the caller keeps it for the refund); 1 at/over the cap
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
  today="$(_gaffer_today)"
  c="$(gaffer_day_count)"
  if [ "${MAX_TICKS_PER_DAY:-0}" -gt 0 ] 2>/dev/null && [ "$c" -ge "$MAX_TICKS_PER_DAY" ]; then
    return 1
  fi
  printf '%s %s\n' "$today" "$((c + 1))" > "$DAILY_COUNTER_FILE" || return 2
  printf '%s' "$today"
  return 0
}
# gaffer_refund_day_tick <reservation-day> — give back ONE reserved slot, ONLY if the
# counter still belongs to the day the slot was reserved on. A refund is bound to its
# reservation: a tick reserved before midnight that finishes (no_work) after it must not
# decrement the NEW day's count — that let a stale refund re-open a day at its cap
# (external recheck, "old-day reservation refunded after a new-day reservation").
# The day is MANDATORY: a date-less refund used to default to today, which is exactly
# the stale-refund defect in disguise (a caller that forgets the day refunds whatever
# day the counter is on). Missing ⇒ rc 2, a WARNING, and no change. Floor 0.
gaffer_refund_day_tick() {
  local day="${1:-}"
  if [ -z "$day" ]; then
    echo "gaffer_refund_day_tick: refusing a refund with no reservation day (pass the day gaffer_reserve_day_tick printed)" >&2
    return 2
  fi
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "${GAFFER_DATA:-$(dirname "$DAILY_COUNTER_FILE")}/.daycount.lock" \
      _gaffer_refund_day_tick_unlocked "$day"
  else
    _gaffer_refund_day_tick_unlocked "$day"
  fi
}
_gaffer_refund_day_tick_unlocked() {
  local day="${1:-}" d c
  [ -n "$day" ] || return 2
  [ -f "$DAILY_COUNTER_FILE" ] || return 0
  read -r d c < "$DAILY_COUNTER_FILE" || return 0
  [ "$d" = "$day" ] || return 0          # the counter has rolled to another day: no-op
  c="${c:-0}"
  [ "$c" -gt 0 ] 2>/dev/null || return 0
  printf '%s %s\n' "$d" "$((c - 1))" > "$DAILY_COUNTER_FILE"
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
# until midnight. An idle maintenance tick whose deterministic scan filed nothing is
# reported as `no_work` too (tick.sh): the scans call no model. Every OTHER result
# counts: the productive ones (worked / reviewed / tested / clarified / idle_drafted /
# maintenance_drafted / paused), `usage_paused` (the delivery call ran and was refused
# by the usage window: a spawn, so it counts), `maintenance_ran` (an idle tick that ran the paid
# feature-backlog planner but filed nothing), an `error` (the agent
# may have run before a gate failed) and an EMPTY/unknown result (the outer timeout
# reaped a tick mid-agent — real spend with no result line). Conservative by design:
# only the one result that provably cost nothing is exempt.
# `setup_error` is exempt too: tick.sh reports it only from a fail-closed setup
# check that refused BEFORE any agent launched (gaffer_abort_setup). The run stops on
# it and the daemon backs off exponentially (lib/daemon.sh), so the refund cannot
# turn into unbounded claim/teardown churn.
gaffer_tick_counts_toward_day_cap() {
  case "${1:-}" in
    no_work|setup_error) return 1 ;;
    *) return 0 ;;
  esac
}

# Return 0 (true) if running another tick today stays within the cap. A cap of
# 0 (or less) means unlimited — the guard is disabled.
gaffer_day_cap_ok() {
  [ "${MAX_TICKS_PER_DAY:-0}" -le 0 ] && return 0
  [ "$(gaffer_day_count)" -lt "$MAX_TICKS_PER_DAY" ]
}

# ── LIVE CAPS: re-read the day caps from the CURRENT config ──────────────────
# loop.sh and each pool worker.sh source factory.config.sh ONCE, at start, so the
# day caps they admit against were frozen there: lowering MAX_TICKS_PER_DAY in the
# dashboard did not reach a running loop (seen: cap cut 40 → 1 after the first tick,
# the loop still admitted 4). gaffer_refresh_day_caps <config> re-derives
# MAX_TICKS_PER_DAY and GAFFER_DAILY_BUDGET_USD in a FRESH bash that re-sources the
# config (the same pattern as the daemon's per-pass cap check, lib/daemon.sh): a
# subshell would keep this shell's values and shadow a newly saved settings.json.
# The re-source hygiene in factory.config.sh still applies, so the operator's real
# env keeps winning over the file. Call it before EVERY admission.
#
# FAIL CLOSED: returns 1 (and changes nothing) when the config cannot be re-read,
# yields a cap that is not an integer, or reports settings.json UNREADABLE (it exists
# but does not parse, or node is missing — factory.config.sh sets
# _GAFFER_SETTINGS_UNREADABLE and keeps the inherited values rather than falling to the
# defaults). The caller must STOP, never fall back to the stale value, a default or
# "no cap". A cap of 0 (or less) still means unlimited, as above.
gaffer_refresh_day_caps() {
  local cfg="${1:-}" out line cap="" usd="" unreadable="" seen=0
  [ -n "$cfg" ] && [ -f "$cfg" ] || return 1
  out="$(GAFFER_DATA="${GAFFER_DATA:-}" bash -c '
    source "$1" >/dev/null 2>&1 || true
    printf "caps:%s\nunreadable:%s\nusd:%s\n" "${MAX_TICKS_PER_DAY:-}" "${_GAFFER_SETTINGS_UNREADABLE:-0}" "${GAFFER_DAILY_BUDGET_USD:-}"' _ "$cfg" 2>/dev/null)" || return 1
  while IFS= read -r line; do
    case "$line" in
      caps:*) cap="${line#caps:}"; seen=$((seen + 1)) ;;
      unreadable:*) unreadable="${line#unreadable:}"; seen=$((seen + 1)) ;;
      usd:*) usd="${line#usd:}"; seen=$((seen + 1)) ;;
    esac
  done <<<"$out"
  [ "$seen" = 3 ] || return 1
  if [ "$unreadable" != 0 ]; then
    _GAFFER_SETTINGS_UNREADABLE=1; export _GAFFER_SETTINGS_UNREADABLE
    return 1
  fi
  [[ "$cap" =~ ^-?[0-9]+$ ]] || return 1
  unset _GAFFER_SETTINGS_UNREADABLE
  _gaffer_set_live_cap MAX_TICKS_PER_DAY "$cap"
  _gaffer_set_live_cap GAFFER_DAILY_BUDGET_USD "$usd"
  return 0
}

# gaffer_settings_readable — 0 when settings.json was read (or there is none), 1 when
# it exists but could not be parsed / read on the last source of factory.config.sh.
# Every pre-spawn gate (tick.sh, poll-once.sh, the daemon) refuses paid work on 1.
gaffer_settings_readable() {
  [ "${_GAFFER_SETTINGS_UNREADABLE:-0}" = 0 ]
}
# Assign a refreshed cap in THIS shell. When the key is a value the config derived
# and exported (it carries a _GAFFER_DV_<KEY> record), move the record with it: the
# record is how a child's re-source (tick.sh, the next refresh) tells a stale derived
# value from one a parent set on purpose, and a stale record would freeze the cap at
# the refreshed value instead of re-deriving it from settings.json next time.
_gaffer_set_live_cap() {
  local key="$1" val="$2" rec="_GAFFER_DV_$1"
  printf -v "$key" '%s' "$val"
  if [ -n "${!rec+x}" ]; then printf -v "$rec" '%s' "$val"; export "${rec?}"; fi
  return 0
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
  [ -n "$ledger" ] && [ -e "$ledger" ] || { printf '0'; return 0; }   # no ledger ⇒ nothing spent
  # An EXISTING ledger we cannot read is an unknown spend, never 0 (the external recheck
  # reproduced a mode-000 $100 ledger reading as $0 and admitting work under a $1 cap).
  [ -f "$ledger" ] && [ -r "$ledger" ] || { printf 'unknown'; return 0; }
  command -v node >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  # STRICT reader, deliberately NOT estimate.mjs's tolerant parseLedger: for a spending
  # CEILING a record we cannot read or parse is not "zero", it is "unknown". Any read
  # error or any non-empty line that is not a JSON object ⇒ `unknown` ⇒ the cap halts.
  GAFFER_DAY_LEDGER="$ledger" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const today = new Date().toISOString().slice(0,10); // UTC calendar day
    let text;
    try { text = readFileSync(process.env.GAFFER_DAY_LEDGER, "utf8"); }
    catch { process.stdout.write("unknown"); process.exit(0); }
    let spend = 0;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { process.stdout.write("unknown"); process.exit(0); }
      if (!r || typeof r !== "object" || Array.isArray(r)) { process.stdout.write("unknown"); process.exit(0); }
      if (typeof r.ts !== "string" || r.ts.slice(0,10) !== today) continue;
      const c = r.total_cost_usd;
      if (typeof c === "number" && Number.isFinite(c) && c >= 0) { spend += c; continue; }
      const e = r.estimated_cost_usd; // Part A killed/timeout estimate counts too
      if (typeof e === "number" && Number.isFinite(e) && e >= 0) spend += e;
    }
    process.stdout.write(spend.toFixed(6));
  ' 2>/dev/null || printf 'unknown'
}

# ── Lifetime budget admission (GAFFER_BUDGET_USD) ────────────────────────────
# GAFFER_BUDGET_USD is the factory's HARD lifetime ceiling; factory.config.sh sums the
# ledger into GAFFER_BUDGET_REMAINING every time it is sourced (once per tick). It used
# to be read only AFTER a delivery call (the budget_cap pause), so at $0 headroom every
# new ready ticket still got one paid call before pausing — N tickets, N calls past the
# "hard ceiling". This is the pre-spawn gate: 0 = the factory may start paid work,
# 1 = it may not. Same shape and fail-closed rules as gaffer_day_usd_cap_ok: unset /
# 0 / garbage budget ⇒ OFF; a budget that IS set but whose headroom could not be
# computed (node or the ledger reader failed, so the config left it empty) ⇒ halt.
gaffer_budget_headroom_ok() {
  local budget="${GAFFER_BUDGET_USD:-}" rem="${GAFFER_BUDGET_REMAINING:-}"
  [ -z "$budget" ] && return 0
  command -v awk >/dev/null 2>&1 || { echo "gaffer: GAFFER_BUDGET_USD=$budget is set but awk is unavailable to compare it — halting rather than spending against an unenforceable budget" >&2; return 1; }
  awk -v b="$budget" 'BEGIN{exit !(b+0 > 0)}' 2>/dev/null || return 0   # budget<=0/garbage ⇒ OFF
  if [ -z "$rem" ]; then
    echo "gaffer: GAFFER_BUDGET_USD=$budget is set but the remaining headroom cannot be established (node unavailable, or the usage ledger unreadable) — halting rather than spending against an unenforceable budget" >&2
    return 1
  fi
  awk -v r="$rem" 'BEGIN{exit !(r+0 > 0)}' 2>/dev/null
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
  # FAIL CLOSED: a cap is configured but awk (the comparator) is missing ⇒ halt, not OFF.
  command -v awk >/dev/null 2>&1 || { echo "gaffer: GAFFER_DAILY_BUDGET_USD=$cap is set but awk is unavailable to compare it — halting rather than spending against an unenforceable cap" >&2; return 1; }
  awk -v c="$cap" 'BEGIN{exit !(c+0 > 0)}' 2>/dev/null || return 0   # cap<=0/garbage ⇒ OFF
  local spent; spent="$(gaffer_day_usd_spent)"
  # FAIL CLOSED: a cap is configured but today's spend cannot be measured ⇒ halt.
  # (A missing ledger is `0`, not `unknown` — a fresh factory is never blocked.)
  if [ "$spent" = "unknown" ]; then
    echo "gaffer: GAFFER_DAILY_BUDGET_USD=$cap is set but today's spend cannot be established (node unavailable, or the usage ledger unreadable / malformed) — halting rather than spending against an unenforceable cap" >&2
    return 1
  fi
  awk -v s="$spent" -v c="$cap" 'BEGIN{exit !(s+0 < c+0)}' 2>/dev/null
}

# ── A dollar cap is REQUIRED before a live run ───────────────────────────────
# Out of the box only MAX_TICKS_PER_DAY bounds an unattended factory: a tick count is
# not a dollar figure, and cost drain is the top reason people abandon an agent
# factory. So a LIVE run (`gaffer run`, loop.sh, the dashboard's Poll button) refuses
# to start until GAFFER_DAILY_BUDGET_USD or GAFFER_BUDGET_USD holds a positive dollar
# figure. A dry run never spends and is never refused. GAFFER_ALLOW_UNCAPPED=1 is the
# documented opt-out (a key metered elsewhere, the stub-agent test suites); it never
# lifts a cap that IS set.
: "${GAFFER_ALLOW_UNCAPPED:=}"   # 1 = let a live run start with neither GAFFER_DAILY_BUDGET_USD nor GAFFER_BUDGET_USD set (default: refuse; dry runs are never refused)

# gaffer_spend_cap_ok → 0 when a live run may start, 1 when it must refuse. Pure: reads
# DRY_RUN, GAFFER_ALLOW_UNCAPPED and the two caps; a value <=0 or non-numeric is OFF
# (the same reading gaffer_day_usd_cap_ok / gaffer_budget_headroom_ok give it).
gaffer_spend_cap_ok() {
  [ "${DRY_RUN:-1}" = 1 ] && return 0
  [ "${GAFFER_ALLOW_UNCAPPED:-}" = 1 ] && return 0
  local c
  for c in "${GAFFER_DAILY_BUDGET_USD:-}" "${GAFFER_BUDGET_USD:-}"; do
    [ -n "$c" ] || continue
    # FAIL CLOSED: with no awk to read the figure, treat it as no cap.
    awk -v c="$c" 'BEGIN{exit !(c+0 > 0)}' 2>/dev/null && return 0
  done
  return 1
}

# The one-line fix every refusal prints after its own prefix. It names what is wrong
# with a cap that IS set: GAFFER_DAILY_BUDGET_USD=0 is $0 of headroom (README: "no new
# paid work starts at $0 headroom"), and "abc" is not a number — both used to read "no
# dollar cap is set", which sent the operator looking for a setting they had made.
gaffer_spend_cap_hint() {
  local fix="set GAFFER_DAILY_BUDGET_USD (try 5) or GAFFER_BUDGET_USD in your environment or the dashboard's Settings → Budget & caps; GAFFER_ALLOW_UNCAPPED=1 runs without one"
  local k v why=""
  for k in GAFFER_DAILY_BUDGET_USD GAFFER_BUDGET_USD; do
    v="${!k:-}"
    [ -n "$v" ] || continue
    if grep -Eq '^[[:space:]]*[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)[[:space:]]*$' <<<"$v"; then
      why="${why:+$why; }$k=$v is \$0 headroom: no paid work starts"
    else
      why="${why:+$why; }$k='$v' is not a number"
    fi
  done
  if [ -n "$why" ]; then printf '%s' "$why — $fix"
  else printf '%s' "no dollar cap is set: $fix"; fi
}

# ── THE paid-launch admission check (external review #6) ─────────────────────
# gaffer_paid_launch_admitted [kind] — 0 when a PAID worker launch may start NOW, 1 when
# it may not (the reason on stderr). Called immediately before every paid spawn by the
# shell worker seam (lib/worker.sh worker_deliver: delivery, bootstrap, review, clarify,
# eval judge); the Node seam (lib/worker.mjs deliver: tester, decompose, product owner,
# onboarding analysis, merge resolver) and spec-author ask the SAME module,
# lib/budget-admission.mjs, so one rule governs every launcher: the daily
# (GAFFER_DAILY_BUDGET_USD) and lifetime (GAFFER_BUDGET_USD) caps, read fresh from the
# ledger at the moment of the launch, fail closed on an unknowable spend, and NO cap at
# all refuses like a live run (GAFFER_ALLOW_UNCAPPED=1 opts out). Without node the spend
# cannot be measured: refused when a cap is set; with no cap, the same no-cap rule.
gaffer_paid_launch_admitted() {
  local kind="${1:-worker}" mod
  mod="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/budget-admission.mjs"
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$mod" ]; then
    if [ -n "${GAFFER_DAILY_BUDGET_USD:-}${GAFFER_BUDGET_USD:-}" ]; then
      echo "gaffer: budget: a budget cap is set but the admission check cannot run (node or lib/budget-admission.mjs missing) — refusing the paid $kind launch (fail closed)" >&2
      return 1
    fi
    # No cap at all: refused like a live run unless the operator opted out.
    if [ "${GAFFER_ALLOW_UNCAPPED:-}" != 1 ]; then
      echo "gaffer: budget: a paid $kind launch refuses to start without a dollar cap, like a live run — $(gaffer_spend_cap_hint)" >&2
      return 1
    fi
    return 0
  fi
  node "$mod" check --kind "$kind" >/dev/null
}
