#!/usr/bin/env bash
# Per-day cost guard for unattended factory runs. MAX_TICKS bounds a SINGLE
# loop.sh invocation, but launchd re-runs loop.sh on a schedule — so MAX_TICKS
# alone can't bound a full day's spend. This tracks a per-CALENDAR-DAY tick count
# persisted in GAFFER_DATA (DAILY_COUNTER_FILE), surviving across loop.sh runs, so
# an overnight factory hard-stops once the day's cap is hit. Each tick invokes
# `claude -p` (real cost), so the count is per tick regardless of result.
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

# Echo today's (UTC) USD spend from the ledger as a decimal (0 when unmeasured, no
# ledger, or node/estimate-lib unavailable). Reuses the ONE shared JSONL reader
# (estimate.mjs parseLedger); the COST summation stays here (estimate.mjs's honesty
# contract forbids it from reading cost). "today" is the UTC date so the window
# matches the ledger's ISO `ts` prefix regardless of the host timezone.
gaffer_day_usd_spent() {
  command -v node >/dev/null 2>&1 || { printf '0'; return 0; }
  local ledger="${GAFFER_USAGE_LEDGER:-${GAFFER_DATA:+$GAFFER_DATA/usage-ledger.jsonl}}"
  [ -n "$ledger" ] && [ -f "$ledger" ] || { printf '0'; return 0; }
  [ -f "${GAFFER_ESTIMATE_LIB:-}" ] || { printf '0'; return 0; }
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
  ' 2>/dev/null || printf '0'
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
  awk -v s="$spent" -v c="$cap" 'BEGIN{exit !(s+0 < c+0)}' 2>/dev/null
}
