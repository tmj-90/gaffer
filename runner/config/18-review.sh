# shellcheck shell=bash
# runner/config/18-review.sh: review and ship decisions: the resume report, the graduated-autonomy ship
# plan and its config checks, the lite trivial classifier, the security second
# opinion, the reviewer verdict and rework reason.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# RESUME REPORT (tick.sh): a resumed delivery holds no claim, so the agent's own evidence
# writes are refused and its prompt tells it to END its message with the AC -> test lines
# and the smallest-change note. Record the tail of that final text (the `.result` of the
# agent's JSON envelope in $2) as a runner-attributed manual_note on ticket $1, so the
# minimalism gate and the reviewer can read it. No text → nothing recorded (rc 0);
# a failed write → rc 1.
gaffer_record_resume_report() {
  local num="$1" usage="$2" report
  [ -n "$num" ] && [ -s "$usage" ] || return 0
  # The tolerant envelope parser every other agent-output reader uses (lib/worker.mjs).
  report="$(node "$RUNNER_DIR/lib/worker.mjs" parse-result result-text --json-file "$usage" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>process.stdout.write(s.trim().slice(-4800)))' 2>/dev/null || true)"
  [ -n "$report" ] || return 0
  wg attach-evidence "$num" --type manual_note --summary "resume agent report: $report" >/dev/null 2>&1
}

# GRADUATED-AUTONOMY: the read-only ship decision the AFK gate consults per ticket —
# "is `auto` permitted for ticket $1 at gate $2 (approve|merge)?" It reuses dispatch's
# isAutonomyAllowed (env FLOOR OR an earned per-repo/risk `auto` policy) via the
# `wg ticket auto-decision` CLI, so the runner adds NO policy logic of its own and can
# never diverge from the enforced decision. The autonomy env flags are UNexported shell
# vars (see the GAFFER_MODE cluster above), so the floor is passed EXPLICITLY into the
# CLI's environment here — otherwise the child node process would see them unset. Echoes
# exactly `allow` or `deny`. FAILS CLOSED: any error, missing DB, or non-`allow` → `deny`.
gaffer_auto_decision() {
  local _ref="$1" _gate="$2" _out _dec
  _out="$(
    export AUTO_MERGE="${AUTO_MERGE:-0}" \
           MERGE_ON_AGENT_REVIEW="${MERGE_ON_AGENT_REVIEW:-0}" \
           DISPATCH_ALLOW_AGENT_APPROVE="${DISPATCH_ALLOW_AGENT_APPROVE:-0}"
    wg ticket auto-decision "$_ref" --gate "$_gate" 2>/dev/null
  )" || _out=""
  _dec="$(printf '%s' "$_out" | jget 'd.decision ?? "deny"' 2>/dev/null || echo deny)"
  [ "$_dec" = "allow" ] && printf 'allow\n' || printf 'deny\n'
}

# GRADUATED-AUTONOMY: per-repo `auto` policy rows are consulted ONLY inside the agent
# review pass (REVIEW_MODE=agent|both → gaffer_auto_decision). In the default supervised
# posture (REVIEW_MODE=human) no reviewer runs, so a policy the operator enabled shows
# "Enabled" in Settings and never acts. Detect that and say so — ONE line per run (the
# marker lives in the run's own state dir, lib/run-state.sh). Read-only
# and fail-soft: a missing DB / CLI error simply logs nothing. Echoes the number of inert
# `auto` rows found (0 when none / not applicable) for the caller's own use.
gaffer_inert_policy_check() {
  local _n=0 _marker="${GAFFER_DATA:+${GAFFER_RUN_STATE_DIR:-$GAFFER_DATA}/.autonomy-policy-inert-warned}"
  [ "${REVIEW_MODE:-human}" = "human" ] || { printf '0\n'; return 0; }
  _n="$(wg autonomy policies --mode auto 2>/dev/null | jget 'd.count ?? 0' 2>/dev/null || echo 0)"
  case "$_n" in ''|*[!0-9]*) _n=0 ;; esac
  if [ "$_n" -gt 0 ]; then
    if [ -z "$_marker" ] || [ ! -f "$_marker" ]; then
      log "AUTONOMY: WARNING — $_n per-repo 'auto' policy grant(s) are enabled but REVIEW_MODE=human, so no reviewer agent runs and the policies are never consulted: they are INERT. Set Review mode to agent or both (or Autonomy mode to graduated) for them to act, or turn them off in Settings."
      [ -n "$_marker" ] && : > "$_marker" 2>/dev/null
    fi
  fi
  printf '%s\n' "$_n"
  return 0
}

