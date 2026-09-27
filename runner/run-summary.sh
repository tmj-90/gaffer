#!/usr/bin/env bash
# Gaffer factory — end-of-run summary. After a loop.sh run this reports, in one
# screen, what the factory actually did and what now needs a human:
#   • landed        — done / merged tickets
#   • failed-safe   — blocked tickets (failed in a safe, recoverable way)
#   • parked        — refining tickets + the reason each was returned (hygiene /
#                     minimalism / empty delivery)
#   • re-queued     — ready tickets (back in the queue for another attempt)
#   • oversized     — tickets flagged needs_human_review: oversized_diff
#   • per-repo      — outstanding work vs cap, and which repos are in backpressure
#   • cleanup       — any hygiene leak this run flagged (post-teardown residue)
#
# Non-mutating. loop.sh prints it at the end of a run. The data sources are
# env-overridable so the report is testable without the real CLIs:
#   SUMMARY_LIST_CMD  prints `ticket list -s <status>` JSON (status appended)
#   SUMMARY_SHOW_CMD  prints `ticket show <ref>` JSON       (ref appended)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=factory.config.sh
source "$HERE/factory.config.sh"

c_grn='\033[1;32m'; c_cya='\033[1;36m'; c_yel='\033[1;33m'; c_red='\033[1;31m'; c_dim='\033[2m'; c_off='\033[0m'
say()  { printf "${c_cya}gaffer${c_off} %s\n" "$*"; }
line() { printf "  %-16s %s\n" "$1" "$2"; }

# Data accessors (overridable by tests). Each appends its single argument.
# No eval: the override command is read into an argv array and invoked directly, so
# the status argument can never be re-interpreted as shell. This is a
# containment-sensitive path — keep it eval-free.
sum_list_raw() {
  if [ -n "${SUMMARY_LIST_CMD:-}" ]; then local -a c; read -ra c <<<"$SUMMARY_LIST_CMD"; "${c[@]}" "$1"
  else wg ticket list -s "$1"; fi
}
sum_show() {
  if [ -n "${SUMMARY_SHOW_CMD:-}" ]; then local -a c; read -ra c <<<"$SUMMARY_SHOW_CMD"; "${c[@]}" "$1"
  else wg ticket show "$1"; fi
}

# Per-status list cache. sum_list <status> is asked for the same status repeatedly
# across count_status / parked_reasons / oversized_flagged / cleanup; fetch the list
# from Dispatch (a subprocess) exactly ONCE per status and reuse the JSON text.
# Stored as files under a private temp dir — associative arrays aren't available on
# the bash 3.2 that ships with macOS, and a file cache needs no eval/dynamic vars.
_LIST_CACHE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/run-summary-cache.XXXXXX")"
trap 'rm -rf "$_LIST_CACHE_DIR"' EXIT
sum_list() {
  local f="$_LIST_CACHE_DIR/$1"
  if [ ! -f "$f" ]; then
    sum_list_raw "$1" 2>/dev/null > "$f"
  fi
  cat "$f"
}

# Count tickets in a status. The list JSON is an array of ticket objects each
# carrying a "number" key, so the object count == the count of `"number":` keys.
# grep -c is one cheap spawn vs a python interpreter per status.
count_status() { sum_list "$1" | grep -o '"number"' | grep -c . ; }

# Ticket numbers for a status, space-separated. Pull every `"number": <n>` value
# off the raw JSON with grep/sed — no python.
status_numbers() {
  sum_list "$1" \
    | grep -o '"number"[[:space:]]*:[[:space:]]*[0-9]\+' \
    | sed 's/.*:[[:space:]]*//' \
    | tr '\n' ' '
}

# Parked reasons: for each refining ticket, surface the latest park reason recorded
# by a stabilisation gate (hygiene / minimalism / empty delivery) from its events.
# Pure text extraction: pull the ticket title and the first events[] summary that
# matches a park keyword straight off the show JSON with grep/sed — no python.
parked_reasons() {
  local nums n title reason
  nums="$(status_numbers refining)"
  for n in $nums; do
    local raw; raw="$(sum_show "$n" 2>/dev/null)"
    title="$(printf '%s' "$raw" | grep -o '"title"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*:[[:space:]]*"//; s/"$//' | cut -c1-40)"
    # First summary/reason/payload string mentioning a park keyword (case-insensitive).
    reason="$(printf '%s' "$raw" \
      | grep -o '"\(summary\|reason\|payload\)"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed 's/.*:[[:space:]]*"//; s/"$//' \
      | grep -iE 'hygiene|minimalism|smallest-change|parked|empty' \
      | head -n1 | cut -c1-80)"
    if [ -n "$reason" ]; then
      printf '    #%s %s  — %s\n' "$n" "$title" "$reason"
    else
      printf '    #%s %s\n' "$n" "$title"
    fi
  done
}

# Oversized-flagged: tickets carrying a needs_human_review: oversized_diff note.
oversized_flagged() {
  local found=0 status n nums
  for status in in_review refining ready 'done'; do
    nums="$(status_numbers "$status")"
    for n in $nums; do
      # Substring match on the raw ticket JSON — a plain grep is far cheaper to spawn
      # than a python per ticket (this loop runs once per ticket across 4 statuses).
      if sum_show "$n" 2>/dev/null | grep -qi 'oversized_diff'; then
        printf '    #%s (oversized_diff)\n' "$n"; found=1
      fi
    done
  done
  [ "$found" = "0" ] && printf "    ${c_dim}(none)${c_off}\n"
}

