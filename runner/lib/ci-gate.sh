# Gaffer H3 — CI-aware review gate (sourced by factory.config.sh).
# shellcheck shell=bash
#
# When GAFFER_REQUIRE_CI=1, after the delivery branch/PR exists, this gate polls
# `gh pr checks <branch>` (or `gh api` commit status) until checks are green,
# then lets the ticket proceed to the human review lane. If CI goes red, the
# ticket is auto-rejected back to rework with the failing check (name + url) as
# evidence — a human never wastes time on a broken CI.
#
# Bounded polling: GAFFER_CI_POLL_ATTEMPTS × GAFFER_CI_POLL_INTERVAL_SECS.
# On timeout (checks still pending after all attempts) the gate surfaces
# "CI still pending" and lets the delivery proceed rather than hanging forever —
# a human should review and wait for CI to finish outside the factory.
#
# The `gh` binary is injectable via GAFFER_GH_BIN (shared with pr-create.sh) so
# unit tests can point it at a stub.
#
# Usage:
#   gaffer_ci_gate <ticket_num> <repo_dir> <branch> <pr_url_or_empty>
#     → 0  CI passed (or gate is off / timed out — proceed to review).
#     → 2  CI failed — caller should auto-reject back to rework.
#
# KNOBS:
#   GAFFER_REQUIRE_CI=0              off by default; set to 1 to opt in.
#   GAFFER_CI_POLL_ATTEMPTS=20       max poll cycles before "still pending" timeout.
#   GAFFER_CI_POLL_INTERVAL_SECS=30  seconds between polls.
#   GAFFER_GH_BIN=gh                 injectable gh binary.

: "${GAFFER_CI_POLL_ATTEMPTS:=20}"
: "${GAFFER_CI_POLL_INTERVAL_SECS:=30}"

