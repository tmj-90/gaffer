#!/usr/bin/env bash
# runner/lib/tick-close.sh
# The close path of a delivery whose gates passed: the runner-owned submit, the
# delivery records, the landing hand-off, the replay manifest, memory recall feedback
# and the ticket-intent distillation, the PR / CI gate and the tester-first route.
#
# Sourced by runner/tick.sh only (required there: a missing file fails the tick
# closed). Function definitions only, so sourcing it runs nothing. Every body was
# moved verbatim out of tick.sh; the functions read and write tick.sh's globals
# (NUM, SHOW, WT_ROWS, CLAIM_TOKEN, ...) exactly as the inline code did, and the
# gaffer_tick_* / _gaffer_idle_* wrappers declare no locals, so every assignment in
# them stays global. See runner/CLAUDE.md for the map of the tick phases.

# MEMORY FEEDBACK LOOP (RUNNER-OWNED-BOOKKEEPING): close the loop between WHAT
# knowledge memory served into this ticket's context and HOW the ticket turned
# out. The runner knows the outcome; it PASSES it to memory, which adjusts its
# OWN items using its OWN read-event log (memory never reads the dispatch DB).
# $1 = clean | reworked | blocked. Best-effort + logged: a feedback error NEVER
# affects delivery. No-op under DRY_RUN, without the memory CLI, or when this
# delivery logged no recall (RECALL_REPO_NAME unset ⇒ nothing to adjust).
gaffer_recall_feedback() {
  local _fb_outcome="$1"
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  [ -n "${RECALL_REPO_NAME:-}" ] && [ -n "${NUM:-}" ] || return 0
  # `lg` (factory.config.sh) runs the memory CLI with MEMORY_DB in the child env.
  declare -f lg >/dev/null 2>&1 || return 0
  if lg recall-feedback --repo "$RECALL_REPO_NAME" --ticket "$NUM" --outcome "$_fb_outcome" >/dev/null 2>&1; then
    log "memory: recall-feedback #$NUM → $_fb_outcome (served knowledge adjusted)"
  else
    log "memory: recall-feedback #$NUM ($_fb_outcome) failed — non-fatal, delivery unaffected"
  fi
}