say "run summary"

printf "\n  ${c_dim}outcomes${c_off}\n"
line "landed:"      "$(count_status 'done') done"
line "failed-safe:" "$(count_status blocked) blocked"
line "parked:"      "$(count_status refining) refining"
line "re-queued:"   "$(count_status ready) ready"
line "in-review:"   "$(count_status in_review) awaiting review"
line "in-testing:"  "$(count_status in_testing) awaiting independent tests"

printf "\n  ${c_dim}parked (refining) + reasons${c_off}\n"
_pr="$(parked_reasons)"; [ -n "$_pr" ] && printf '%s\n' "$_pr" || printf "    ${c_dim}(none)${c_off}\n"

printf "\n  ${c_dim}oversized-flagged${c_off}\n"
oversized_flagged

# Per-repo pressure: read the backpressure-repos file the tick wrote this run, if
# present; otherwise report "no backpressure recorded this run".
printf "\n  ${c_dim}per-repo pressure (outstanding branches/in_review/claims vs cap)${c_off}\n"
printf "    ${c_dim}caps: branches=%s in_review=%s claims=%s${c_off}\n" \
  "${MAX_OPEN_AGENT_BRANCHES_PER_REPO:-3}" "${MAX_OPEN_AGENT_PRS_PER_REPO:-3}" "${MAX_CONCURRENT_TICKETS_PER_REPO:-2}"
BP_FILE="${GAFFER_BP_FILE:-$GAFFER_DATA/.backpressure-repos}"
if [ -s "$BP_FILE" ]; then
  while IFS=$'\t' read -r repo triple reason; do
    [ -n "$repo" ] || continue
    printf "    ${c_yel}!${c_off} %-24s %s  (%s)\n" "$repo" "$triple" "$reason"
  done < "$BP_FILE"
else
  printf "    ${c_grn}✓${c_off} no repo hit backpressure this run\n"
fi

# Cleanup state: hygiene leaks this run flagged. The hygiene gates record a
# manual_note ("POST-TEARDOWN LEAK" / "PARKED: delivery hygiene violation") on the
# ticket; surface whether any exist so a leak is never silently shipped.
printf "\n  ${c_dim}cleanup state${c_off}\n"
LEAK_HITS=0
for status in refining blocked in_review 'done'; do
  nums="$(status_numbers "$status")"
  for n in $nums; do
    # grep (cheap to spawn) instead of a per-ticket python; substring match on raw JSON.
    if sum_show "$n" 2>/dev/null | grep -qiE 'hygiene violation|post-teardown leak'; then
      printf "    ${c_red}✗${c_off} #%s carries a hygiene-leak note\n" "$n"; LEAK_HITS=$((LEAK_HITS+1))
    fi
  done
done
[ "$LEAK_HITS" = "0" ] && printf "    ${c_grn}✓${c_off} no hygiene leaks flagged this run\n"

# Safety: what the deterministic hook blocked. The trust signal isn't "nothing
# happened" — it's "the agent tried N risky things and every one was stopped".
# Reads the structured block ledger the safety hook appends; SUMMARY_SINCE (set by
# loop.sh to the run start) scopes it to this run, else it reports all-time.
printf "\n  ${c_dim}safety (deterministic hook blocks)${c_off}\n"
BLOCK_LEDGER="${GAFFER_BLOCK_LEDGER:-$GAFFER_DATA/safety-blocks.jsonl}"
if [ -s "$BLOCK_LEDGER" ]; then
  SUMMARY_SINCE="${SUMMARY_SINCE:-}" node "$HERE/lib/json-tool.mjs" summary-blocks "$BLOCK_LEDGER"
else
  printf "    ${c_grn}✓${c_off} no blocks recorded (clean run, or no risky tool calls)\n"
fi

# Usage: what the headless agent calls actually cost this run. The honest signal
# is NOT a single dollar number — it's (a) BILLED tokens as ground truth (incl.
# cache-read, the real cost driver — headlined so $cost isn't read off in+out), (b) the
# opus-plan vs sonnet-impl model split, (c) the API-EQUIVALENT cost relayed
# straight from Claude Code's own figure (never computed from a price table), and
# (d) "N ticks measured, M unknown" so a partial run can't read as cheap. Reads
# the usage ledger the call sites append; SUMMARY_SINCE (set by loop.sh to the run
# start) scopes it to this run, else all-time. GAFFER_USAGE_LEDGER overrides the path.
printf "\n  ${c_dim}usage (headless agent calls — honest)${c_off}\n"
USAGE_LEDGER="${GAFFER_USAGE_LEDGER:-$GAFFER_DATA/usage-ledger.jsonl}"
if [ -s "$USAGE_LEDGER" ]; then
  SUMMARY_SINCE="${SUMMARY_SINCE:-}" node "$HERE/lib/json-tool.mjs" summary-usage "$USAGE_LEDGER"
else
  printf "    ${c_grn}✓${c_off} no agent usage recorded (clean idle run, or no agent calls)\n"
fi

echo
