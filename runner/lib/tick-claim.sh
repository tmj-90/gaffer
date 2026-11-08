#!/usr/bin/env bash
# runner/lib/tick-claim.sh
# Admission and claim: the fail-closed setup and spend admission checks, agent
# registration, the ready-candidate scan and claim, the ticket's scope (write/read
# partition, skills), the self-operation ban and the per-repo worktree plan.
#
# Sourced by runner/tick.sh only (required there: a missing file fails the tick
# closed). Function definitions only, so sourcing it runs nothing. Every body was
# moved verbatim out of tick.sh; the functions read and write tick.sh's globals
# (NUM, SHOW, WT_ROWS, CLAIM_TOKEN, ...) exactly as the inline code did, and the
# gaffer_tick_* / _gaffer_idle_* wrappers declare no locals, so every assignment in
# them stays global. See runner/CLAUDE.md for the map of the tick phases.

# Derive an opt-in `--area` from the repo stack label where it is UNAMBIGUOUS, so
# the area-only packs that select-skills now gates (FIX-2) still fire when the
# stack clearly implies a domain. Today only the web/front-end family is safe to
# auto-derive: a react/web/frontend stack → `area=frontend` (so frontend-a11y /
# frontend-component / frontend-responsive / brand fire). Every other stack maps
# to no area (the marketing/product/docs packs stay opt-in for a future
# ticket-type that sets the area explicitly). Echoes the area or nothing.
gaffer_area_for_stack() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    # Mobile RN/Expo is a frontend too. mobile-ui/frontend-design route by stack, but the
    # area-only design packs (brand, frontend-a11y, frontend-responsive, frontend-component)
    # only fire on area=frontend — a mobile app wants those as much as a web app does.
    *react-native*|*expo*|*react*|*frontend*|*web*) printf 'frontend' ;;
    *) ;;
  esac
}

# Derive the delivery-branch slug from a ticket title. SHARED by the normal delivery
# path AND the greenfield bootstrap so both mint the identical `gaffer/ticket-N-<slug>`
# branch shape the reviewer's fallback grep (`gaffer/ticket-$NUM-[a-z0-9-]*`) expects.
# lowercase, non-alnum→'-', collapse repeats, trim, ≤6 words / ~50 chars; empty→'ticket'.
gaffer_ticket_slug() {
  local s
  s="$(printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c 'a-z0-9' '-' \
    | tr -s '-' \
    | sed -E 's/^-+//; s/-+$//' \
    | cut -d- -f1-6 \
    | cut -c1-50 \
    | sed -E 's/-+$//')"
  [ -n "$s" ] || s="ticket"
  printf '%s' "$s"
}

# Fail-closed setup checks + spend admission (may exit). Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_admission() {
[ -f "$DISPATCH_DIR/dist/cli/index.js" ] || gaffer_abort_setup SETUP "dispatch not built — run: pnpm -C $DISPATCH_DIR build"

# R-10: fail closed on a missing timeout primitive. Every live `claude -p` call
# below runs under gaffer_timeout, which now REFUSES to run unbounded when no
# perl/timeout/gtimeout exists. Assert one is present up front and abort the tick
# as a setup error rather than discovering it mid-delivery (a runaway agent must
# never even be launched).
gaffer_timeout_preflight || gaffer_abort_setup SETUP "no timeout primitive — aborting tick (setup error)"

# An existing settings.json that does not parse (or no node to read it) leaves every
# setting it holds — the spend caps included — unknown: factory.config.sh kept the
# inherited values and set _GAFFER_SETTINGS_UNREADABLE. Refuse before any claim or
# spawn, as a setup error (the loop stops, the daemon backs off), never run on
# defaults. DRY_RUN is not exempt: it may be one of the settings that went unread.
if declare -F gaffer_settings_readable >/dev/null 2>&1 && ! gaffer_settings_readable; then
  gaffer_abort_setup SETUP "settings.json ($GAFFER_DATA/settings.json) exists but cannot be parsed (or node is missing) — not starting work until it is fixed"
fi

# OS ISOLATION (lib/sandbox.sh gaffer_isolation_gate): every agent launch needs the OS
# sandbox unless the operator opted out with GAFFER_STRICT_REQUIRE=0 in the environment.
# A host that cannot supply one refuses here, before any claim or spawn, as a setup
# error with the one message a person can act on (the loop stops, the daemon backs
# off, the dashboard shows it). A dry run launches nothing and is never refused. If
# the gate itself is missing (sandbox.sh did not load) the tick refuses too.
if [ "${DRY_RUN:-0}" != "1" ]; then
  if ! declare -F gaffer_isolation_gate >/dev/null 2>&1; then
    gaffer_abort_setup SANDBOX "the OS sandbox check (lib/sandbox.sh) did not load — refusing to launch an agent (fail closed)"
  elif ! gaffer_isolation_gate; then
    gaffer_abort_setup SANDBOX "refusing to launch an agent (fail closed): $(gaffer_sandbox_unavailable_hint)"
  fi
fi

# Part B (defense-in-depth): before this tick can claim work and spawn ANY paid
# `claude -p`, consult the per-UTC-day USD cap. If the day's ledger spend is already
# at/over GAFFER_DAILY_BUDGET_USD, do NOT start new paid work — halt cleanly like the
# MAX_TICKS_PER_DAY / backpressure stops: log the reason and exit 0 with a no_work
# result so the loop treats it as an empty poll and backs off (no crash, no partial
# spend). DRY_RUN never spends, so it is never gated. Inert when the cap is unset/0.
if [ "${DRY_RUN:-0}" != "1" ] && declare -F gaffer_day_usd_cap_ok >/dev/null 2>&1 \
   && ! gaffer_day_usd_cap_ok; then
  log "BUDGET: UTC-day USD cap reached (spent \$$(gaffer_day_usd_spent) >= \$${GAFFER_DAILY_BUDGET_USD}) — not starting new paid work this tick"
  result no_work; exit 0