# TICKET → LORE DISTILLATION AT CLOSE (Track 1c, live-path backport).
# A ticket's title + acceptance criteria carry the REAL product intent — WHY the
# work exists. At close that intent evaporates: the ticket is marked done and
# nothing durable captures it. This harvests it into a REQUIREMENT lore record
# so the "why" survives the ticket: a human-gated DRAFT by default, promoted ACTIVE
# only under MEMORY_AUTO_APPROVE=1 / GAFFER_MEMORY_AUTO_PROMOTE=1 (below). The text
# is rendered by crew — packages/crew/src/context/ticketIntent.ts::distillTicketIntent
# via runtime/context/distillIntentCli.js, the single source (edit it there). A
# ticket with NO non-blank acceptance criteria has nothing durable to harvest, so
# it is a no-op rather than drafting noise. (The optional DECISION draft the
# distiller can emit needs recorded decisions/reject-reasons, which the live close
# path does not carry, so the CLI emits only the requirement.)
# Best-effort + logged: a distill error NEVER affects delivery (already
# submitted). No-op under DRY_RUN, without the memory CLI or the crew build, or
# with no ticket/repo in scope.
gaffer_distill_ticket_intent() {
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  [ -n "${NUM:-}" ] && [ -n "${RECALL_REPO_NAME:-}" ] || return 0
  declare -f lg >/dev/null 2>&1 || return 0
  [ -n "${SHOW:-}" ] || return 0

  # Build the requirement draft's {title, summary} from the ticket's title + AC.
  # The crew CLI emits ONE JSON line (or nothing when there is no AC). Fail-soft.
  local _distill _distill_cli="${CREW_DIR:-}/dist/runtime/context/distillIntentCli.js"
  if [ ! -f "$_distill_cli" ]; then
    log "memory: crew not built ($_distill_cli missing) — skipping the ticket-intent distillation for #$NUM"
    return 0
  fi
  _distill="$(SHOW="$SHOW" DTITLE="${TITLE:-}" DREPO="$RECALL_REPO_NAME" DNUM="$NUM" node "$_distill_cli" 2>/dev/null || true)"
  [ -n "$_distill" ] || return 0

  local _dt _ds
  _dt="$(printf '%s' "$_distill" | jget 'd.title' 2>/dev/null)" || return 0
  _ds="$(printf '%s' "$_distill" | jget 'd.summary' 2>/dev/null)" || return 0
  [ -n "$_dt" ] || return 0

  # ONCE PER TICKET. This runs on every submit, and a ticket that is reworked is
  # submitted again — so every rework cycle used to draft another copy of the same
  # requirement (and a ticket later rejected still left one). The ticket-<n> tag is
  # the provenance key: if memory already holds a record for this ticket (draft or
  # active), there is nothing new to harvest. Fail-soft: an unreadable lookup drafts
  # as before rather than silently skipping.
  local _existing
  # --no-record-reads: a bookkeeping lookup, not an agent retrieval — it must not
  # count as a read in `memory stats` (top-cited / retirement candidates).
  _existing="$(lg search --repo "$RECALL_REPO_NAME" --tag "ticket-$NUM" --include-drafts --no-record-reads --json 2>/dev/null \
    | jget 'Array.isArray(d) ? d.length : 0' 2>/dev/null || echo 0)"
  if [ "${_existing:-0}" != "0" ]; then
    log "memory: requirement for #$NUM already distilled (${_existing} record(s) tagged ticket-$NUM) — not drafting again"
    return 0
  fi

  # --title/--summary/--body all supplied ⇒ `suggest` never drops into an interactive
  # prompt. Suggest (draft) with an explicit kind so recall can later aim at the "why";
  # tags carry ticket provenance (ticket-<n>).
  #
  # AUTO-PROMOTE follows the memory gate. The distilled text is derived from the ticket
  # title + acceptance criteria — agent-influenceable inputs the factory otherwise treats
  # as untrusted — so landing it ACTIVE without review is exactly the cross-ticket memory
  # poisoning the draft gate exists to stop. Default: promote iff the operator has ALREADY
  # accepted agent-authored memory going live (MEMORY_AUTO_APPROVE=1 — on in the
  # autonomous/strict clusters, off in supervised/lite/graduated). Supervised runs land a
  # DRAFT for `memory review`; the PRODUCT CONTEXT primer surfaces only `active` lore, so
  # ratify the drafts you want priming future agents. GAFFER_MEMORY_AUTO_PROMOTE=1|0
  # overrides either way. The inline var applies only to this `lg` call.
  # Normalised through _gaffer_flag_on (1/true/yes/on), matching what Settings accepts, and
  # handed to the memory CLI as the exact "1"/"0" it reads.
  local _promote
  _promote="$(_gaffer_flag_on "${GAFFER_MEMORY_AUTO_PROMOTE:-${MEMORY_AUTO_APPROVE:-0}}" && echo 1 || echo 0)"
  if MEMORY_AUTO_APPROVE="$_promote" \
      lg suggest --title "$_dt" --summary "$_ds" --body "$_ds" \
      --repo "$RECALL_REPO_NAME" --kind requirement \
      --tag ticket-intent --tag requirement --tag "ticket-$NUM" \
      --author gaffer-distill >/dev/null 2>&1; then
    if [ "$_promote" = "1" ]; then
      log "memory: distilled requirement from #$NUM → ACTIVE (auto-promoted: memory auto-approve is on; GAFFER_MEMORY_AUTO_PROMOTE=0 to gate)"
    else
      log "memory: distilled requirement DRAFT from #$NUM (human-gated — \`gaffer lore review\` to ratify; GAFFER_MEMORY_AUTO_PROMOTE=1 to auto-promote)"
    fi
  else
    log "memory: distill #$NUM skipped/failed — non-fatal, delivery unaffected"
  fi
}

