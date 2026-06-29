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
#   GAFFER_CI_TIMEOUT_POLICY=block   what to do when GAFFER_REQUIRE_CI=1 and
#                                    checks time out, no PR exists, or no checks
#                                    are found.  Accepted values:
#                                      block   (default) — fail closed: return 2
#                                               so tick.sh rejects the delivery.
#                                      proceed — fail open: surface a note and
#                                               return 0 (legacy behaviour, now an
#                                               explicit operator opt-out).

: "${GAFFER_CI_POLL_ATTEMPTS:=20}"
: "${GAFFER_CI_POLL_INTERVAL_SECS:=30}"

# True when CI gate enforcement is opted in.
gaffer_ci_gate_enabled() {
  case "${GAFFER_REQUIRE_CI:-0}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

# True when GAFFER_CI_TIMEOUT_POLICY is "proceed" (explicit operator opt-out of
# strict mode).  Default is "block" (fail closed) — any other value is treated
# as block so future values cannot accidentally open the gate.
gaffer_ci_timeout_proceed() {
  case "${GAFFER_CI_TIMEOUT_POLICY:-block}" in
    proceed) return 0 ;;
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
#     → 0  checks passed (or gate is off)
#     → 2  checks failed, OR (under strict mode) timeout / no PR / no checks
#          → caller should auto-reject back to rework
#
# Strict mode (the default when GAFFER_REQUIRE_CI=1):
#   timeout, no-PR, and no-checks-found all FAIL CLOSED (return 2) so delivery
#   is never waved through on a broken signal. Set GAFFER_CI_TIMEOUT_POLICY=proceed
#   to restore the legacy fail-open behaviour for those cases only; red checks
#   always return 2 regardless.
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
  local no_data_count=0

  log "H3: CI gate active for #$num branch=$branch policy=${GAFFER_CI_TIMEOUT_POLICY:-block} — polling up to ${max_attempts}×${interval}s"

  while [ "$attempt" -lt "$max_attempts" ]; do
    attempt=$((attempt + 1))

    # `gh pr checks` exits non-zero when checks fail OR are pending; we parse
    # stdout to distinguish the two cases. Run in the repo dir so gh can find the
    # remote without --repo.
    local checks_out
    checks_out="$(
      cd "$repo_dir" 2>/dev/null &&
      "$GAFFER_GH_BIN" pr checks "$branch" --json name,status,conclusion,detailsUrl \
        --jq '.[]|[.name,.status,.conclusion,(.detailsUrl//"")]|@tsv' 2>/dev/null
    )" || checks_out=""

    # If gh returned no output at all the PR may not exist yet or checks haven't
    # been registered.  In strict mode this is treated as "no-PR / no-checks"
    # after all attempts are exhausted.  In proceed mode we keep waiting each time.
    if [ -z "$checks_out" ]; then
      no_data_count=$((no_data_count + 1))
      log "H3: poll $attempt/$max_attempts for #$num — no checks data (PR may not exist or no checks registered); waiting"
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

  # Determine reason: all polls returned no data → "no PR / no checks";
  # otherwise checks stayed pending → "timeout".
  local timeout_reason
  if [ "$no_data_count" -ge "$max_attempts" ]; then
    timeout_reason="no PR found or no checks registered after ${max_attempts} polls on branch $branch"
    log "H3: CI NO-PR/NO-CHECKS for #$num — $timeout_reason"
  else
    timeout_reason="CI checks still pending after ${max_attempts} polls (${interval}s each) on branch $branch"
    log "H3: CI TIMEOUT for #$num — $timeout_reason"
  fi

  if gaffer_ci_timeout_proceed; then
    # Explicit operator opt-out: surface a note and proceed (legacy behaviour).
    wg attach-evidence "$num" --type manual_note \
      --summary "H3: $timeout_reason — GAFFER_CI_TIMEOUT_POLICY=proceed; proceeding to human review" \
      >/dev/null 2>&1 || true
    log "H3: GAFFER_CI_TIMEOUT_POLICY=proceed — surfacing note and proceeding for #$num"
    return 0
  else
    # Default strict mode: fail closed so delivery is not waved through.
    wg attach-evidence "$num" --type test_output \
      --summary "H3 CI BLOCKED (strict): $timeout_reason — set GAFFER_CI_TIMEOUT_POLICY=proceed to override" \
      >/dev/null 2>&1 || true
    log "H3: strict mode — failing closed for #$num (set GAFFER_CI_TIMEOUT_POLICY=proceed to override)"
    return 2
  fi
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