fi
# The LIFETIME ceiling (GAFFER_BUDGET_USD), gated the same way before any claim or
# spawn: at $0 headroom a new ready ticket used to get one paid delivery call and only
# THEN pause on budget_cap — one call past the "hard ceiling" per ticket. A resume
# (Continue) waits here too: raising GAFFER_BUDGET_USD is what lets work continue.
if [ "${DRY_RUN:-0}" != "1" ] && declare -F gaffer_budget_headroom_ok >/dev/null 2>&1 \
   && ! gaffer_budget_headroom_ok; then
  log "BUDGET: lifetime budget exhausted (GAFFER_BUDGET_USD=\$${GAFFER_BUDGET_USD}, headroom \$${GAFFER_BUDGET_REMAINING:-unknown}) — not starting new paid work this tick; raise GAFFER_BUDGET_USD to continue"
  result no_work; exit 0
fi
# USAGE WINDOW (lib/usage-pause.sh): a model call was refused by the plan's usage
# window or a rate limit, and $GAFFER_DATA/usage-pause.json says when it resets. Until
# then no tick claims or spawns anything — a refused call would only be refused again.
# `no_work` hands the day-cap slot back (nothing was spent); loop.sh, worker.sh and the
# daemon read the same pause and sleep rather than run ticks into this gate.
if [ "${DRY_RUN:-0}" != "1" ] && declare -F gaffer_usage_pause_active >/dev/null 2>&1 \
   && _USAGE_PAUSE_LINE="$(gaffer_usage_pause_active)"; then
  log "USAGE: $_USAGE_PAUSE_LINE — not starting new paid work this tick"
  result no_work; exit 0
fi
}

# Register one principal: `wg agent register` into <id file>, up to three attempts a
# second apart. Two workers of a pool reach their first tick together on a fresh data
# dir and both register at once; the one that loses the database lock used to end the
# whole pool as a setup error (macOS CI, parallel-stop P2). A refusal that persists is
# still fail closed: the tick stops, and the abort names what wg said.
#   _gaffer_register_principal <name> <id file> <what>
_gaffer_register_principal() {
  local name="$1" file="$2" what="$3" attempt=1 err
  err="$(mktemp "${TMPDIR:-/tmp}/gaffer-register.XXXXXX")" || err=/dev/null
  while :; do
    if wg agent register -n "$name" --max-risk high --as system 2>"$err" | jget 'd.agent.id' > "$file" 2>/dev/null \
       && [ -s "$file" ]; then
      [ "$attempt" -gt 1 ] && log "SETUP: registered $what on attempt $attempt"
      [ "$err" != /dev/null ] && rm -f "$err"
      return 0
    fi
    rm -f "$file"
    if [ "$attempt" -ge 3 ]; then
      local said
      said="$(tail -c 300 "$err" 2>/dev/null | tr '\n' ' ')"
      [ "$err" != /dev/null ] && rm -f "$err"
      gaffer_abort_setup SETUP "could not register $what after $attempt attempts${said:+: $said}"
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
}

# The factory agent + reviewer principal (AGENT, REVIEWER_AGENT). Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_register_agents() {
# Ensure a stable factory agent (register once).
if [ ! -s "$_GAFFER_AGENT_ID_FILE" ]; then
  wg init >/dev/null 2>&1 || true
  _gaffer_register_principal "$_GAFFER_AGENT_NAME" "$_GAFFER_AGENT_ID_FILE" "the factory agent"
fi
AGENT="$(cat "$_GAFFER_AGENT_ID_FILE")"
# The REVIEWER principal (a distinct registered agent) — the review pass approves and
# rejects as this id, never as the delivering agent and never as a bare string.
if [ ! -s "$_GAFFER_REVIEWER_ID_FILE" ]; then
  _gaffer_register_principal "${_GAFFER_AGENT_NAME}-reviewer" "$_GAFFER_REVIEWER_ID_FILE" "the reviewer principal"
fi
REVIEWER_AGENT="$(cat "$_GAFFER_REVIEWER_ID_FILE")"
export REVIEWER_AGENT

# GRADUATED-AUTONOMY: per-repo `auto` policies only act inside the agent review pass;
# under REVIEW_MODE=human they are inert. Say so once per run (factory.config.sh).
declare -F gaffer_inert_policy_check >/dev/null 2>&1 && gaffer_inert_policy_check >/dev/null
# MERGE_ON_AGENT_REVIEW without AUTO_MERGE merges nothing on its own — warn once per run.
declare -F gaffer_half_merge_config_check >/dev/null 2>&1 && gaffer_half_merge_config_check >/dev/null
}