# HALF-CONFIGURED MERGE: MERGE_ON_AGENT_REVIEW ("Auto-merge on agent review") only
# EXTENDS Auto-merge on approval to agent approvals — the merge gate is AUTO_MERGE AND
# MERGE_ON_AGENT_REVIEW (dispatch's envAllowsAuto('merge')). Flipping only
# MERGE_ON_AGENT_REVIEW gives approve-and-hold: agent-approved work waits at
# ready_for_merge. We deliberately do NOT let one flag imply the other (that would turn
# on more unattended merging than the operator set); say so ONCE per run instead (the
# marker lives in the run's own state dir, lib/run-state.sh). Echoes
# 1 when it warned (or would have, marker already present), else 0.
gaffer_half_merge_config_check() {
  local _marker="${GAFFER_DATA:+${GAFFER_RUN_STATE_DIR:-$GAFFER_DATA}/.merge-config-half-warned}"
  if _gaffer_flag_on "${MERGE_ON_AGENT_REVIEW:-0}" && ! _gaffer_flag_on "${AUTO_MERGE:-0}"; then
    if [ -z "$_marker" ] || [ ! -f "$_marker" ]; then
      log "AUTONOMY: WARNING — MERGE_ON_AGENT_REVIEW=1 but AUTO_MERGE is off: 'Auto-merge on agent review' needs 'Auto-merge on approval' too, so agent-approved tickets will WAIT at ready_for_merge for a human merge. Turn AUTO_MERGE on to let them land (or turn MERGE_ON_AGENT_REVIEW off to silence this)."
      [ -n "$_marker" ] && : > "$_marker" 2>/dev/null
    fi
    printf '1\n'; return 0
  fi
  printf '0\n'
  return 0
}

# GRADUATED-AUTONOMY: the PURE ship-decision matrix — the single source of truth mapping
# (reviewer verdict × approve gate × merge gate) → one runner action, so the AFK block in
# tick.sh just dispatches on the result and the logic is unit-testable in isolation. No I/O,
# no side effects. FAIL-CLOSED: unless the approve gate is `allow` the plan is `hold`.
#   $1 verdict         : approve | changes | held   (the reviewer's advisory verdict)
#   $2 approve-decision: allow | deny         (gaffer_auto_decision <n> approve)
#   $3 merge-decision  : allow | deny         (gaffer_auto_decision <n> merge)
#   $4 review mode     : human | agent | both (optional; REVIEW_MODE)
# Echoes exactly one of:
#   hold          — the runner does NOT act; the ticket waits in_review for a human
#                   (supervised env floor, or a graduated repo/risk not yet earned).
#   rework        — approve earned + CHANGES verdict → reject to rework.
#   ship          — approve AND merge earned + APPROVE verdict → approve then auto-merge.
#   approve_hold  — approve earned + APPROVE verdict, but merge NOT earned → approve and
#                   hold at ready_for_merge for a human to merge.
# REVIEW_MODE=both is "an agent screens first, then a HUMAN confirms": the agent's
# APPROVE is never an approval there, whatever the floor or an earned policy row says —
# it HOLDS in_review for the human's confirm. The screen still bounces a CHANGES verdict
# back to rework (when the approve gate is earned), so the human sees only work the agent
# passed. Without this `both` behaved exactly like `agent` and shipped with no human.
gaffer_afk_ship_plan() {
  local _verdict="$1" _approve="$2" _merge="$3" _mode="${4:-}"
  if [ "$_approve" != "allow" ]; then printf 'hold\n'; return 0; fi
  if [ "$_verdict" = "approve" ]; then
    if [ "$_mode" = "both" ]; then printf 'hold\n'; return 0; fi
    [ "$_merge" = "allow" ] && printf 'ship\n' || printf 'approve_hold\n'
  elif [ "$_verdict" = "changes" ]; then
    printf 'rework\n'
  else
    printf 'hold\n'  # held / anything unexpected: no verdict → never rework on it
  fi
}