# Submit, records, PR / CI gate, tester route; exits worked. Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_close_delivery() {
  # ── RUNNER-OWNED-BOOKKEEPING: submit for review (the runner, not the agent) ──
  # Every gate passed. The runner (which holds the claim) now submits the ticket for
  # review — deterministic + token-free from the agent's perspective. A normal
  # delivery uses the claim-gated `wg submit` (claimed → in_review, completing the
  # claim; a leased resume uses it too); a tokenless resume fallback is moved
  # in_progress → in_review.
  # The delivery-artifact / diff_summary / per-repo records BELOW run as a SYSTEM actor
  # and are status-independent, so submitting first (matching the old agent-submit
  # ordering) keeps the done-gate's PR/diff evidence attached to an in_review ticket.
  #
  # R-6 (data-loss window): SUBMIT itself is the review-visibility point — it moves the
  # ticket claimed → in_review AND resolves the claim (GAFFER_CLAIM_RESOLVED=1). If a
  # signal (the routine outer per-tick timeout SIGTERM, launchd stop, Ctrl-C) lands in
  # the gap between submit and the first delivery record, the crash trap sees
  # KEEP=0 + COMPLETE=0 and runs `drop-branch` — DELETING the review-worthy branch —
  # while CLAIM_RESOLVED=1 suppresses the claim re-release, stranding the ticket
  # in_review with its branch gone and no branch_name recorded yet. Raise retention
  # BEFORE submit: past GUARD B the branch is guaranteed to hold delivered commits, so
  # keeping it is always correct, and the trap now preserves it from the visibility
  # point onward. (Redundantly re-raised on the record path + the submit-fail park.)
  GAFFER_KEEP_DELIVERY_BRANCH=1
  # REQUIRED CI IS RECORDED BEFORE REVIEW (external review #9, finding 4): when CI gates
  # this delivery (GAFFER_REQUIRE_CI with PR creation on), dispatch learns that before the
  # ticket is exposed for review, so an approval in the window before the gate reports
  # (or when it never can: no gh, no GitHub remote) is refused, not waved through.
  declare -F gaffer_ci_require_mark >/dev/null 2>&1 && gaffer_ci_require_mark "$NUM"
  if gaffer_submit_delivery "delivered on branch $WORK_BRANCH; gates passed"; then
    log "submitted #$NUM for review (→ in_review) — runner-owned submit"
    gaffer_manifest_finish submit 0
    # FINDING-3: this delivery attempt SUCCEEDED — reset the cross-run no-commit
    # failure counter so a flaky-then-fixed ticket is never permanently poisoned.
    gaffer_nocommit_clear "$NUM"
    # MEMORY FEEDBACK LOOP: the delivery shipped for review. Reward the served
    # knowledge when it shipped CLEAN (first attempt, no prior review rejection);
    # otherwise it shipped only after rework — a weaker signal, so demote + flag.
    # _DELIV_ATTEMPT counts in-tick attempts (≥2 ⇒ reworked here); ROUTE_ATTEMPT_RAW
    # is the dispatch attempt_count (≥1 ⇒ a PRIOR review rejection sent it back).
    if [ "${_DELIV_ATTEMPT:-1}" -ge 2 ] || [ "${ROUTE_ATTEMPT_RAW:-0}" -ge 1 ]; then
      gaffer_recall_feedback reworked
    else
      gaffer_recall_feedback clean
    fi
    # TICKET → LORE DISTILLATION (Track 1c): harvest the closed ticket's product
    # intent (title + AC) into a human-gated REQUIREMENT DRAFT so the "why"
    # survives the ticket. Additive + fail-soft; the delivery is already submitted.
    gaffer_distill_ticket_intent
    # EVAL JUDGE (quality telemetry, GAFFER_EVAL_JUDGE=1 opt-in): score the
    # just-submitted delivery against its ACs on the crew rubric and append the
    # verdict + real spend to the eval ledger. memoryPresent = whether durable
    # product-context primed this delivery (the memory score gap's arm flag).
    # Additive + fail-soft telemetry — never gates or delays the submitted work.
    # The judge gets the DoD checklist this delivery passed (GAFFER_EVAL_TEST_OUTPUT)
    # and the REPO NAME for the ledger record ($PRIMARY_REPO is the worktree path,
    # whose basename is a per-ticket key, not the repo).
    if type gaffer_eval_judge_delivery >/dev/null 2>&1; then
      GAFFER_EVAL_TEST_OUTPUT="${_DOD_JUDGE_TESTS:-}" \
        gaffer_eval_judge_delivery "$NUM" "$PRIMARY_REPO" "$DEFAULT_BRANCH" "$WORK_BRANCH" \
        "$([ -n "${PRODUCT_CONTEXT_BLOCK:-}" ] && echo 1 || echo 0)" "${_DELIVERY_SPEND_USD:-}" "${_CARD_REPO_NAME:-}" || true
    fi
  else
    # M1 (data-loss path): the submit FAILED. We must NOT fall through to record the
    # delivery artifacts and exit "worked" — that leaves the ticket `claimed` with
    # recorded evidence, and on TTL expiry a second tick reclaims it and runs
    # `git worktree add -B …`, RESETTING the branch and discarding THIS delivery's
    # commits while the recorded evidence points at now-absent commits. Instead, park
    # the runner-held claim to `refining` (which preserves the branch AND blocks the
    # blind reclaim-and-reset), skip the ticket for this run, and fail the tick for a
    # manual review handoff — BEFORE any delivery-artifact recording below. Raise the
    # branch-retention flag FIRST so the exit/crash trap tears down only the throwaway
    # worktree and never the review-worthy branch.
    GAFFER_KEEP_DELIVERY_BRANCH=1
    gaffer_release_delivery refining "runner submit failed — needs manual review handoff"
    # FINDING-3: leaves the delivery pipeline — reset the cross-run no-commit counter.
    gaffer_nocommit_clear "$NUM"
    gaffer_skip_ticket "$NUM"
    log "WARNING — submit FAILED for #$NUM; parked → refining (branch $WORK_BRANCH PRESERVED), NOT recording delivery — needs a human / claim-recovery"
    result error; exit 0
  fi

  # Per-repo delivery recording (FG-008 / WG-005): for EACH write repo, persist a
  # per-repo delivery artifact (branch + diffstat as the evidence note). Single-repo
  # fallback → exactly one repo-delivery row; multi-repo → one per write repo. This
  # is in ADDITION to the top-level diff_summary + delivery-artifact records below
  # (kept for backwards compatibility / the existing done-gate). Recording is
  # best-effort per repo (never fatal): a write repo whose CLI record fails is
  # logged, not failed.
  # The diff is read from the WORKTREE (where the agent's commits live) while it
  # still exists; the recorded branch name is the gaffer/ branch, which persists in
  # the REAL repo after the worktree is removed below.
  #
  # FIX-BRANCH: the moment a delivery record makes the gaffer/ branch
  # review/merge-visible, deleting that branch on a later crash/signal would leave
  # recorded evidence pointing at a missing branch. Raise the branch-retention flag
  # NOW — strictly BEFORE the first record below — so any crash trap from here on
  # tears down the disposable worktree but PRESERVES the branch. A salvageable
  # orphan branch is always preferable to a dangling delivery record. Retention is
  # already raised above (before submit — the true visibility point); re-affirm it
  # here so this record path stays self-evidently safe. We keep
  # GAFFER_DELIVERY_COMPLETE for the later "fully done, skip all cleanup" case.
  GAFFER_KEEP_DELIVERY_BRANCH=1
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rwt" ] || continue
    rbase="${rbase:-main}"
    git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1 || continue
    R_CUR="$(git -C "$rwt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
    [ -n "$R_CUR" ] && [ "$R_CUR" != "$rbase" ] || continue
    # GRADUATED AUTONOMY: record the delivery HEAD sha so the review-approve path can
    # compute an honest `approved_unchanged` (delivery sha vs the branch head at approval).
    # Without it the signal was permanently null and the auto-merge half never fired.
    R_SHA="$(git -C "$rwt" rev-parse HEAD 2>/dev/null || echo '')"
    R_SHA_ARG=""; [ -n "$R_SHA" ] && R_SHA_ARG="--commit $R_SHA"  # sha is a single token → safe to word-split
    # repoRef accepts the repo id OR name; prefer the stable id, fall back to name.
    R_REF="${rid:-$rname}"
    if [ -n "$R_REF" ]; then
      if wg ticket repo-delivery record "$NUM" "$R_REF" --branch "$R_CUR" $R_SHA_ARG --status review_ready --as system >/dev/null 2>&1; then
        log "recorded per-repo delivery for #$NUM: ${rname:-repo} → $R_CUR (branch lives in $rpath)"
      else
        log "per-repo delivery for #$NUM (${rname:-repo}) did not record (non-fatal)"
      fi
    fi
  done <<< "$WT_ROWS"

  # Deterministically record the TOP-LEVEL delivery so closing never depends on the
  # agent remembering, and the existing done-gate keeps working unchanged. Two
  # distinct, complementary records (the done-gate needs BOTH under
  # factory_strict/regulated, and attach-evidence alone covers team_light):
  #   1. attach-evidence diff_summary → creates the evidence row the done-gate's
  #      hasPrOrDiff check looks for (evidence_type IN pull_request/diff_summary).
  #      System-actor evidence — does NOT satisfy ACs (those stay claim-scoped),
  #      only the PR/diff gate.
  #   2. delivery-artifact --branch → persists branch_name onto the ticket so the
  #      reviewer can resolve the delivered branch from Dispatch (not git grep),
  #      and satisfies the factory_strict/regulated BRANCH_REQUIRED gate. --as
  #      system records tokenlessly (the implementer's claim has already finished).
  #      Its --diff lands in the delivery event payload, NOT an evidence row, so it
  #      does NOT by itself satisfy hasPrOrDiff — hence we keep attach-evidence too.
  # Top-level record is keyed to the PRIMARY write repo (single-repo: == REPO_PATH;
  # multi-repo: the first write repo) — a representative summary; per-repo rows
  # above carry the full per-repo detail (WG-005 AC: top-level remains as summary).
  if git -C "$PRIMARY_REPO" rev-parse --git-dir >/dev/null 2>&1; then
    CUR_BRANCH="$(git -C "$PRIMARY_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
    if [ -n "$CUR_BRANCH" ] && [ "$CUR_BRANCH" != "$DEFAULT_BRANCH" ]; then
      DIFFSTAT="$(git -C "$PRIMARY_REPO" diff "$DEFAULT_BRANCH"...HEAD --stat 2>/dev/null | tail -15)"
      [ -n "$DIFFSTAT" ] && wg attach-evidence "$NUM" --type diff_summary \
        --summary "Delivered on branch $CUR_BRANCH"$'\n'"$DIFFSTAT" >/dev/null 2>&1 \
        && log "attached delivery diff_summary for #$NUM" || true
      wg delivery-artifact "$NUM" --branch "$CUR_BRANCH" --diff "$DIFFSTAT" --as system >/dev/null 2>&1 \
        && log "recorded delivery-artifact branch_name=$CUR_BRANCH for #$NUM" \
        || log "delivery-artifact for #$NUM did not record (non-fatal)"
    fi
  fi

  # Success: the delivery is RECORDED and the gaffer/ branch now holds work that
  # must survive for review/merge. Tear down the throwaway worktrees FIRST, THEN mark
  # the delivery complete.
  #
  # R-5: the flag used to be set BEFORE this teardown. A signal arriving in the gap
  # between the flag-set and the teardown call made the crash trap a no-op (it sees
  # COMPLETE=1 and returns early) while the worktrees were still on disk — LEAKING
  # them. Setting the flag AFTER the explicit teardown closes that window: by the time
  # COMPLETE=1, the worktrees are already gone, so a trap firing later finds nothing to
  # leak. (The narrow inverse window — a signal landing AFTER teardown but BEFORE the
  # flag is set — is now harmless to the branch too: GAFFER_KEEP_DELIVERY_BRANCH was
  # already raised before delivery was recorded, so the trap in that window tears the
  # worktree only and PRESERVES the now review-visible branch (FIX-BRANCH); the
  # worktree, the thing this fix protects, is already removed, so nothing leaks.)
  #
  # The gaffer/ branch + its commits PERSIST in each real repo for review/merge — only
  # the disposable checkout is removed. The real repo's primary working tree + current
  # branch never moved.
  gaffer_cleanup_worktrees
  GAFFER_DELIVERY_COMPLETE=1
  # PAUSE-ON-CAP: a resumed delivery that completed has left the paused state for
  # good — drop its stale resume context (no-op delete when there is no row).
  [ "$_RESUMING" = "1" ] && wg ticket paused-clear "$NUM" >/dev/null 2>&1 || true
  log "removed delivery worktrees for #$NUM — branch $WORK_BRANCH persists in the real repo(s) for review"

  # ── Stabilisation gate 3: real-repo CLEAN after teardown (HARD FAIL) ────────
  # Teardown must leave the REAL main checkout of each write repo clean — no
  # copied src tree, no leaked events log, no broken symlink, no dirty tree. If
  # teardown leaked an unmanaged artifact into a real repo, fail the tick visibly
  # (record a note on the ticket) so the leak is caught at source, not discovered
  # in a later salvage. HYGIENE_ENFORCE=0 downgrades to a logged warning.
  REPO_DIRTY=""
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rpath" ] || continue
    git -C "$rpath" rev-parse --git-dir >/dev/null 2>&1 || continue
    _rc="$(gaffer_assert_repo_clean "$rpath" 2>/dev/null)" || \
      REPO_DIRTY+="[${rname:-repo} @ $rpath] $_rc"$'\n'
  done <<< "$WT_ROWS"
  REPO_DIRTY="$(printf '%s' "$REPO_DIRTY" | sed '/^$/d')"
  if [ -n "$REPO_DIRTY" ]; then
    log "HYGIENE: real repo NOT clean after teardown for #$NUM:"$'\n'"$REPO_DIRTY"
    if [ "${HYGIENE_ENFORCE:-1}" = "1" ]; then
      wg attach-evidence "$NUM" --type manual_note \
        --summary "POST-TEARDOWN LEAK: real repo not clean after delivery:"$'\n'"$REPO_DIRTY" >/dev/null 2>&1 || true
      gaffer_skip_ticket "$NUM"
      log "delivery FLAGGED for #$NUM — teardown left unmanaged artifacts in a real repo (see note)"
      result error; exit 0
    else
      log "HYGIENE_ENFORCE=0 — logging the post-teardown leak but NOT failing the tick"
    fi
  fi

  # ── H4: real PR creation (opt-in GAFFER_CREATE_PR=1) ─────────────────────────
  # After the delivery is fully recorded and the worktrees are torn down, attempt
  # to open a GitHub PR. This is ALWAYS best-effort: a failure is logged but never
  # rolls back the delivery or changes the ticket status. The `gh` binary is
  # injectable via GAFFER_GH_BIN so the no-op (flag off / no remote) path is clean.
  _PR_URL=""
  if declare -F gaffer_create_pr >/dev/null 2>&1; then
    # The REAL primary repo (the branch persists there), NOT the worktree: this runs
    # after the worktrees are torn down, so the worktree path no longer exists and
    # every remote check on it said "no GitHub remote" — PR creation never fired.
    _PR_URL="$(gaffer_create_pr "$NUM" "${_CARD_REAL_REPO:-$PRIMARY_REPO}" "$WORK_BRANCH" "$DEFAULT_BRANCH" "$TITLE" 2>>"$GAFFER_LOG" || true)"
  else
    log "H4: pr-create.sh not loaded — skipping (GAFFER_CREATE_PR=${GAFFER_CREATE_PR:-0})"
  fi

  # ── H3: CI-aware review gate (opt-in GAFFER_REQUIRE_CI=1) ─────────────────────
  # When enabled, poll CI checks on the delivery branch before letting the ticket
  # enter the human review lane.
  #   green checks            → proceed (rc=0)
  #   red checks              → auto-reject back to rework (rc=2)
  #   timeout / no-PR / no-checks (strict, default) → auto-reject (rc=2)
  #   timeout / no-PR / no-checks (GAFFER_CI_TIMEOUT_POLICY=proceed) → proceed (rc=0)
  #   flag off                → no-op (rc=0)
  #   flag on but GAFFER_CREATE_PR off → SKIP with one warning per run (rc=0): the
  #     checks live on the PR, so without PR creation the gate polled a PR that never
  #     existed and (strict) rejected every delivery at the timeout.
  if declare -F gaffer_ci_gate >/dev/null 2>&1; then
    if declare -F gaffer_ci_gate_needs_pr >/dev/null 2>&1 && gaffer_ci_gate_needs_pr; then
      gaffer_ci_gate_warn_needs_pr "$NUM"; _CI_RC=0
    else
      gaffer_ci_gate "$NUM" "${_CARD_REAL_REPO:-$PRIMARY_REPO}" "$WORK_BRANCH" "${_PR_URL:-}"
      _CI_RC=$?
    fi
    if [ "$_CI_RC" = "2" ]; then
      # CI went red → auto-reject back to rework so a human never sees a broken CI.
      log "H3: CI FAILED for #$NUM — auto-rejecting delivery back to rework (ticket left for re-delivery)"
      _CUR_CI_STATUS="$(wg ticket show "$NUM" 2>/dev/null | jget 'd.ticket.status' 2>/dev/null || echo '')"
      if [ "$_CUR_CI_STATUS" = "in_review" ]; then
        # --as system: a runner (CI) rejection is NOT a human decision — recorded as one, it
        # fed the autonomy recommendations' human-agreement rate.
        wg review reject "$NUM" --to refining --reviewer factory-ci --as system \
          --reason "H3: CI checks failed on branch $WORK_BRANCH — see attached evidence for the failing check" \
          >/dev/null 2>&1 \
          && log "H3: auto-rejected #$NUM (in_review → refining)" \
          || log "H3: WARNING — could not auto-reject #$NUM to refining (non-fatal)"
      else
        # Not in_review any more: dispatch refuses approval without a CI PASS for the
        # candidate, and the recorded FAIL HOLDS an already-approved ticket for a human
        # (ready_for_merge|in_testing → blocked, reason ci_red) — never left landable.
        log "H3: ticket #$NUM is in status '$_CUR_CI_STATUS' (not in_review) — the recorded CI failure holds it for a human (dispatch: blocked, ci_red)"
      fi
      result error; exit 0
    fi
  else
    log "H3: ci-gate.sh not loaded — skipping (GAFFER_REQUIRE_CI=${GAFFER_REQUIRE_CI:-0})"
  fi

  # TESTER FIRST (lib/tester.sh), in every review mode: the gates passed, so a delivery the
  # independent tester gates goes to it now, before a person or the reviewer agent sees it;
  # its PASS brings it back to review, where the reviewer agent (agent|both) reviews the
  # tested commit once, and a FAIL sends it to rework with no review paid. Dispatch decides
  # whether the tester gates the ticket (a no-op otherwise); fail-soft.
  if declare -F gaffer_tester_route >/dev/null 2>&1; then
    gaffer_tester_route "$NUM"
  fi

  result worked; exit 0
}