# Ready-candidate scan + runner-held claim (skipped on a resume). Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_claim_candidate() {
  # PAUSE-ON-CAP: when resuming, NUM/SHOW/REPO_PATH/STACK/TITLE are already set (above)
  # and the ticket is in_progress — skip the ready-candidate scan entirely and go
  # straight to delivery in its existing worktree.
  if [ "$_RESUMING" != "1" ]; then
  # Skip tickets that already failed delivery THIS run so one bad ticket can't
  # starve the queue (otherwise the loop re-claims the same first ready ticket
  # forever). The skip file is the RUN's own (lib/run-state.sh: loop.sh and
  # poll-once.sh give each run a fresh dir), never another run's.
  SKIP_FILE="${GAFFER_RUN_STATE_DIR:-$GAFFER_DATA}/.failed-tickets"; touch "$SKIP_FILE"

  # ── Stabilisation gate 0: per-repo BACKPRESSURE (skip new claims) ───────────
  # Walk ready candidates (least-recently-failed first) and pick the FIRST whose
  # target repo is NOT in backpressure. A repo is in backpressure once its
  # ACTIVE outstanding work (unmerged gaffer/* branches — excluding branches
  # preserved by parked blocked/refining tickets and the candidate's own branch —
  # + in_review tickets + active claims) hits ANY per-repo cap; we then SKIP new
  # claims for it this tick so the loop never piles up more than the cap.
  # Backpressured repos are recorded in a
  # per-run file (the run's own state dir) for the run-summary report. With every ready
  # repo backpressured, the tick yields no_work and the loop prioritises
  # review/merge/cleanup elsewhere instead of claiming more.
  #
  # A-1: under GAFFER_CONCURRENCY>1 this is best-effort, last-writer-wins
  # telemetry (each tick records ITS snapshot of backpressured repos). The append
  # below is taken under .bp.lock so a concurrent worker never tears a half-written
  # line; the per-tick truncate is a single atomic syscall. At concurrency 1 there
  # is one writer so this is byte-identical to before.
  BP_FILE="${GAFFER_RUN_STATE_DIR:-$GAFFER_DATA}/.backpressure-repos"; : > "$BP_FILE"
  NUM=""; SHOW=""; REPO_PATH=""; STACK=""; TITLE=""
  # SCHEDULER: walk CLAIMABLE work (every dependency done), so MAX_CANDIDATES bounds the
  # tickets a claim can take. Walking the raw ready list let 25 higher-priority dependants
  # of one low-priority prerequisite fill the limit every tick (each claim refused on the
  # unmet dependency) and the prerequisite never ran. A failed claimable listing falls
  # back to the full ready list (the previous walk), never to an empty queue.
  if _CLAIMABLE_JSON="$(wg ticket list -s ready --claimable 2>/dev/null)" \
     && [ -n "$(printf '%s' "$_CLAIMABLE_JSON" | jget 'Array.isArray(d) ? "1" : ""' 2>/dev/null)" ]; then
    CANDIDATES="$(echo "$_CLAIMABLE_JSON" | gaffer_json pick-unskipped "$SKIP_FILE" --all)"
  else
    log "candidate scan: the claimable listing failed — walking the full ready list"
    CANDIDATES="$(echo "$READY_JSON" | gaffer_json pick-unskipped "$SKIP_FILE" --all)"
  fi
  # DRY RUN: a ticket this run already previewed is not previewed again (loop.sh keeps
  # the list), so a preview pass shows each ready ticket once and then ends.
  if [ "${DRY_RUN:-0}" = "1" ] && [ -n "${GAFFER_DRY_PREVIEWED_FILE:-}" ] && [ -s "$GAFFER_DRY_PREVIEWED_FILE" ]; then
    CANDIDATES="$(printf '%s\n' "$CANDIDATES" | grep -vxF -f "$GAFFER_DRY_PREVIEWED_FILE" || true)"
  fi
  # A-1: bound the candidate scan. Each candidate costs a `ticket show` + pressure
  # probe; with a per-repo cap (MAX_CONCURRENT_TICKETS_PER_REPO) in force, a tick
  # may legitimately skip several capped repos before finding a free one, so the
  # walk must be allowed to continue PAST a skip — but never past MAX_CANDIDATES.
  _cand_seen=0
  while IFS= read -r _cand; do
    [ -n "$_cand" ] || continue
    _cand_seen=$((_cand_seen + 1))
    if [ "${MAX_CANDIDATES:-0}" -gt 0 ] 2>/dev/null && [ "$_cand_seen" -gt "$MAX_CANDIDATES" ]; then
      log "candidate scan hit MAX_CANDIDATES=$MAX_CANDIDATES without a claimable ticket — yielding"
      break
    fi
    _cshow="$(wg ticket show "$_cand" 2>/dev/null)"
    _crepo="$(echo "$_cshow" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).local_path) || ""' 2>/dev/null)"
    _cdef="$(echo "$_cshow" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).default_branch) || "main"' 2>/dev/null)"
    _cname="$(echo "$_cshow" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).name) || ""' 2>/dev/null)"
    if [ -n "$_crepo" ] && git -C "$_crepo" rev-parse --git-dir >/dev/null 2>&1; then
      # Sweep genuinely-abandoned branches (POSITIVELY cancelled tickets with no
      # delivery record) first so they don't count against the cap. Parked
      # (blocked/refining) tickets' branches are PRESERVED by the sweep and are
      # instead excluded from the pressure count itself, and the candidate's own
      # preserved branch is bypassed (it gets reused, not added) — so parked work
      # never starves the repo. Then measure pressure.
      gaffer_sweep_abandoned_branches "$_crepo" "${_cdef:-main}" >/dev/null 2>&1 || true
      read -r _pb _pr _pc <<< "$(gaffer_repo_pressure "$_crepo" "${_cdef:-main}" "$_cname" "$_cand")"
      if gaffer_repo_in_backpressure "${_pb:-0}" "${_pr:-0}" "${_pc:-0}"; then
        _gaffer_locked .bp.lock _gaffer_bp_record "$BP_FILE" "${_cname:-$_crepo}" "$_pb/$_pr/$_pc" "$GAFFER_BACKPRESSURE_REASON"
        log "BACKPRESSURE: skipping ready #$_cand — repo '${_cname:-$_crepo}' at/over cap ($GAFFER_BACKPRESSURE_REASON)"
        continue
      fi
    fi
    # ── RUNNER-OWNED-BOOKKEEPING: claim the chosen candidate NOW ───────────────
    # Selection AND claim are one atomic step: the runner claims the ticket here,
    # BEFORE any worktree or agent, so the claim itself is the concurrency lock that
    # prevents two ticks from working the same ticket (Dispatch enforces one active
    # claim per ticket transactionally). If the claim fails (lost race / ineligible),
    # do NOT deliver — skip this candidate and keep scanning. DRY_RUN never claims
    # (it must stay side-effect-free). The captured token authorises the runner's
    # later submit and is injected into the agent's MCP env for its evidence writes.
    if [ "$DRY_RUN" != "1" ]; then
      _CLAIM_JSON="$(wg claim-ticket "$_cand" --agent "$AGENT" --ttl "$GAFFER_CLAIM_TTL" 2>/dev/null || true)"
      _CLAIM_TOK="$(printf '%s' "$_CLAIM_JSON" | jget 'd.claimToken ?? ""' 2>/dev/null || echo '')"
      if [ -z "$_CLAIM_TOK" ]; then
        log "candidate #$_cand — claim FAILED (lost race / ineligible); skipping and continuing the scan"
        continue
      fi
      CLAIM_TOKEN="$_CLAIM_TOK"
      log "claimed #$_cand for delivery (runner holds the claim; ttl=${GAFFER_CLAIM_TTL}s)"
      # CONTRACT FREEZE: a ready ticket's contract is editable until this claim, so a
      # person may have changed it since the scan read it. Re-read it now that it is
      # frozen, so the prompt carries the contract the review and the tester hold it to.
      _cshow_frozen="$(wg ticket show "$_cand" 2>/dev/null || true)"
      [ -n "$_cshow_frozen" ] && _cshow="$_cshow_frozen"
      # CLEANUP OWNERSHIP: remember WHICH claim is this run's (lib/cleanup-ownership.sh).
      declare -F gaffer_note_own_claim >/dev/null 2>&1 && gaffer_note_own_claim "$_cand"
    fi
    NUM="$_cand"; SHOW="$_cshow"; REPO_PATH="$_crepo"
    STACK="$(echo "$_cshow" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).stack) || ""' 2>/dev/null)"
    TITLE="$(echo "$_cshow" | jget 'd.ticket.title' 2>/dev/null)"
    break
  done <<< "$CANDIDATES"
  if [ -z "$NUM" ]; then
    if [ -s "$BP_FILE" ]; then
      log "all deliverable ready tickets are in repos under BACKPRESSURE — skipping new claims; prioritising review/merge/cleanup"
    elif [ -n "${_CLAIMABLE_JSON:-}" ] && [ "$(printf '%s' "$_CLAIMABLE_JSON" | jget 'Array.isArray(d) ? d.length : -1' 2>/dev/null)" = "0" ]; then
      log "every ready ticket waits on an unfinished dependency or an open blocking decision — nothing claimable this tick"
    elif [ "${DRY_RUN:-0}" = "1" ] && [ -n "${GAFFER_DRY_PREVIEWED_FILE:-}" ] && [ -s "$GAFFER_DRY_PREVIEWED_FILE" ]; then
      log "DRY_RUN: every deliverable ready ticket has been previewed this run"
    else
      log "all ready tickets failed delivery this run — nothing deliverable"
    fi
    # BUGFIX (reviewer deadlock): ready tickets exist but none are deliverable
    # (e.g. all blocked by an unmet dependency whose blocker is itself in_review).
    # Run the agent-review pass here so the blocker can be approved/merged and the
    # chain unblocks; if it resolves a ticket it does `result reviewed; exit 0`,
    # otherwise control returns and the no_work exit below proceeds. No-op in
    # REVIEW_MODE=human (the guarded call is skipped), so supervised is unchanged.
    if [ "$REVIEW_MODE" = "agent" ] || [ "$REVIEW_MODE" = "both" ]; then
      _gaffer_agent_review_pass
    fi
    # The SAME deadlock one lane further: the blocker may be in_testing (approved,
    # waiting for the independent tester). Without this the tester ran only in the
    # end-of-tick flow, which this branch never reaches, so a queue whose every ready
    # ticket depends on an in_testing one stalled until the loop gave up on empty
    # polls (seen live). Exits the tick when it tests one; otherwise falls through.
    declare -F _gaffer_tester_pass >/dev/null 2>&1 && _gaffer_tester_pass
    result no_work; exit 0
  fi
  fi   # end: ready-candidate scan (skipped when _RESUMING=1)
}