# The lite bounds: how small a diff must be to count as trivial.
: "${GAFFER_LITE_MAX_DIFF:=}"   # lite mode's trivial-diff bounds as "lines=60 files=4" (the defaults); a bound not named keeps its default.
_gaffer_deprecated GAFFER_LITE_MAX_LINES 'set GAFFER_LITE_MAX_DIFF="lines=N" instead'
_gaffer_deprecated GAFFER_LITE_MAX_FILES 'set GAFFER_LITE_MAX_DIFF="files=N" instead'
# The sensitive paths: one knob replaces the built-in list below for both of its readers
# (the lite classifier and the security second opinion), an extended regex over
# repo-relative paths. The old GAFFER_LITE_SENSITIVE_RE and GAFFER_SECURITY_REVIEW_RE are
# deprecated: still read, the knob wins over them.
: "${GAFFER_SENSITIVE_PATH_RE:=}"   # the paths that count as sensitive (lite never auto-approves them; they get the security second opinion); empty = the built-in list. A value replaces the whole list for both, so keep the built-in paths in it to widen it; a malformed regex holds every lite ticket and runs every second opinion.
_gaffer_deprecated GAFFER_LITE_SENSITIVE_RE "set GAFFER_SENSITIVE_PATH_RE instead (it covers the security review too)"
_gaffer_deprecated GAFFER_SECURITY_REVIEW_RE "set GAFFER_SENSITIVE_PATH_RE instead (it replaces the lite classifier's list too, so keep the built-in paths in it)"

# The default SECURITY-SENSITIVE PATH regex, shared by the lite trivial classifier and
# the security second-review lane (one definition, so the two cannot drift). The
# `auth` stem carves out only `author`: author/authors/authoring used to trip it (an
# extra security reviewer per approve, and a lite trivial change held as "sensitive").
# auth + "or" matches only when followed by s/z (authorize*, authoris/zation). Every
# other auth* path stays a PREFIX match — auth, authn, authz, oauth/OAuth2,
# authentication, AuthGuard, auth.ts, auth/ and the lowercase compounds (authmiddleware,
# authhandler, authconfig, authprovider) that a required word boundary would lose. The
# other stems are PREFIX matches on purpose too — this is a security gate, so .env*
# (incl. .envrc), secrets*, security*, migrations* keep matching.
_GAFFER_SENSITIVE_PATH_RE='(^|/)([Mm]igrations?|\.github/|[Dd]ockerfile|[Oo]?[Aa]uth([^o]|o[^r]|ori[sz]|$)|[Ss]ecurity|[Ss]ecrets?|\.env|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.gaffer|safety-hook|runner/lib/hook/|runner/lib/dangerous-commands\.mjs)'