# True when CI gate enforcement is opted in.
gaffer_ci_gate_enabled() {
  case "${GAFFER_REQUIRE_CI:-0}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

# Parse the output of `gh pr checks` into a verdict.
# Returns on stdout one of: "pass", "fail:<name>|<url>", "pending", "unknown".
#
# `gh pr checks` exits 0 when all checks pass, non-zero when any fail/are pending.
# The output lines are: <name> <TAB> <status> <TAB> <conclusion> <TAB> <url>
# (or similar, depending on gh version). We look for any "failure"/"error" conclusion.
gaffer_parse_checks() {
  local checks_output="$1"
  if [ -z "$checks_output" ]; then
    printf 'unknown'
    return
  fi
  # If any line contains "fail" or "error" in the conclusion/status column → red.
  local failing=""
  failing="$(printf '%s\n' "$checks_output" \
    | awk -F'\t' 'tolower($2)~/fail|error/ || tolower($3)~/fail|error/ {print $1"\t"$4; exit}')"
  if [ -n "$failing" ]; then
    local check_name check_url
    check_name="$(printf '%s' "$failing" | awk -F'\t' '{print $1}')"
    check_url="$(printf '%s' "$failing" | awk -F'\t' '{print $2}')"
    printf 'fail:%s|%s' "${check_name:-unknown}" "${check_url:-}"
    return
  fi
  # If any line has "pending"/"queued"/"in_progress" → still running.
  if printf '%s\n' "$checks_output" \
     | awk -F'\t' 'tolower($2)~/pending|queue|in_progress|waiting/ || tolower($3)~/pending|queue|in_progress|waiting/ {found=1} END{exit !found}'; then
    printf 'pending'
    return
  fi
  # All lines pass / completed → green.
  printf 'pass'
}

# Poll CI for a branch and block until green, red, or timeout.
#
#   gaffer_ci_gate <ticket_num> <repo_dir> <branch> [pr_url]
#     → 0  checks passed (or gate off / timeout-surfaced)
#     → 2  checks failed → caller auto-rejects
gaffer_ci_gate() {
  local num="$1" repo_dir="$2" branch="$3" pr_url="${4:-}"

  if ! gaffer_ci_gate_enabled; then
    return 0
  fi

  if ! command -v "$GAFFER_GH_BIN" >/dev/null 2>&1; then
    log "H3: '$GAFFER_GH_BIN' not found — CI gate skipped for #$num (no-op)"
    return 0
  fi

  if ! gaffer_has_github_remote "$repo_dir"; then
    log "H3: no GitHub remote — CI gate skipped for #$num (no-op)"
    return 0
  fi

  local max_attempts="${GAFFER_CI_POLL_ATTEMPTS:-20}"
  local interval="${GAFFER_CI_POLL_INTERVAL_SECS:-30}"
  local attempt=0

  log "H3: CI gate active for #$num branch=$branch — polling up to ${max_attempts}×${interval}s"

  while [ "$attempt" -lt "$max_attempts" ]; do
    attempt=$((attempt + 1))

    # `gh pr checks` exits non-zero when checks fail OR are pending; we parse
    # stdout to distinguish the two cases. Run in the repo dir so gh can find the
    # remote without --repo.
    local checks_out checks_rc
    checks_out="$(
      cd "$repo_dir" 2>/dev/null &&
      "$GAFFER_GH_BIN" pr checks "$branch" --json name,status,conclusion,detailsUrl \
        --jq '.[]|[.name,.status,.conclusion,(.detailsUrl//"")]|@tsv' 2>/dev/null
    )" || checks_out=""
    checks_rc=$?

    # If gh returned no output at all (PR not yet created, auth error, etc.) treat
    # as "unknown → pending" rather than crashing.
    if [ -z "$checks_out" ]; then
      log "H3: poll $attempt/$max_attempts for #$num — no checks data yet (PR may not exist); waiting"
      gaffer_ci_sleep "$interval"
      continue
    fi

    local verdict
    verdict="$(gaffer_parse_checks "$checks_out")"

    case "$verdict" in
      pass)
        log "H3: CI GREEN for #$num (attempt $attempt) — proceeding to review"
        return 0
        ;;
      fail:*)
        local detail="${verdict#fail:}"
        local check_name="${detail%%|*}"
        local check_url="${detail#*|}"
        log "H3: CI RED for #$num — failing check: $check_name ${check_url:+($check_url)}"
        # Attach the failure as evidence so the next attempt gets it as feedback.
        wg attach-evidence "$num" --type test_output \
          --summary "H3 CI FAIL: check '$check_name' failed${check_url:+; see $check_url}" \
          >/dev/null 2>&1 || true
        return 2
        ;;
      pending)
        log "H3: CI PENDING for #$num (attempt $attempt/$max_attempts) — waiting ${interval}s"
        gaffer_ci_sleep "$interval"
        ;;
      *)
        log "H3: CI unknown verdict '$verdict' for #$num (attempt $attempt) — waiting"
        gaffer_ci_sleep "$interval"
        ;;
    esac
  done

  # Timeout: checks still pending after all attempts. Surface it and proceed
  # rather than hanging forever — a human reviews while CI finishes.
  log "H3: CI TIMEOUT for #$num — checks still pending after ${max_attempts} polls; surfacing and proceeding to review"
  wg attach-evidence "$num" --type manual_note \
    --summary "H3: CI checks still pending after ${max_attempts} polls (${interval}s each) — proceeding to human review; CI may still be running on branch $branch" \
    >/dev/null 2>&1 || true
  return 0
}

# Portable sleep for CI polling. Uses gaffer_timeout's perl when available so the
# sleep itself is bounded (no hanging sleep processes if the shell is killed).
gaffer_ci_sleep() {
  local secs="$1"
  if command -v perl >/dev/null 2>&1; then
    perl -e "sleep $secs" 2>/dev/null || true
  else
    sleep "$secs" 2>/dev/null || true
  fi
}