# IS_BOOTSTRAP / IS_ACCEPTANCE. Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_classify_ticket() {
  # ── Greenfield "create-a-repo" delivery mode (bootstrap tickets) ────────────
  # A bootstrap ticket (dispatch ticket.bootstrap == 1) has NO repo to branch.
  # Instead of the worktree flow below, the runner CREATES the repo: derive the
  # target path under GAFFER_BOOTSTRAP_ROOT, refuse a non-empty existing dir,
  # mkdir + git init, run the delivery agent IN the new dir (with the scoped
  # bootstrap install allowance), apply the SAME hygiene gate, record the
  # smallest-change note, then register + onboard the new repo so the now-done
  # bootstrap unblocks its dependent feature tickets. The oversized minimalism
  # HARD-fail is EXEMPTED for bootstrap (a fresh scaffold is legitimately larger)
  # — the note is still required and recorded, oversized is flagged not failed.
  IS_BOOTSTRAP="$(echo "$SHOW" | jget '[1, true].includes(d.ticket.bootstrap) ? 1 : 0' 2>/dev/null || echo 0)"
  # ACCEPTANCE GATE: the epic's build-level acceptance ticket (lib/acceptance.sh) — a
  # normal delivery on the integrated default branch, with an acceptance prompt block.
  IS_ACCEPTANCE="$(echo "$SHOW" | jget '[1, true].includes(d.ticket.acceptance) ? 1 : 0' 2>/dev/null || echo 0)"
  # A resume always re-enters the worktree delivery flow (pause-on-cap only fires in
  # the normal delivery path, never bootstrap), so never route a resume through the
  # create-a-repo bootstrap branch.
  [ "$_RESUMING" = "1" ] && IS_BOOTSTRAP=0
  # WASTE CONTROL — a bootstrap REWORK is a normal delivery. Once the scaffold has
  # been reviewed the repo IS registered (the bootstrap path onboarded it and linked
  # the ticket), so a CHANGES verdict must re-enter the worktree flow: the existing
  # gaffer/ticket-N-… branch is reused with its commits, the prompt carries the
  # reviewer's feedback, and the gates run against the registered repo. The
  # create-a-repo path has no feedback block at all — a live run sent the agent back
  # into it blind, paying for a second scaffold pass that could not know what the
  # reviewer had asked for.
  if [ "$IS_BOOTSTRAP" = "1" ] && [ -n "${REPO_PATH:-}" ] && git -C "$REPO_PATH" rev-parse --git-dir >/dev/null 2>&1; then
    log "BOOTSTRAP #$NUM: repo already registered at $REPO_PATH — rework runs as a normal delivery on the existing branch (reviewer feedback carried)"
    IS_BOOTSTRAP=0
  fi
}