# LITE MODE trivial classifier — PURE core. Decides whether a ticket is trivial enough
# to auto-approve WITHOUT a human reviewer. This is an ADDITIONAL narrowing that only
# applies in GAFFER_MODE=lite: a trivial ticket has already passed the DoD (tests/lint/
# typecheck) + hygiene gates to reach in_review, and the reviewer AGENT must still return
# APPROVE; on top of that, ALL of these must hold or it holds for a human:
#   • risk_level = low
#   • diff within the TIGHT lite caps (GAFFER_LITE_MAX_DIFF="lines=60 files=4", the
#     defaults; the old GAFFER_LITE_MAX_LINES / _FILES are deprecated, still read for a
#     bound the knob does not name)
#   • touches NO sensitive path (migrations, CI, Dockerfile, auth/security/secrets, lockfiles,
#     the factory's own .gaffer / safety-hook, its runner/lib/hook/ rule modules and its
#     deny list runner/lib/dangerous-commands.mjs):
#     GAFFER_SENSITIVE_PATH_RE, operator-tunable (the built-in list above when empty).
# NB: intentionally tiny caps (60 lines / 4 files) — "trivial" means a typo/doc/small-config
# change, NOT the 400-line minimalism cap. No I/O, no side effects; echoes `trivial` or
# `nontrivial:<reason>` so the caller can log WHY a ticket was held.
#   $1 risk   $2 lines(int)   $3 files(int)   $4 changed-paths(newline-separated)
gaffer_lite_trivial_reason() {
  local _risk="$1" _lines="$2" _files="$3" _paths="$4"
  local _maxl="${GAFFER_LITE_MAX_LINES:-60}" _maxf="${GAFFER_LITE_MAX_FILES:-4}" _kv
  local -a _lim=()
  IFS=$', \t\n' read -r -a _lim <<<"${GAFFER_LITE_MAX_DIFF:-}"
  for _kv in ${_lim[@]+"${_lim[@]}"}; do
    case "$_kv" in lines=?*) _maxl="${_kv#*=}" ;; files=?*) _maxf="${_kv#*=}" ;; esac
  done
  local _re="${GAFFER_SENSITIVE_PATH_RE:-${GAFFER_LITE_SENSITIVE_RE:-$_GAFFER_SENSITIVE_PATH_RE}}"
  [ "$_risk" = "low" ] || { printf 'nontrivial:risk=%s\n' "$_risk"; return 0; }
  case "$_lines" in '' | *[!0-9]*) _lines=999999 ;; esac
  case "$_files" in '' | *[!0-9]*) _files=999999 ;; esac
  [ "$_lines" -le "$_maxl" ] || { printf 'nontrivial:lines=%s>%s\n' "$_lines" "$_maxl"; return 0; }
  [ "$_files" -le "$_maxf" ] || { printf 'nontrivial:files=%s>%s\n' "$_files" "$_maxf"; return 0; }
  # Here-string, not `printf | grep -q`: under pipefail grep's early exit can SIGPIPE
  # the printf and turn this MATCH into a miss — a sensitive diff called "trivial".
  # A regex grep cannot use (exit 2: a malformed GAFFER_SENSITIVE_PATH_RE or deprecated
  # GAFFER_LITE_SENSITIVE_RE) matches nothing; it must hold the ticket, never call every
  # path non-sensitive.
  local _grc=0
  grep -qE -- "$_re" <<<"$_paths" 2>/dev/null || _grc=$?
  case "$_grc" in
    0) printf 'nontrivial:sensitive-path\n'; return 0 ;;
    1) ;;
    *) printf 'nontrivial:sensitive-path-regex-invalid\n'; return 0 ;;
  esac
  printf 'trivial\n'
}

# LITE MODE trivial classifier — I/O wrapper. Gathers the ticket risk (dispatch) + the
# delivered diff's size and paths (git, from the review worktree's branch vs base) and runs
# the pure core. Returns 0 (trivial → runner may auto-approve) / 1 (non-trivial → hold for a
# human). Sets GAFFER_LITE_REASON / _LINES / _FILES for the caller's log + evidence marker.
# FAIL-CLOSED: a missing risk defaults to 'medium' (non-trivial); unreadable diff → large.
#   $1 ticket#   $2 repo-path   $3 base-ref   $4 delivery-branch
gaffer_ticket_is_trivial() {
  local _num="$1" _repo="$2" _base="$3" _branch="$4" _risk _stat _lines _files _paths _r
  _risk="$(wg ticket show "$_num" 2>/dev/null | jget 'd.ticket.risk_level || "medium"' 2>/dev/null || echo medium)"
  _stat="$(git -C "$_repo" diff "$_base"..."$_branch" --numstat 2>/dev/null)"
  _lines="$(printf '%s\n' "$_stat" | awk 'NF{a+=($1 ~ /^[0-9]+$/ ? $1 : 0)+($2 ~ /^[0-9]+$/ ? $2 : 0)} END{print a+0}')"
  _files="$(printf '%s\n' "$_stat" | awk 'NF' | grep -c . || true)"
  _paths="$(git -C "$_repo" diff "$_base"..."$_branch" --name-only 2>/dev/null)"
  _r="$(gaffer_lite_trivial_reason "$_risk" "${_lines:-0}" "${_files:-0}" "$_paths")"
  GAFFER_LITE_REASON="$_r"; GAFFER_LITE_LINES="${_lines:-0}"; GAFFER_LITE_FILES="${_files:-0}"
  case "$_r" in trivial) return 0 ;; *) return 1 ;; esac
}