# Write/read partition, skills + lenses, no-local-path park. Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_resolve_scope() {
  # ── Repo-access boundary (FG-007/FG-008): resolve the ticket's WRITE / READ
  # repo partition from the WG-002 access boundary. `wg ticket show` joins each
  # ticket↔repo link to its repo row, so a single payload carries BOTH the
  # access boundary (access + relation) AND the local_path/default_branch/name
  # we need to branch and to feed the runtime safety hook. We mirror Dispatch's
  # workPacketRepos partition here (no extra CLI round-trip):
  #   WRITE  = active relation (confirmed|implicit_single_repo) AND access=='write'
  #   READ   = everything else that is still in-scope context: access read|test,
  #            or relation context_only — i.e. NOT denied (access none) and NOT a
  #            mere suggestion/rejection (those never become roots).
  # Each list is emitted as one absolute local_path per line (the exact format
  # the hook's GAFFER_WRITE_ROOTS/GAFFER_READ_ROOTS parser expects), skipping links
  # with no local_path on disk. The matching default_branch/name/path tuples are
  # emitted as TAB-separated rows for the per-write-repo branch + delivery loop.
  WG_PARTITION="$(echo "$SHOW" | gaffer_json partition 2>/dev/null || true)"
  # Slice the three sections back out (newline-delimited within each marker pair).
  WRITE_ROOTS="$(printf '%s\n' "$WG_PARTITION" | sed -n '/^@@WRITE_PATHS@@$/,/^@@READ_PATHS@@$/p' | sed '1d;$d')"
  READ_ROOTS="$(printf '%s\n' "$WG_PARTITION" | sed -n '/^@@READ_PATHS@@$/,/^@@WRITE_ROWS@@$/p' | sed '1d;$d')"
  WRITE_ROWS="$(printf '%s\n' "$WG_PARTITION" | sed -n '/^@@WRITE_ROWS@@$/,$p' | sed '1d')"

  # R-9: detect a partition PARSE FAILURE (markers absent) vs a legitimately
  # empty partition (markers present, just no write paths — an older ticket or a
  # ticket with only read-only repos). When the partition script crashes
  # or produces no output (the `|| true` swallows the exit code), WG_PARTITION has
  # no section markers, so all three variables above are empty. Distinguish:
  #   • markers PRESENT   → parse succeeded; WRITE_ROOTS empty = legitimate fallback.
  #   • markers ABSENT    → json parse failure; warn so a multi-repo ticket's
  #                         incomplete delivery is visible (not silent single-repo).
  _WG_MARKERS=1
  if ! grep -qF '@@WRITE_PATHS@@' <<<"$WG_PARTITION"; then   # here-string: a pipe can SIGPIPE-miss under pipefail
    _WG_MARKERS=0
    # Parse failure (markers absent = json parse crash). If the ticket actually links
    # MORE THAN ONE repo, the single-repo fallback would silently deliver incomplete work
    # AND hand the safety hook an under-scoped write boundary — so fail CLOSED (park →
    # ready for re-derivation) rather than guess. A single-repo / repo-less ticket's
    # fallback IS correct, so it proceeds unchanged.
    _SHOW_REPO_COUNT="$(echo "$SHOW" | jget '(d.repositories || []).length' 2>/dev/null || echo 0)"
    if [ "${_SHOW_REPO_COUNT:-0}" -gt 1 ]; then
      log "WG-002: access-boundary partition FAILED to parse for MULTI-REPO #$NUM ($_SHOW_REPO_COUNT repos) — refusing to deliver with an under-scoped single-repo boundary; parking → ready"
      gaffer_release_delivery ready "multi-repo access-boundary partition parse failed — needs re-derivation"
      gaffer_skip_ticket "$NUM"
      result error; exit 0
    fi
    log "WG-002 WARNING: access-boundary partition parse yielded no markers for #$NUM (json parse failure or empty ticket show). Falling back to single-repo write root ($REPO_PATH)."
  fi

  # A parsed boundary (markers present) with NO write repo is a ticket with no repo
  # linked at all (the default solo_loose pack lets one go ready with only a
  # REPO_RECOMMENDED warning) or whose repos are all read / test / context-only. It
  # must NOT fall through to the legacy single-repo fallback below — that made the
  # alphabetically-first linked repo WRITABLE (worktree + branch + hook allowing
  # writes) for a ticket the operator had marked read-only. Park it VISIBLY as
  # `blocked` (reason_code no_write_repo — it lands in the human queue) and skip it
  # this run. Releasing it to `ready` instead re-claimed and re-released it on every
  # loop run forever (the skip file is per run), a claim/release pair per run.
  # A write link whose repo has NO local_path (registered with `wg repo add --remote`
  # and no --path) is dropped by `partition` too, so it also arrives here with empty
  # WRITE_ROOTS. That ticket DOES have a write repo — telling the human to "set its
  # access to write" is false and an unblock just re-parks it — so it is parked as
  # no_local_repo_path with the register-or-clone instruction instead.
  # `ready` now refuses a ticket with no confirmed write repo up front (policy
  # WRITE_REPO_REQUIRED / SCOPE_REPO_UNCONFIRMED), so this mostly catches access
  # that changed after the ticket was readied.
  if [ "$_WG_MARKERS" = 1 ] && [ -z "$(printf '%s' "$WRITE_ROOTS" | tr -d '[:space:]')" ]; then
    _NWR_NOPATH="$(echo "$SHOW" | jget '(d.repositories || []).filter((r) => r && ["confirmed", "implicit_single_repo"].includes(r.relation) && r.access === "write" && !String(r.local_path || "").trim()).length' 2>/dev/null || echo 0)"
    if [ "${_NWR_NOPATH:-0}" -gt 0 ] 2>/dev/null; then
      log "ticket #$NUM has no local repo path ($_NWR_NOPATH write repo(s) linked with no local checkout); parking → blocked (no_local_repo_path) for a human"
      gaffer_release_delivery blocked "the write repo has no local checkout on this machine — clone it to its registered path, or register its path by onboarding a checkout ('gaffer onboard <dir>') and giving the ticket write access to that repo ('gaffer wg ticket repo-access set $NUM <repo>'), then unblock it ('gaffer wg unblock $NUM')" no_local_repo_path
      gaffer_skip_ticket "$NUM"
      result no_work; exit 0
    fi
    _NWR_COUNT="$(echo "$SHOW" | jget '(d.repositories || []).length' 2>/dev/null || echo 0)"
    if [ "${_NWR_COUNT:-0}" -gt 0 ]; then
      _NWR_WHY="all $_NWR_COUNT linked repo(s) are read/test/context-only"
    else
      _NWR_WHY="no repo is linked to the ticket"
    fi
    log "WG-002: #$NUM has no WRITE repo ($_NWR_WHY) — refusing to deliver; parking → blocked (no_write_repo) for a human"
    gaffer_release_delivery blocked "no write repo on the ticket ($_NWR_WHY) — link a repo and set its access to write (wg ticket repo-access set <n> <repo> --access write --relation confirmed), then unblock it ('gaffer wg unblock $NUM')" no_write_repo
    gaffer_skip_ticket "$NUM"
    result no_work; exit 0
  fi

  # Back-compat (older tickets with no WG-002 access boundary, i.e. no markers):
  # fall back to the single delivery repo as the sole write repo. This reproduces
  # EXACTLY today's single-repo behaviour — one write root, one gaffer/ branch, no
  # read roots.
  if [ -z "$(printf '%s' "$WRITE_ROOTS" | tr -d '[:space:]')" ]; then
    WRITE_ROOTS="$REPO_PATH"
    READ_ROOTS=""
    DEFAULT_BRANCH_FALLBACK="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).default_branch) || "main"' 2>/dev/null || echo main)"
    REPO_NAME_FALLBACK="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).name) || ""' 2>/dev/null || echo '')"
    REPO_ID_FALLBACK="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).id) || ""' 2>/dev/null || echo '')"
    WRITE_ROWS="$(printf '%s\t%s\t%s\t%s' "$REPO_ID_FALLBACK" "$REPO_NAME_FALLBACK" "$REPO_PATH" "$DEFAULT_BRANCH_FALLBACK")"
    MULTI_REPO=0
  else
    # Count write repos to label the plan (mono-fallback = 1, mapped multi = >1).
    WRITE_REPO_COUNT="$(printf '%s\n' "$WRITE_ROOTS" | grep -c . || true)"
    [ "${WRITE_REPO_COUNT:-0}" -gt 1 ] && MULTI_REPO=1 || MULTI_REPO=0
  fi

  # Recommended skills for this ticket's stack (best-effort; never fatal).
  # Select from the factory's stack/area-tagged SKILL.md library (the one actually
  # mounted into the repo). If the selector prints nothing, fall back to the universal
  # delivery mechanics (GAFFER_UNIVERSAL_SKILLS, skills-mount.sh) — the same set the
  # mount always unions in. The crew registry (`fg skills`) used to be the fallback; it
  # lists role-only skills (create-branch, submit-review…) and names the library does
  # not carry, which the prompt then recommended and the mount silently dropped.
  # Derive an area from the stack where unambiguous so area-gated packs (FIX-2)
  # still fire for a clearly-domained stack (e.g. a web stack → frontend pack).
  # MULTI-REPO STACKS: the skills are selected for the UNION of every write repo's
  # registered stack, not the first write repo's alone — a ticket spanning a TypeScript
  # frontend and a Java service, with no filename or language hint, got frontend skills
  # and no Java pack. Per-path routing below still narrows to the ecosystems a named
  # path touches (every touched path's stack survives the narrowing).
  SKILL_STACKS="$(printf '%s' "$SHOW" | node "$HERE/bin/select-skills.mjs" --ticket-stacks - 2>/dev/null || true)"
  [ -n "$SKILL_STACKS" ] || SKILL_STACKS="$STACK"
  SKILL_AREA="$(gaffer_area_for_stack "$SKILL_STACKS")"
  # TEXT RELEVANCE: hand the selector the ticket's title + description head so an
  # off-domain pack the ticket plainly calls for (a Terraform module, an SEO audit, a
  # runbook) is mounted too — those packs were otherwise unreachable from any runner
  # path. An argv, never a shell string: the untrusted text cannot inject flags.
  _SKILL_TEXT="$(printf '%s\n%s' "${TITLE:-}" "$(echo "$SHOW" | jget '(d.ticket.description || "").slice(0, 600)' 2>/dev/null || true)")"
  # PER-PATH ROUTING: file paths the ticket NAMES narrow the stack to their ecosystems on a
  # mixed repo ("… in api/Shop.Api/Controllers/TasksController.cs" → the C# pack, not the
  # React bar). No path named → the repo's full stack. The full description is scanned
  # (paths are often below the 600-char head the text relevance uses).
  _SKILL_PATHS="$(mktemp "${TMPDIR:-/tmp}/skill-paths.XXXXXX")"
  printf '%s\n%s' "${TITLE:-}" "$(echo "$SHOW" | jget '(d.ticket.description || "")' 2>/dev/null || true)" \
    | grep -oE '[A-Za-z0-9_][A-Za-z0-9_./-]*\.(cs|csproj|sln|razor|cshtml|ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|kts|swift|rb|sh|bash|html|css|scss)\b' \
    > "$_SKILL_PATHS" 2>/dev/null || : > "$_SKILL_PATHS"
  SKILLS="$(node "$HERE/bin/select-skills.mjs" --stack "$SKILL_STACKS" ${SKILL_AREA:+--area "$SKILL_AREA"} --text "$_SKILL_TEXT" --paths-file "$_SKILL_PATHS" --skills-dir "$SKILLS_DIR" 2>/dev/null || true)"
  # Name each write repo's conventions pack in the prompt when the stacks differ.
  SKILLS_PACK_NOTE="$(printf '%s' "$SHOW" | node "$HERE/bin/select-skills.mjs" --ticket-pack-note - --selected "$SKILLS" --skills-dir "$SKILLS_DIR" 2>/dev/null || true)"
  rm -f "$_SKILL_PATHS"
  [ -n "$SKILLS" ] || SKILLS="$(printf '%s' "${GAFFER_UNIVERSAL_SKILLS:-}" | tr -s ' ' '\n' | grep . | paste -sd, - | sed 's/,/, /g')"
  [ -n "$SKILLS" ] || SKILLS="(choose the skill whose description matches the ticket)"

  # Always-on QUALITY LENSES (frontmatter `area: quality`) — applied to EVERY delivery,
  # not just stack-matched. e.g. `minimalism`. These are injected into the prompt as
  # MANDATORY so a cross-cutting skill is never merely "recommended" among 25 others.
  LENSES="$(for _f in "$SKILLS_DIR"/*/SKILL.md; do grep -qiE '^area:[[:space:]]*quality' "$_f" 2>/dev/null && basename "$(dirname "$_f")"; done | paste -sd, - 2>/dev/null)"
  [ -n "$LENSES" ] || LENSES="minimalism"

  if [ -z "$REPO_PATH" ] || [ ! -d "$REPO_PATH" ]; then
    log "ticket #$NUM has no local repo path; parking → blocked (no_local_repo_path) for a human"
    # Park VISIBLY as `blocked`, never back to `ready`: the skip file only lasts one
    # loop run, so a `ready` release was re-claimed and re-released on every run
    # forever. Skip it for the rest of this run too.
    gaffer_release_delivery blocked "the write repo has no local checkout on this machine — clone it to its registered path, or register its path by onboarding a checkout ('gaffer onboard <dir>') and giving the ticket write access to that repo ('gaffer wg ticket repo-access set $NUM <repo>'), then unblock it ('gaffer wg unblock $NUM')" no_local_repo_path
    gaffer_skip_ticket "$NUM"
    result no_work; exit 0
  fi
}