# SECURITY SECOND OPINION — decides whether a ticket gets a SECOND, security-focused
# reviewer pass after the primary reviewer APPROVEs (lib/review.sh). A ticket qualifies
# when its risk_level is high, or when the delivered diff touches a security-sensitive
# path (auth, secrets, migrations, CI, Dockerfiles, lockfiles, the factory's own guards —
# GAFFER_SENSITIVE_PATH_RE, operator-tunable; the same paths the lite classifier holds). GAFFER_SECURITY_REVIEW=0 disables the lane; empty/1 = on. Sets
# GAFFER_SECURITY_REVIEW_REASON for the log. Returns 0 (needs it) / 1 (does not).
#   $1 ticket number  $2 repo path  $3 base branch  $4 delivery branch
: "${GAFFER_SECURITY_REVIEW:=1}"
# MERGE LANE (lib/merge-lane.sh): at the start of every tick, land every ready_for_merge
# ticket the merge policy permits (a human's approve, the tester's PASS, a merge gate
# held at review time and since earned) through the same landing the review pass uses,
# so dependents unblock without the dashboard's Merge button. 0 = off (a ready_for_merge
# ticket then waits for a human to merge — the pre-lane behaviour).
: "${GAFFER_MERGE_LANE:=1}"
# CONFLICT RESOLVER (lib/land.sh): when a landing hits a merge CONFLICT (the branch forked
# before a sibling landed on the same files), spawn bin/merge-ticket.mjs's resolver agent
# ONCE per ticket: it merges the default branch into the delivery branch in a throwaway
# worktree, resolves preserving both sides, and reopens the ticket for re-review of the
# resolved diff (never a silent landing). 0 = off (a conflict holds the ticket at
# ready_for_merge for a human, and its dependents wait). Bounded by GAFFER_MERGE_TIMEOUT_MS.
: "${GAFFER_CONFLICT_RESOLVER:=1}"
# MERGE GATE (lib/land.sh, bin/merge-ticket.mjs): every landing first builds the merge of
# the approved commit onto the CURRENT target in a scratch worktree and runs the repo's
# DoD gates on that merge (bin/dod-regate.sh: test, lint and the same typecheck command
# as the delivery gate, gaffer_dod_typecheck_cmd); a red combination is held for a human
# (blocked, merge_gate_red) and the target is not touched. The gated merge commit lands
# only while the target still is the gated head; a target that moved meanwhile is
# re-gated up to twice, then the ticket waits for the next run. Always on
# (GAFFER_DOD=0, which turns every gate off, is the only way to land ungated).
gaffer_needs_security_review() {
  local _num="$1" _repo="$2" _base="$3" _branch="$4" _risk _paths _re
  GAFFER_SECURITY_REVIEW_REASON=""
  case "${GAFFER_SECURITY_REVIEW:-1}" in 0|false|no|off) return 1 ;; esac
  _risk="$(wg ticket show "$_num" 2>/dev/null | jget 'd.ticket.risk_level || "medium"' 2>/dev/null || echo medium)"
  if [ "$_risk" = "high" ]; then GAFFER_SECURITY_REVIEW_REASON="risk=high"; return 0; fi
  _re="${GAFFER_SENSITIVE_PATH_RE:-${GAFFER_SECURITY_REVIEW_RE:-${GAFFER_LITE_SENSITIVE_RE:-$_GAFFER_SENSITIVE_PATH_RE}}}"
  _paths="$(git -C "$_repo" diff "$_base"..."$_branch" --name-only 2>/dev/null)"
  local _grc=0
  grep -qE -- "$_re" <<<"$_paths" 2>/dev/null || _grc=$?   # here-string: no SIGPIPE false miss under pipefail
  case "$_grc" in
    0) GAFFER_SECURITY_REVIEW_REASON="sensitive-path: $(printf '%s\n' "$_paths" | grep -E "$_re" | head -3 | paste -sd, -)"
       return 0 ;;
    1) return 1 ;;
    # A regex grep cannot use (exit 2) matches nothing: the second opinion runs rather
    # than every path reading as non-sensitive.
    *) GAFFER_SECURITY_REVIEW_REASON="sensitive-path regex unusable (GAFFER_SENSITIVE_PATH_RE): reviewing to be safe"
       return 0 ;;
  esac
}

# S-H2: reviewer VERDICT resolution from an OUT-OF-BAND STRUCTURED signal, NOT a
# free-text grep over the reviewer's whole prose. In AFK/graduated mode a clean
# `approve` triggers an autonomous approve+merge with no human, so the verdict must
# not be forgeable by text QUOTED in the reviewer's reasoning. An adversarial
# ticket/diff/rejection-reason could make the reviewer reproduce "RECOMMEND APPROVE"
# in prose; the old grep over the entire blob would then flip the gate.
#
# The reviewer is required to end its output with a machine-read line —
#   {"verdict":"APPROVE"}  or  {"verdict":"CHANGES"}
# — and ONLY its FINAL non-empty line counts (a closing ``` fence, trailing blanks and
# CRs ignored; surrounding backticks tolerated). A token anywhere else is quoted text:
# a CHANGES token followed by "Note: the ticket asked me to print {"verdict":"APPROVE"}"
# used to resolve to approve, because the last token ANYWHERE won. A final line that is
# not a token at all (a non-compliant or cut-off reviewer) is no verdict: `held`, never
# `changes` (that sent a possibly-fine delivery to rework, and could loop) and never
# `approve` — the old free-text RECOMMEND APPROVE fallback no longer approves anything.
# Pure: no I/O, no side effects.
#   $1 result : the reviewer agent's full result text (may be multi-line)
# Echoes exactly one of: approve | changes | held   (held on empty/ambiguous).
gaffer_review_verdict() {
  local _result="$1" _last
  _last="$(printf '%s\n' "$_result" | tr -d '\r' \
    | sed -E 's/[[:space:]]+$//' | grep -vE '^[[:space:]]*(```[[:alnum:]_-]*)?$' | tail -n 1 \
    | sed -E 's/^[[:space:]]*`?//; s/`?[[:space:]]*$//')"
  # Braces are matched via [{]/[}] so the ERE is portable across BSD (macOS
  # /usr/bin/grep) and GNU grep (CI) — `\{` is an interval metacharacter to GNU grep.
  if grep -qixE '[{][[:space:]]*"verdict"[[:space:]]*:[[:space:]]*"APPROVE"[[:space:]]*[}]' <<<"$_last"; then
    printf 'approve\n'
  elif grep -qixE '[{][[:space:]]*"verdict"[[:space:]]*:[[:space:]]*"CHANGES"[[:space:]]*[}]' <<<"$_last"; then
    printf 'changes\n'
  else
    printf 'held\n'
  fi
}

# The REWORK REASON handed back to the delivery agent on a CHANGES verdict. The
# reviewer's prompt ends its report with the "RECOMMEND CHANGES: <the concrete fix>"
# line, so the actionable part is the TAIL of the result — but `tail -c 480` cut a
# long report mid-word and kept the verdict token, so the agent read "…viour and is
# acceptable… {"verdict":"CHANGES"}" with the actual ask truncated (seen live). Keep
# the text FROM the last RECOMMEND CHANGES marker (the reviewer's own summary of what
# to fix), drop the structured verdict token, collapse whitespace, cap from the FRONT
# at 600 chars; with no marker fall back to the last 480 chars as before.
#   gaffer_review_reason <reviewer result>   → one line, never empty
gaffer_review_reason() {
  local _result="$1" _flat _from _reason
  _flat="$(printf '%s' "$_result" | tr '\n' ' ' \
    | sed -E 's/[{][[:space:]]*"verdict"[[:space:]]*:[[:space:]]*"[A-Za-z]+"[[:space:]]*[}]//g' \
    | tr -s ' ')"
  _from="$(printf '%s' "$_flat" | grep -oiE 'RECOMMEND[ _-]*CHANGES.*$' | tail -n 1)"
  if [ -n "$_from" ]; then _reason="$(printf '%s' "$_from" | cut -c1-600)"; else _reason="$(printf '%s' "$_flat" | tail -c 480)"; fi
  _reason="$(printf '%s' "$_reason" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [ -n "$_reason" ] || _reason="agent review recommended changes"
  printf '%s\n' "$_reason"
}

_GAFFER_CONFIG_PART=18-review