# Primary repo, branch name, self-operation ban, WT_ROWS. Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_plan_worktrees() {
  # The agent's working directory (cwd) is the PRIMARY write repo: relative-path
  # edits then land inside a write-root. In single-repo / mono-fallback mode this
  # is exactly REPO_PATH (today's behaviour). In mapped multi-repo mode the first
  # repo in the ticket may be read-only context, so prefer the first WRITE root.
  PRIMARY_REPO="$(printf '%s\n' "$WRITE_ROOTS" | grep . | head -1)"
  [ -n "$PRIMARY_REPO" ] || PRIMARY_REPO="$REPO_PATH"

  # Slug the title once (shared by every write repo's branch name). gaffer_ticket_slug
  # is the SAME derivation the greenfield bootstrap uses, so both mint the identical
  # branch shape the reviewer resolves against.
  SLUG="$(gaffer_ticket_slug "$TITLE")"
  WORK_BRANCH="gaffer/ticket-$NUM-$SLUG"

  # ── SELF-OPERATION BAN (refuse to deliver to Gaffer's own source) ────────────
  # If the delivery target IS, or is INSIDE, one of the factory's own component
  # dirs (dispatch / crew / memory / the runner) or the gaffer checkout itself,
  # refuse: the factory would be editing its own source. Checked here — after
  # REPO_PATH and every write root are resolved, before any worktree is created — so nothing is
  # mutated. GAFFER_ALLOW_SELF_DELIVERY=1 fully restores today's behaviour (for
  # first-party dogfooding). The ticket is BLOCKED (set aside for a human, exactly
  # like the bootstrap "no commit" / hygiene parks) AND recorded in the per-run
  # skip file, so the loop does NOT re-claim the same self-target ticket forever.
  if [ "${GAFFER_ALLOW_SELF_DELIVERY:-0}" != "1" ]; then
    # EVERY write target is checked, not just the first: a multi-repo ticket whose
    # gaffer checkout (or a component dir) is the 2nd+ write repo would otherwise
    # be delivered into. Candidates, in order: each WRITE_ROOTS line, each
    # WRITE_ROWS path column (the rows worktrees are actually added from), then
    # REPO_PATH. First match wins; any match refuses the whole ticket (fail closed).
    SELF_HIT=""
    __self_cands="$(printf '%s\n' "$WRITE_ROOTS"; printf '%s\n' "$WRITE_ROWS" | awk -F'\t' 'NF>=3{print $3}'; printf '%s\n' "$REPO_PATH")"
    while IFS= read -r __self_c; do
      [ -n "$__self_c" ] || continue
      if gaffer_is_self_target "$__self_c"; then SELF_HIT="$__self_c"; break; fi
    done <<< "$__self_cands"
    if [ -n "$SELF_HIT" ]; then
      log "SELF-OP: refusing to deliver #$NUM — target '$SELF_HIT' is (or is inside) a Gaffer component; the factory must not edit its own source. Set GAFFER_ALLOW_SELF_DELIVERY=1 to override (first-party dogfooding only)."
      wg attach-evidence "$NUM" --type manual_note \
        --summary "SELF-OP BAN: refused delivery — target '$SELF_HIT' is a Gaffer component (factory's own source). Override with GAFFER_ALLOW_SELF_DELIVERY=1." >/dev/null 2>&1 || true
      # Set aside for a human. RUNNER-OWNED-BOOKKEEPING: the runner holds the claim
      # now, so release it first (claimed → ready), THEN un-ready it (ready -> draft)
      # so the candidate loop never re-selects it — the "set aside, don't re-claim
      # forever" mechanism the board already provides. SKIP_FILE is belt-and-braces
      # within the current run (loop.sh clears it per run).
      gaffer_release_delivery ready "self-op: target is a Gaffer component"
      wg ticket move "$NUM" draft --as system >/dev/null 2>&1 || true
      gaffer_skip_ticket "$NUM"
      log "SELF-OP: set aside #$NUM for a human (released claim + un-readied ready→draft + skipped this run; not delivered, not re-claimed)"
      result no_work; exit 0
    fi
  fi

  # ── Worktree isolation (delivery happens in throwaway worktrees) ────────────
  # Delivery never touches a real repo's working tree. For each WRITE repo we add
  # a git worktree under $WORKTREES_BASE checked out on the ticket branch. The
  # worktree shares the real repo's object DB, so commits land on the gaffer/
  # branch IN the real repo, while the real repo's main working tree + current
  # branch stay exactly where the human left them. We remember, per write repo,
  # the mapping realRepo→worktreePath so the post-run lifecycle (assert, record,
  # remove, rollback) can act on the right paths.
  #
  # WT_ROWS mirrors WRITE_ROWS but appends a 5th TAB column: the worktree path.
  # Worktree path is derived deterministically from the repo id (fallback name,
  # fallback a positional index) so a re-run targets the same dir (idempotent).
  WORKTREES_BASE="$GAFFER_DATA/worktrees/ticket-$NUM"
  WT_ROWS=""
  __wt_idx=0
  while IFS=$'\t' read -r rid rname rpath rbase; do
    [ -n "$rpath" ] || continue
    rbase="${rbase:-main}"
    # Stable, filesystem-safe leaf for this repo's worktree.
    # Typed leaf derivation (packages/crew worktreeKeyCli.js → worktreeKey; pinned by
    # worktree-key-golden). A missing crew dist yields an empty key → the repo<index>
    # backstop below, so a worktree is always created at a stable path.
    __wt_key="$(node "${CREW_DIR:-}/dist/runtime/worktree/worktreeKeyCli.js" --id "$rid" --name "$rname" --index "$__wt_idx" 2>/dev/null)"
    [ -n "$__wt_key" ] || __wt_key="repo$__wt_idx"
    __wt_path="$WORKTREES_BASE/$__wt_key"
    WT_ROWS+="$(printf '%s\t%s\t%s\t%s\t%s' "$rid" "$rname" "$rpath" "$rbase" "$__wt_path")"$'\n'
    __wt_idx=$((__wt_idx + 1))
  done <<< "$WRITE_ROWS"
  WT_ROWS="${WT_ROWS%$'\n'}"

  # The agent writes in the WORKTREES, not the real repos. Recompute the write
  # roots (one worktree path per line) and the primary cwd accordingly. Read
  # roots stay the real read repos (read-only access is safe against the real
  # checkout). In single-repo / mono-fallback mode this is exactly one worktree.
  WRITE_ROOTS="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' '{print $5}')"
  PRIMARY_REPO="$(printf '%s\n' "$WRITE_ROOTS" | grep . | head -1)"
  # External review #9 (finding 2): beyond the static hooks/fsmonitor overrides
  # factory.config.sh exported, neutralise every driver/helper/filter of THESE
  # repositories that points into the checkout before any bookkeeping git runs in them.
  if declare -F gaffer_git_harden >/dev/null 2>&1; then
    _gh_repos=()
    while IFS=$'\t' read -r _ _ _gh_p _ _; do [ -n "$_gh_p" ] && [ -d "$_gh_p" ] && _gh_repos+=( "$_gh_p" ); done <<< "$WT_ROWS"
    gaffer_git_harden ${_gh_repos[@]+"${_gh_repos[@]}"}
    unset _gh_repos _gh_p
  fi
  [ -n "$PRIMARY_REPO" ] || PRIMARY_REPO="$WORKTREES_BASE/primary"
}
