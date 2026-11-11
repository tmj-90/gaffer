#!/usr/bin/env bash
# runner/lib/tick-launch.sh
# Launch: workspace trust, the raw prompt inputs (the text is rendered by
# packages/crew), model routing and the dry-run preview, worktree creation, the agent
# environment and MCP runtime, and one attempt's launch through the worker seam.
#
# Sourced by runner/tick.sh only (required there: a missing file fails the tick
# closed). Function definitions only, so sourcing it runs nothing. Every body was
# moved verbatim out of tick.sh; the functions read and write tick.sh's globals
# (NUM, SHOW, WT_ROWS, CLAIM_TOKEN, ...) exactly as the inline code did, and the
# gaffer_tick_* / _gaffer_idle_* wrappers declare no locals, so every assignment in
# them stays global. See runner/CLAUDE.md for the map of the tick phases.

# Mark a delivery worktree as a TRUSTED Claude Code workspace so the headless
# `claude -p` agent HONOURS the installed .claude/settings.json permission
# allowlist instead of hanging on a tool-permission prompt no one can answer
# (Claude Code ignores project settings in an untrusted directory, and every
# delivery runs in a fresh, never-trusted worktree). The PreToolUse safety-hook is
# the real boundary, but an agent whose project permissions are ignored cannot read
# its ticket, run the tests, commit or record evidence (the live run that pinned this
# auto-committed an untested scaffold and had it reviewed by an equally blind
# reviewer). So it FAILS CLOSED: a non-zero trust-workspace.mjs exit for the worktree
# or its main root returns 1 with _GAFFER_TRUST_ERROR set (trust_unwritable, the
# stderr tail and the fix), and gaffer_install_agent_dir refuses the launch.
# Operator-endorsed fix (configure ~/.claude.json) rather than
# --dangerously-skip-permissions.
# Echo the MAIN repo working tree for a git dir: for a LINKED worktree this is the
# directory that holds the shared `.git` (the git-common-dir's parent); for a normal
# repo root it is the dir itself. Empty on a non-git dir / failure. Pure — reads git
# only, mutates nothing — so it is unit-testable in isolation.
gaffer_git_main_worktree() {
  local dir="$1" common
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  common="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)" || return 0
  [ -n "$common" ] || return 0
  case "$common" in
    /*) dirname -- "$common" ;;   # absolute (a linked worktree) → parent of the shared .git
    *)  printf '%s\n' "$dir" ;;   # relative ('.git') → dir is already the repo root
  esac
}

gaffer_trust_workspace() {
  local dir="$1"
  _GAFFER_TRUST_ERROR=""
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  # The factory only ever names paths IT controls (a linked delivery worktree, or a
  # full repo it onboarded/created — PRIMARY_REPO, the clarify clone, the greenfield
  # bootstrap). GAFFER_TRUST_ALLOW_REPO=1 vouches for the full-repo shapes; linked
  # worktrees are still validated strictly (under the worktree root) regardless.
  # GAFFER_DATA is passed so the prune of dead worktree entries knows this factory's
  # real worktree root ($GAFFER_DATA/worktrees) under a non-default data dir.
  # Claude Code keys a git WORKTREE's trust on its MAIN repo working tree (the
  # git-common-dir's parent), NOT the worktree path — so trusting only a linked
  # delivery worktree is IGNORED: the agent runs untrusted, the settings allowlist is
  # dropped, and its dispatch/memory MCP tools are never permitted (no evidence /
  # digest / lore writes during delivery). Also trust the main repo root when it
  # differs from the worktree. KEY_ONLY: the agent runs in the worktree (whose own
  # settings.local.json the first call neutralized), so we only write the trust key
  # for the main root — never mutate the onboarded repo's working tree.
  local main path key_only errf rc tail fix unsafe
  main="$(gaffer_git_main_worktree "$dir")"
  [ -n "$main" ] && [ "$main" != "$dir" ] && [ -d "$main" ] || main=""
  for path in "$dir" ${main:+"$main"}; do
    key_only=""
    [ "$path" = "$dir" ] || key_only=1
    errf="$(mktemp "${TMPDIR:-/tmp}/gaffer-trust.XXXXXX" 2>/dev/null)" || errf=""
    unsafe=""
    if [ -n "$errf" ]; then
      GAFFER_DATA="${GAFFER_DATA:-}" GAFFER_TRUST_ALLOW_REPO=1 GAFFER_TRUST_KEY_ONLY="$key_only" \
        node "$RUNNER_DIR/lib/trust-workspace.mjs" "$path" 2>"$errf"
      rc=$?
      cat "$errf" >>"$GAFFER_LOG" 2>/dev/null || true
      tail="$(tail -n 2 "$errf" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
      unsafe="$(grep 'unsafe_worktree_path:' "$errf" 2>/dev/null | tail -n 1)"
      rm -f "$errf"
    else
      GAFFER_DATA="${GAFFER_DATA:-}" GAFFER_TRUST_ALLOW_REPO=1 GAFFER_TRUST_KEY_ONLY="$key_only" \
        node "$RUNNER_DIR/lib/trust-workspace.mjs" "$path" 2>>"$GAFFER_LOG"
      rc=$?
      tail="see $GAFFER_LOG"
    fi
    [ "$rc" -eq 0 ] && continue
    case "$tail" in
      *unsafe_worktree_path*) fix="replace the symbolic link the message names with a regular file or directory in the repository, then run again" ;;
      *"not valid JSON"*) fix="fix ~/.claude.json (it is not valid JSON), then run again" ;;
      *lock*) fix="remove the stale lock ~/.claude.json.gaffer-trust.lock if no factory run is writing trust right now, then run again" ;;
      *refusing*) fix="the path is not a factory worktree or a repo the factory vouches for" ;;
      *) fix="fix ~/.claude.json or remove its stale lock ~/.claude.json.gaffer-trust.lock, then run again" ;;
    esac
    _GAFFER_TRUST_ERROR="trust_unwritable: $path (exit $rc): ${tail% }; $fix"
    # A path in the worktree trust refused to write through (.claude/settings.local.json
    # that cannot be neutralised) is the same refusal as the installer's: the launch sites
    # park on _GAFFER_UNSAFE_PATH_ERROR (blocked with the path) instead of a setup error
    # that releases the ticket to ready and refuses it again on every run.
    [ -n "$unsafe" ] && _GAFFER_UNSAFE_PATH_ERROR="unsafe_worktree_path:${unsafe#*unsafe_worktree_path:}"
    log "TRUST: could not pre-trust $path${key_only:+ (main repo root of $dir)}: $_GAFFER_TRUST_ERROR"
    return 1
  done
  return 0
}

# Raw prompt inputs + PROMPT (crew renders the text). Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_gather_prompt_inputs() {
  # Prior review feedback: if this ticket was sent back before, the reviewer's
  # reasons ride into the prompt so the agent ADDRESSES them this time. Pulled from
  # ticket.transitioned events whose payload reason records a rejection, newest
  # few, deduped. Only the RAW reasons are captured here: the write/read repo
  # lists, the review-feedback framing and the quarantine envelope around
  # the (untrusted) reasons are all rendered by crew's deliveryPrompt.ts, which
  # reads _RF through _gaffer_prompt_inputs_json (factory.config.sh).
  # The human's answers to decisions on this ticket ride in the same way (_RD, a
  # JSON array the renderer quotes inside an untrusted envelope), so an agent that
  # skips get_ticket's resolved_decisions does not ask the same question again.
  _TSHOW="$(wg ticket show "$NUM" 2>/dev/null || true)"
  _RF="$(printf '%s' "$_TSHOW" | gaffer_json review-feedback 2>/dev/null || true)"
  _RD="$(printf '%s' "$_TSHOW" | gaffer_json resolved-decisions 2>/dev/null || true)"
  # The reviewer's open must-fix comments (Fix these) ride in as RAW data too (_RC, a JSON
  # array): the renderer numbers them as requirements inside an untrusted envelope.
  _RC="$(printf '%s' "$_TSHOW" | gaffer_json review-comments 2>/dev/null || true)"

  # ── PRIOR CONTEXT (file cards) — via shared gaffer_prime_context_block ───────
  # Runner has ALREADY resolved scope (write/read partition above). Pull the
  # repo's file cards for this ticket via the shared primer and PUSH them into
  # the delivery prompt so the agent starts oriented instead of re-scanning.
  # The agent still PULLS more via the memory MCP.
  # FAIL-SOFT: any memory error / no cards → empty block and delivery proceeds
  # exactly as before. Cards are a retrieval AID, never source.
  FILE_CARDS_BLOCK=""
  PRIME_CONTEXT_CALLED=false
  CARDS_SERVED=0
  _CARD_REAL_REPO="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' 'NR==1{print $3}')"
  [ -n "$_CARD_REAL_REPO" ] || _CARD_REAL_REPO="$REPO_PATH"
  _CARD_REPO_NAME="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' 'NR==1{print $2}')"
  [ -n "$_CARD_REPO_NAME" ] || _CARD_REPO_NAME="$(basename "$_CARD_REAL_REPO")"
  _CARD_DESC="$(echo "$SHOW" | jget '(d.ticket.description || "").slice(0, 600)' 2>/dev/null || echo '')"
  _CARD_QUERY="$(printf '%s %s' "$TITLE" "$_CARD_DESC")"
  # Remember the display name + ticket used for THIS delivery's recall, so the
  # outcome-feedback call below (submit / blocked-park) targets the exact
  # (repo, ticket) memory logged the served items under. GAFFER_RECALL_TICKET
  # is exported ONLY for the delivery prime (not review/clarify) so memory logs
  # the read-event edge for the items that actually fed the delivered work.
  RECALL_REPO_NAME="$_CARD_REPO_NAME"
  # A DRY_RUN prime is a preview: no recall ticket, so memory logs no read events and
  # no memory_primed evidence lands on the ticket (exploratory finding cli-runner/F-06).
  _RECALL_FOR=""; [ "${DRY_RUN:-0}" = "1" ] || _RECALL_FOR="$NUM"
  # CODE INDEX: the paths and symbols the ticket NAMES (json-tool ticket-named-code:
  # identifier and path characters only) and the base branch's tip in the real repo, so
  # the primer lists their direct callers and tests from memory's code index, and says
  # "stale" instead when the index describes another commit. Gathered here, rendered by
  # the crew seam. The index's answer lands in a temp file for delivery-metrics.jsonl.
  _CARD_NAMED="$(printf '%s' "$SHOW" | gaffer_json ticket-named-code 2>/dev/null || true)"
  _CARD_BASE="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' 'NR==1{print $4}')"
  _CARD_BASE_SHA="$(git -C "$_CARD_REAL_REPO" rev-parse --verify --quiet "${_CARD_BASE:-main}^{commit}" 2>/dev/null || true)"
  # PRE-WORK SCOUT (lib/scout.sh, delta roadmap gap 3): before the agent starts, the
  # runner expands what the ticket names and any stack frame it quotes through the code
  # index (importers and tests, two hops, at most 25 files, each with its reason), reads
  # the repo's test command and prior send-backs, and classifies the risk (it can only
  # raise the declared level). The bounded read-only MODEL scout adds checked
  # suggestions when GAFFER_SCOUT asks for it. Raw inputs only: deliveryPrompt.ts renders
  # the block. When the scout lists the named code's neighbours, the file-card primer
  # does not repeat them; the scout's index answer feeds delivery-metrics instead.
  _SCOUT_ATTEMPT="$(echo "$SHOW" | jget 'Math.trunc(Number(d.ticket.attempt_count || 0)) + 1' 2>/dev/null || echo 1)"
  SCOUT_PROMPT=""; SCOUT_RISK=""; SCOUT_RAISED=""; SCOUT_INDEX_FILE=""
  if declare -F gaffer_scout_run >/dev/null 2>&1; then
    gaffer_scout_run "$_CARD_REAL_REPO" "$_CARD_BASE_SHA" "$_SCOUT_ATTEMPT" 2>/dev/null || true
    gaffer_model_scout "$NUM" "$_CARD_REAL_REPO" "$_CARD_BASE_SHA" 2>/dev/null || true
  fi
  [ -n "$SCOUT_PROMPT" ] && [ -n "$SCOUT_INDEX_FILE" ] && _CARD_NAMED=""
  _CARD_INDEX_OUT=""
  if [ -n "$_CARD_NAMED" ]; then
    _CARD_INDEX_OUT="$(mktemp "${TMPDIR:-/tmp}/gaffer-index.XXXXXX" 2>/dev/null)" || _CARD_INDEX_OUT=""
  fi
  FILE_CARDS_BLOCK="$(GAFFER_PRIME_NAMED="$_CARD_NAMED" GAFFER_PRIME_BASE_SHA="$_CARD_BASE_SHA" GAFFER_PRIME_INDEX_OUT="$_CARD_INDEX_OUT" GAFFER_RECALL_TICKET="$_RECALL_FOR" gaffer_prime_context_block "$_CARD_REAL_REPO" "$_CARD_REPO_NAME" "$_CARD_QUERY" 2>/dev/null || true)"
  _CARD_INDEX_METRIC=""
  if [ -n "$_CARD_INDEX_OUT" ]; then
    _CARD_INDEX_METRIC="$(gaffer_json index-metric "$_CARD_INDEX_OUT" 2>/dev/null || true)"
    rm -f "$_CARD_INDEX_OUT"
    [ -z "$_CARD_INDEX_METRIC" ] || log "cards: code index for what #$NUM names: $_CARD_INDEX_METRIC"
  elif [ -n "$SCOUT_INDEX_FILE" ]; then
    _CARD_INDEX_METRIC="$(gaffer_json index-metric "$SCOUT_INDEX_FILE" 2>/dev/null || true)"
    [ -z "$_CARD_INDEX_METRIC" ] || log "scout: code index for what #$NUM names: $_CARD_INDEX_METRIC"
  fi
  if [ -n "$FILE_CARDS_BLOCK" ]; then
    PRIME_CONTEXT_CALLED=true
    # Count card lines only: the recalled-lore section that may follow the cards
    # uses the same "  - [kind]" bullet, so it is cut off before counting.
    CARDS_SERVED="$(printf '%s\n' "$FILE_CARDS_BLOCK" | sed '/Recalled lore for this scope (conventions \/ gotchas):$/,$d' | grep -c "^  - \[" 2>/dev/null || true)"
    # `grep -c` exits 1 on a zero count, so `|| echo 0` captured "0⏎0" (exploratory
    # finding fresh-user/F-18); `|| true` keeps grep's own "0".
    CARDS_SERVED="${CARDS_SERVED:-0}"
    log "cards: primed delivery #$NUM with ${CARDS_SERVED} file card(s)"
  else
    log "cards: no file-card context for #$NUM (none served / memory unavailable) — proceeding without"
  fi
  # METRICS (chunk 2b) — record the mechanically-observable retrieval facts for
  # this delivery: prime_context_called + cards_served + the served cards' paths.
  # Best-effort, gated on GAFFER_DATA, fully swallowed (never affects delivery). The
  # complementary reads-before-first-write signal is captured at the safety-hook
  # tool-call layer ($GAFFER_DATA/tool-metrics.jsonl), keyed by GAFFER_TICKET. The
  # end-of-run summary (run-summary.sh → json-tool summary-retrieval) joins the two:
  # reads before the first write, and how many served cards the agent then Read.
  if [ -n "${GAFFER_DATA:-}" ] && [ "${DRY_RUN:-0}" != "1" ]; then
    {
      printf '%s\n' "$FILE_CARDS_BLOCK" \
        | node "$RUNNER_DIR/lib/json-tool.mjs" delivery-metric "$NUM" "$PRIME_CONTEXT_CALLED" "${CARDS_SERVED:-0}" "$_CARD_INDEX_METRIC" \
        >> "$GAFFER_DATA/delivery-metrics.jsonl"
    } 2>/dev/null || true
  fi

  # ── PRODUCT CONTEXT (why this work exists) — via gaffer_product_context_block ─
  # Aim recall at the "why": pull the repo's durable product-intent lore
  # (decisions / requirements / non-goals) and inject it AFTER the file cards so
  # the agent starts from intent, not just structure. QUARANTINED like the cards.
  # FAIL-SOFT: none / memory unavailable → empty block, delivery proceeds unchanged.
  PRODUCT_CONTEXT_BLOCK="$(gaffer_product_context_block "$_CARD_REPO_NAME" 2>/dev/null || true)"
  if [ -n "$PRODUCT_CONTEXT_BLOCK" ]; then
    log "product-context: primed delivery #$NUM with product-intent lore"
  fi
  # ACCEPTANCE GATE: the acceptance ticket's instructions ride ahead of the product
  # context (same prompt slot, no renderer change): write the brief-level suite, fix
  # what it finds, never weaken a test. The ticket's own text still arrives quarantined.
  if [ "${IS_ACCEPTANCE:-0}" = "1" ] && declare -F gaffer_acceptance_prompt_block >/dev/null 2>&1; then
    PRODUCT_CONTEXT_BLOCK="$(gaffer_acceptance_prompt_block)${PRODUCT_CONTEXT_BLOCK:+

$PRODUCT_CONTEXT_BLOCK}"
    log "ACCEPTANCE: #$NUM is the epic's acceptance ticket — brief-level acceptance suite against the integrated build; the independent tester decides"
  fi

  # A repo that ships its OWN .claude/skills keeps them: a Gaffer pack of the same name is
  # not mounted over it, and the recommended-skills line says the repo's version wins.
  SKILLS_NOTE="${SKILLS_PACK_NOTE:-}$(gaffer_skills_note "$PRIMARY_REPO" "$SKILLS, $LENSES" 2>/dev/null || true)"

  # The prompt TEXT — the quarantined title, the lore-reflection nudge, the
  # review-feedback block, the repo lists — is LIVE in
  # packages/crew/src/runtime/context/deliveryPrompt.ts; edit it there (and
  # rebuild crew), not here. This file only gathers the raw inputs.
  if [ "$_RESUMING" = "1" ]; then
    # PAUSE-ON-CAP continuation prompt: the prior progress is ALREADY in this worktree
    # (committed and/or working changes) — the agent CONTINUES and FINISHES it with a
    # fresh turn allowance. No re-claim, no re-scaffold; the ticket is already
    # in_progress and the branch already carries the partial work.
    PROMPT="$(gaffer_render_delivery_prompt resume)" \
      || gaffer_abort_setup PROMPT-RENDER "failed to render resume prompt for #$NUM — aborting delivery (fail closed)"
  else
  PROMPT="$(gaffer_render_delivery_prompt fresh)" \
    || gaffer_abort_setup PROMPT-RENDER "failed to render delivery prompt for #$NUM — aborting delivery (fail closed)"
  fi

  if [ "$_RESUMING" = "1" ]; then
    log "resume=#$NUM → re-entering delivery for paused #$NUM ('$TITLE') in $PRIMARY_REPO [stack=$STACK]"
  elif [ "${DRY_RUN:-0}" = "1" ]; then
    # Not "delivering": `gaffer status` lists this line as a dry-run preview.
    log "ready=$READY_COUNT → DRY_RUN: previewed #$NUM ('$TITLE') in $PRIMARY_REPO (nothing claimed, nothing spent) [stack=$STACK]"
  elif [ "$MULTI_REPO" = "1" ]; then
    log "ready=$READY_COUNT → delivering #$NUM ('$TITLE') across $WRITE_REPO_COUNT write repos (multi-repo) [stack=$STACK]"
  else
    log "ready=$READY_COUNT → delivering #$NUM ('$TITLE') in $PRIMARY_REPO (single-repo) [stack=$STACK]"
  fi
}

# Model routing; DRY_RUN previews and exits here. Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_route_model() {
  # ── I1: intelligent, data-driven MODEL ROUTING for the implement phase ───────
  # Replace the static GAFFER_IMPL_MODEL_FLAG with a per-ticket routing decision:
  # read the ticket's risk, AC count, and attempt history from the dispatch view,
  # pass them + the repo stack + the budget seam to the deterministic router, and
  # let it pick the cheapest-correct tier. gaffer_route_model logs one auditable
  # "ROUTE #N …" line and echoes the model id; an explicit GAFFER_IMPL_MODEL still
  # wins (backward-compat). With the default registry + a normal ticket this
  # resolves to mid=sonnet — exactly today's implement model.
  ROUTE_RISK="$(echo "$SHOW" | jget 'd.ticket.risk_level || "medium"' 2>/dev/null || echo medium)"
  # The router sees the EFFECTIVE risk: the scout's classifier can only raise it.
  if [ -n "$SCOUT_RISK" ]; then
    [ -z "$SCOUT_RAISED" ] || log "SCOUT: #$NUM $SCOUT_RAISED — routing on $SCOUT_RISK"
    ROUTE_RISK="$SCOUT_RISK"
  fi
  ROUTE_AC="$(echo "$SHOW" | jget '(d.acceptanceCriteria || []).length' 2>/dev/null || echo 0)"
  # attempt_count is 0-based (0 = first delivery); the router's attempt is 1-based
  # so a prior rejection (attempt_count≥1) escalates. Default 0 if absent.
  ROUTE_ATTEMPT_RAW="$(echo "$SHOW" | jget 'Math.trunc(Number(d.ticket.attempt_count || 0))' 2>/dev/null || echo 0)"
  ROUTE_ATTEMPT=$(( ${ROUTE_ATTEMPT_RAW:-0} + 1 ))
  # Pass the primary worktree so the router can measure diff size / file count when a
  # worktree with UNCOMMITTED work exists (a resumed delivery); on a first attempt no
  # worktree exists yet, so the difficulty signal is the ticket's accumulated measured
  # spend (historical cost).
  # FINDING-9: routing runs BEFORE the worktrees are created, and a rework attempt's
  # accumulated work is COMMITTED on the preserved gaffer/ branch — invisible to a
  # worktree `git diff HEAD` even when one exists. Pass the REAL primary repo, the
  # ticket branch and its base so the router can measure the accumulated rework diff
  # (`git diff base...branch`) straight from the repo when the branch survives.
  ROUTE_REPO="$(printf '%s\n' "$WT_ROWS" | grep . | head -1 | awk -F'\t' '{print $3}')"
  ROUTE_BASE="$(printf '%s\n' "$WT_ROWS" | grep . | head -1 | awk -F'\t' '{print ($4==""?"main":$4)}')"
  DELIVERY_MODEL="$(gaffer_route_model implement "$ROUTE_RISK" "$ROUTE_AC" "$STACK" "$ROUTE_ATTEMPT" "$NUM" "$PRIMARY_REPO" "$ROUTE_REPO" "$WORK_BRANCH" "$ROUTE_BASE")"
  # The scout packet is this attempt's record ($GAFFER_DATA/scout/ticket-N/attempt-K.json and
  # a ticket.scout_recorded system event), and the launch's context selection is one
  # context-selection.jsonl line. Measurements; fail-soft; nothing in a DRY_RUN.
  if declare -F gaffer_scout_persist >/dev/null 2>&1; then
    gaffer_scout_persist "$NUM" "$ROUTE_ATTEMPT" 2>/dev/null || true
    gaffer_scout_selection "$NUM" "$ROUTE_ATTEMPT" "$SKILLS" "$LENSES" "${DELIVERY_MODEL:-default}" "$FILE_CARDS_BLOCK" 2>/dev/null || true
    gaffer_scout_cleanup 2>/dev/null || true
  fi
  # Per-tick implement flag: the router's model, or empty (→ Claude default) when
  # the registry/override resolves to none. Falls back to the static flag only if
  # routing yielded nothing AND the static tier is set.
  ROUTE_IMPL_FLAG=""
  if [ -n "$DELIVERY_MODEL" ]; then
    ROUTE_IMPL_FLAG="--model $DELIVERY_MODEL"
  elif [ -n "${GAFFER_IMPL_MODEL_FLAG:-}" ]; then
    ROUTE_IMPL_FLAG="$GAFFER_IMPL_MODEL_FLAG"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    # DRY_RUN is strictly side-effect-free: we describe the worktree plan but
    # create NO worktrees, branches, or files.
    log "DRY_RUN: would clean any stale worktrees under $WORKTREES_BASE (+ git worktree prune per write repo)"
    log "DRY_RUN: would add a throwaway worktree per write repo on branch $WORK_BRANCH, then install"
    log "DRY_RUN: project-local .claude/ (settings+hook, skills, CLAUDE.md) + .mcp.json into the PRIMARY worktree, then:"
    log "DRY_RUN:   (cd <primary worktree> && GAFFER_WRITE_ROOTS=<worktree paths> GAFFER_READ_ROOTS=<read roots> DISPATCH_DB=… MEMORY_DB=… $CLAUDE_BIN -p <prompt> $CLAUDE_FLAGS)"
    log "DRY_RUN: write repos (each delivered via a worktree on branch $WORK_BRANCH; the real repo's working tree is never touched):"
    while IFS=$'\t' read -r rid rname rpath rdefault rwt; do
      [ -n "$rpath" ] || continue
      log "DRY_RUN:   WRITE  ${rname:-repo} @ $rpath (base ${rdefault:-main}) → worktree $rwt on $WORK_BRANCH"
    done <<< "$WT_ROWS"
    log "DRY_RUN: primary worktree (agent cwd) = $PRIMARY_REPO"
    if [ -n "$(printf '%s' "$READ_ROOTS" | tr -d '[:space:]')" ]; then
      while IFS= read -r rpath; do [ -n "$rpath" ] && log "DRY_RUN:   READ   $rpath (real repo, read-only context; never branched or worktree'd)"; done <<< "$READ_ROOTS"
    else
      log "DRY_RUN:   READ   (none)"
    fi
    log "DRY_RUN: on success, would assert each worktree HEAD is $WORK_BRANCH, record per-repo delivery, then remove the worktrees (branch + commits PERSIST in the real repo)"
    log "DRY_RUN: on failure, would remove the worktrees AND delete branch $WORK_BRANCH so the real repo stays 100% clean"
    log "DRY_RUN: recommended skills = $SKILLS"
    log "DRY_RUN: routed implement model = ${DELIVERY_MODEL:-<claude default>} (see the ROUTE #$NUM line above for the decision)"
    gaffer_dry_mark_previewed "$NUM"
    result previewed; exit 0
  fi
}

# Delivery worktrees + base commits (defines gaffer_cleanup_worktrees). Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_create_worktrees() {
  # ── Worktree delivery setup (replaces in-place branching) ───────────────────
  # The RUNNER owns the delivery checkout: rather than branching a real repo IN
  # PLACE (which would dirty the human's working tree), we add a throwaway git
  # worktree per WRITE repo, checked out on the ticket branch. Worktrees share
  # the real repo's object DB, so commits land on `gaffer/ticket-$NUM-$slug` IN
  # the real repo while its primary working tree + current branch are untouched.
  #
  # FG-008 preserved: one branch per write repo, each off that repo's OWN default
  # branch; a write repo that exists on disk but cannot be worktree'd FAILS the
  # delivery (fail safely). Single-repo / mono-fallback = exactly one worktree =
  # one gaffer/ branch = today's behaviour, just running in a worktree.
  #
  # DEFAULT_BRANCH = the PRIMARY write repo's base, kept for the existing
  # diff/assertion code paths below (which operate on PRIMARY_REPO = primary wt).
  DEFAULT_BRANCH="$(printf '%s\n' "$WRITE_ROWS" | grep . | head -1 | awk -F'\t' '{print ($4==""?"main":$4)}')"
  [ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="$(echo "$SHOW" | jget '(((d.repositories||[]).find(r => r.access === "write" && r.local_path) || (d.repositories||[]).find(r => r.local_path) || (d.repositories||[])[0] || {}).default_branch) || "main"')"

  # Helper: tear down every worktree we may have created for this ticket and
  # (optionally) delete the gaffer/ branch. Used for (a) stale cleanup before a
  # run, (b) success removal — keep the branch, (c) failure rollback — drop the
  # branch too, so a botched run leaves the real repo 100% clean. Always defensive
  # (`git worktree prune`) and never fatal.
  # BRANCH RETENTION: `drop-branch` deletes $WORK_BRANCH ONLY in the repos where THIS
  # tick created it (`worktree add -B`, recorded in _BRANCH_CREATED_THIS_TICK by repo
  # path). A branch this tick merely re-attached — a rework's reviewed commits, a
  # resume — predates the tick and is never deleted by any caller: the crash trap
  # (signals, the outer timeout, setup exits, the pre-spawn budget park), the
  # multi-repo setup rollback, or a failure path. Those used to delete reviewed,
  # paid-for commits. A kept branch with commits is logged.
  _BRANCH_CREATED_THIS_TICK=""
  _gaffer_branch_created_here() { grep -qxF -- "$1" <<<"$_BRANCH_CREATED_THIS_TICK"; }
  # GATE INTEGRITY: the commit each `worktree add -B` cut $WORK_BRANCH at, captured at
  # the cut (before any agent runs), by repo path: "<path>\t<sha>" lines, the latest cut
  # last. Reading the branch tip LATER is wrong — on an in-tick retry the tip holds the
  # previous attempt's commits — so the recorded base comes from here, never the tip.
  _BRANCH_CUT_SHAS=""
  _gaffer_note_branch_cut() {
    local _c
    _c="$(git -C "$1" rev-parse --verify --quiet "refs/heads/$WORK_BRANCH^{commit}" 2>/dev/null)" || _c=""
    _BRANCH_CUT_SHAS="$(awk -F'\t' -v p="$1" '$1!=p' <<<"$_BRANCH_CUT_SHAS")"
    [ -n "$_BRANCH_CUT_SHAS" ] && _BRANCH_CUT_SHAS+=$'\n'
    [ -n "$_c" ] && _BRANCH_CUT_SHAS+="$1"$'\t'"$_c"$'\n'
    return 0
  }
  _gaffer_branch_cut_sha() { awk -F'\t' -v p="$1" '$1==p{s=$2} END{if(s!="")print s}' <<<"$_BRANCH_CUT_SHAS"; }
  gaffer_cleanup_worktrees() {
    # $1 = "drop-branch" to also delete $WORK_BRANCH from each real repo where this
    # tick created it (see BRANCH RETENTION above).
    local drop_branch="${1:-}"
    local _rid _rname _rpath _rbase _rwt _kept _tip
    # CLEANUP OWNERSHIP (external review #8): every destructive step below first checks
    # that this run still owns the ticket's resources (lib/cleanup-ownership.sh) — a
    # stopped or expired attempt must never remove its replacement's worktree or branch.
    _gco_owned() {
      declare -F gaffer_cleanup_owned >/dev/null 2>&1 || return 0
      gaffer_cleanup_owned "${NUM:-}" "$1" && return 0
      log "CLEANUP: #${NUM:-?} $1 ${2:-} KEPT — the resources belong to another attempt or ownership is unknown (${_GCO_WHY:-no reason}); this run removes only its own"
      return 1
    }
    while IFS=$'\t' read -r _rid _rname _rpath _rbase _rwt; do
      [ -n "$_rpath" ] || continue
      git -C "$_rpath" rev-parse --git-dir >/dev/null 2>&1 || { [ -e "$_rwt" ] && _gco_owned worktree "$_rwt" && rm -rf "$_rwt"; continue; }
      if [ -n "$_rwt" ] && [ -e "$_rwt" ] && ! _gco_owned worktree "$_rwt"; then
        :
      elif [ -n "$_rwt" ] && [ -e "$_rwt" ]; then
        # `git worktree remove --force` deregisters the worktree but REFUSES to
        # delete untracked residue — notably the `.claude/` the skill-mount installs.
        # Once gaffer_skills_mount_cleanup drops the mount target, that worktree's
        # `.claude/skills` symlink is left DANGLING, and git leaves the whole
        # `.claude/` dir behind — which then trips the post-teardown hygiene gate
        # (broken symlink: .claude/skills). Always `rm -rf` the worktree path after
        # the git remove so teardown leaves NOTHING behind, dangling links included.
        git -C "$_rpath" worktree remove --force "$_rwt" >/dev/null 2>&1 || true
        # (Re-checked: the git call can be slow, and a replacement may have re-created
        # the worktree at this path meanwhile.)
        if [ -e "$_rwt" ] && _gco_owned worktree "$_rwt"; then rm -rf "$_rwt" 2>/dev/null || true; fi
      fi
      git -C "$_rpath" worktree prune >/dev/null 2>&1 || true
      if [ "$drop_branch" = "drop-branch" ]; then
        if _gaffer_branch_created_here "$_rpath"; then
          # Compare-and-delete: only the tip read right after the ownership check.
          _tip="$(git -C "$_rpath" rev-parse --verify --quiet "refs/heads/$WORK_BRANCH^{commit}" 2>/dev/null || true)"
          # (`branch -D` refused a branch checked out in a worktree; so does this.)
          if [ -n "$_tip" ] && _gco_owned branch "$WORK_BRANCH in ${_rname:-repo}" \
             && ! grep -qxF "branch refs/heads/$WORK_BRANCH" <<<"$(git -C "$_rpath" worktree list --porcelain 2>/dev/null)"; then
            git -C "$_rpath" update-ref -d "refs/heads/$WORK_BRANCH" "$_tip" >/dev/null 2>&1 || true
          fi
        else
          _kept="$(git -C "$_rpath" rev-list --count "${_rbase:-main}..$WORK_BRANCH" 2>/dev/null || echo 0)"
          [ "${_kept:-0}" -gt 0 ] 2>/dev/null \
            && log "branch $WORK_BRANCH KEPT in ${_rname:-repo} ($_rpath): it predates this tick ($_kept commit(s) over ${_rbase:-main}); only the worktree was removed"
        fi
      fi
    done <<< "$WT_ROWS"
    # Also remove the (now empty) ticket worktrees base dir if nothing else uses it.
    [ -d "$WORKTREES_BASE" ] && rmdir "$WORKTREES_BASE" >/dev/null 2>&1 || true
  }

  # ── M1/R-2: crash-safe worktree/branch cleanup ──────────────────────────────
  # The explicit success/error paths below tear worktrees down by hand, but a
  # CRASH or signal (the gaffer_timeout SIGTERM, a Ctrl-C, an unexpected `set -e`
  # abort) between worktree creation and one of those paths would ORPHAN the
  # throwaway worktrees and the half-finished `gaffer/ticket-*` branch in every
  # write repo. The EXIT/INT/TERM trap that drops them is already installed UP FRONT
  # (R-2, right after the config is sourced) so it ALSO covers the earlier candidate
  # / skill / access-boundary parsing — but it is unset-var-safe and a no-op until
  # gaffer_cleanup_worktrees + WT_ROWS are defined (i.e. until now). Now that the
  # teardown helper and its rows exist, the trap becomes effective for this ticket.
  # It is GUARDED so a legitimately-delivered branch is never destroyed: on a
  # successful delivery we set GAFFER_DELIVERY_COMPLETE=1 (the branch must survive
  # for review/merge) and the trap then returns early. The cleanup itself is
  # idempotent (`git worktree prune` / `branch -D` are no-ops when there's nothing to
  # remove), so it is safe even when an explicit path already cleaned up.

  # Idempotent re-runs: clear any stale worktrees from a previous attempt at this
  # ticket BEFORE creating fresh ones, and prune dangling worktree admin entries
  # (runs unconditionally — `git worktree prune` is a defensive no-op when clean).
  # PAUSE-ON-CAP: a RESUME must NOT clear the worktree — that is exactly the preserved
  # partial work (committed AND uncommitted) we are re-entering. Skip the stale clean.
  [ "$_RESUMING" = "1" ] || gaffer_cleanup_worktrees

  # Create a throwaway worktree on the ticket branch for each write repo. `-B`
  # gives force semantics: if the branch already exists (e.g. a half-finished
  # prior run), it is reset to the base so the worktree starts clean.
  WT_FAILED=0
  while IFS=$'\t' read -r rid rname rpath rbase rwt; do
    [ -n "$rpath" ] || continue
    rbase="${rbase:-main}"
    if ! git -C "$rpath" rev-parse --git-dir >/dev/null 2>&1; then
      # A configured write repo that is not a git repo on disk: we cannot worktree
      # it, so we cannot safely deliver into it. Fail closed.
      log "FAIL: write repo ${rname:-repo} ($rpath) is not a git repo on disk — cannot worktree #$NUM"
      WT_FAILED=1
      continue
    fi
    git -C "$rpath" worktree prune >/dev/null 2>&1 || true
    mkdir -p "$WORKTREES_BASE"
    # PAUSE-ON-CAP RESUME: the worktree from the paused delivery is still on disk with
    # its committed AND uncommitted work — REUSE it as-is. Never `-B` (which would
    # reset the branch to base and DESTROY the partial work). If the dir survived,
    # accept it; if (defensively) it vanished, re-attach a worktree onto the EXISTING
    # branch (its commits), never off the base.
    if [ "$_RESUMING" = "1" ]; then
      if [ -e "$rwt" ] && git -C "$rwt" rev-parse --git-dir >/dev/null 2>&1; then
        log "RESUME: reusing preserved worktree for ${rname:-repo} ($rpath) at $rwt on branch $WORK_BRANCH for #$NUM"
        _RESUME_WT_OK=1
      elif git -C "$rpath" worktree add "$rwt" "$WORK_BRANCH" >/dev/null 2>&1; then
        log "RESUME: re-attached worktree for ${rname:-repo} ($rpath) at $rwt on EXISTING branch $WORK_BRANCH for #$NUM (dir was missing)"
        _RESUME_WT_OK=1
      else
        log "RESUME: FAIL — could not reuse/re-attach worktree $rwt on $WORK_BRANCH for ${rname:-repo} ($rpath) for #$NUM"
        WT_FAILED=1
        _RESUME_WT_OK=0
      fi
      if [ "${_RESUME_WT_OK:-0}" = "1" ]; then
        # Prime a fresh Node repo's deps (see the created-worktree path below) so the
        # resume symlink resolves too. Idempotent no-op once node_modules exists.
        _pm_primed="$(gaffer_ensure_node_modules "$rpath")"
        case "$_pm_primed" in
          FAILED:*) log "greenfield: WARN — ${_pm_primed#FAILED:} install did not prime ${rname:-repo} deps (resume); test gate may fail #$NUM (see the diagnostic above)" ;;
          ?*) log "greenfield: primed ${rname:-repo} deps via '$_pm_primed install' (resume) for #$NUM" ;;
        esac
        gaffer_link_node_modules "$rpath" "$rwt"
      fi
      continue
    fi
    # A stale checkout of $WORK_BRANCH in another worktree would block -B; cleanup
    # above should have removed ours, but force-prune once more then add.
    # WASTE CONTROL: a retry (review CHANGES rework, a gate retry, a timeout) used to
    # `worktree add -B`, RESETTING the ticket branch to base and discarding the previous
    # attempt's commits — the reviewer's feedback then described a diff that no longer
    # existed and the agent re-implemented from scratch. The existing branch is now kept
    # (the agent builds on it, or resets deliberately); GAFFER_RETRY_FRESH_BRANCH=1
    # restores the old clean-slate reset.
    _KEPT_COMMITS=""
    if [ "${GAFFER_RETRY_FRESH_BRANCH:-0}" != "1" ] \
       && git -C "$rpath" rev-parse --verify --quiet "refs/heads/$WORK_BRANCH" >/dev/null 2>&1; then
      _KEPT_COMMITS="$(git -C "$rpath" rev-list --count "$rbase..$WORK_BRANCH" 2>/dev/null || echo 0)"
    fi
    if [ -n "$_KEPT_COMMITS" ] && [ "$_KEPT_COMMITS" -gt 0 ] 2>/dev/null \
       && git -C "$rpath" worktree add "$rwt" "$WORK_BRANCH" >/dev/null 2>&1; then
      log "reused worktree for ${rname:-repo} ($rpath) at $rwt on EXISTING branch $WORK_BRANCH for #$NUM — $_KEPT_COMMITS prior commit(s) kept (set GAFFER_RETRY_FRESH_BRANCH=1 for a clean-slate retry)"
      _pm_primed="$(gaffer_ensure_node_modules "$rpath")"
      case "$_pm_primed" in
        FAILED:*) log "greenfield: WARN — ${_pm_primed#FAILED:} install did not prime ${rname:-repo} deps (retry); test gate may fail #$NUM (see the diagnostic above)" ;;
        ?*) log "greenfield: primed ${rname:-repo} deps via '$_pm_primed install' (retry) for #$NUM" ;;
      esac
      gaffer_link_node_modules "$rpath" "$rwt"
    elif git -C "$rpath" worktree add -B "$WORK_BRANCH" "$rwt" "$rbase" >/dev/null 2>&1; then
      _BRANCH_CREATED_THIS_TICK+="$rpath"$'\n'   # this tick owns the branch (BRANCH RETENTION)
      _gaffer_note_branch_cut "$rpath"            # GATE INTEGRITY: the cut commit, now
      log "created worktree for ${rname:-repo} ($rpath) at $rwt on branch $WORK_BRANCH off $rbase for #$NUM"
      # GREENFIELD FIRST-RUN: a freshly-bootstrapped repo has a package.json+lockfile
      # but no node_modules, so the symlink below no-ops and the first ticket's test
      # gate dies on missing modules. Prime the primary repo's install ONCE (runner-
      # side, --ignore-scripts) so the symlink resolves. No-op once node_modules exists.
      _pm_primed="$(gaffer_ensure_node_modules "$rpath")"
      case "$_pm_primed" in
        FAILED:*) log "greenfield: WARN — ${_pm_primed#FAILED:} install did not prime ${rname:-repo} deps (fresh repo); test gate may fail #$NUM (see the diagnostic above)" ;;
        ?*) log "greenfield: primed ${rname:-repo} deps via '$_pm_primed install' (fresh repo had no node_modules) for #$NUM" ;;
      esac
      # JS/TS repos can't test/build in a fresh worktree: node_modules is gitignored,
      # lives only in the main checkout, and installs are hook-blocked. Link the real
      # repo's node_modules (root + per-package) in so `pnpm test`/`build` resolve.
      gaffer_link_node_modules "$rpath" "$rwt"
    else
      log "FAIL: could not add worktree $rwt on $WORK_BRANCH (base $rbase) for write repo ${rname:-repo} ($rpath) for #$NUM"
      WT_FAILED=1
    fi
  done <<< "$WT_ROWS"
  if [ "$WT_FAILED" = "1" ]; then
    if [ "$_RESUMING" = "1" ]; then
      # A resume that could not reuse/re-attach its worktree must NOT drop the branch
      # (it may still carry the paused work). Leave everything as-is for a human; keep
      # the worktree-retention flag so nothing is torn down.
      gaffer_skip_ticket "$NUM"
      log "RESUME FAILED for #$NUM — could not reuse the paused worktree; branch $WORK_BRANCH left intact for a human"
      gaffer_resume_abort "the paused worktree could not be reused or re-attached"
      result error; exit 0
    fi
    # Roll back anything partially created so a failed setup leaves no residue, and
    # release the runner-held claim back to `ready` (nothing was produced — a retry is
    # safe on a later tick).
    gaffer_cleanup_worktrees drop-branch
    gaffer_release_delivery ready "worktree setup failed — no work produced; retry"
    gaffer_skip_ticket "$NUM"
    log "delivery FAILED for #$NUM — a write repo could not be worktree'd; not running the agent"
    result error; exit 0
  fi

  # GATE INTEGRITY: fix the commit each delivery branch was cut from NOW, before the
  # agent runs, and record it on the repo delivery (`--base-sha`, no branch, so it is
  # not delivery evidence). The DoD gate reads its package.json scripts from that
  # commit and the integrity scans (the runner's row and dispatch's server-side
  # `test-modified`) diff from it — never from the base branch NAME, which the agent
  # could move from inside its worktree (`git branch -f main HEAD`). The base is the
  # commit captured when `worktree add -B` cut the branch (_BRANCH_CUT_SHAS); a kept or
  # resumed branch — and every in-tick retry that did not re-cut — keeps the commit
  # already known (stored in dispatch, else this tick's earlier pass). A stored base is
  # write-once: dispatch replaces it only on `--base-recut`. Fail-soft: an unrecorded
  # base still pins this tick's gates; the base branch name is the last resort.
  _DELIV_BASE_SHAS=""
  _gaffer_record_delivery_bases() {
    local rid rname rpath rbase rwt _cut _prev _stored _sha _list _prev_map _recut
    _prev_map="$_DELIV_BASE_SHAS"
    _DELIV_BASE_SHAS=""
    _list="$(wg ticket repo-delivery list "$NUM" 2>/dev/null || echo '[]')"
    while IFS=$'\t' read -r rid rname rpath rbase rwt; do
      [ -n "$rpath" ] || continue
      rbase="${rbase:-main}"
      _cut="$(_gaffer_branch_cut_sha "$rpath")"
      _prev="$(awk -F'\t' -v p="$rpath" '$1==p{print $2; exit}' <<<"$_prev_map")"
      _stored="$(printf '%s' "$_list" | RID="$rid" RNAME="$rname" jget '(() => {
        const rows = Array.isArray(d) ? d : [];
        const r = rows.find((x) => (process.env.RID && x.repo_id === process.env.RID) || (process.env.RNAME && x.repo_name === process.env.RNAME));
        return r && typeof r.base_sha === "string" ? r.base_sha : "";
      })()' 2>/dev/null || echo '')"
      _sha="$(gaffer_delivery_base_sha "$rpath" "$rbase" "$WORK_BRANCH" "$_cut" "$_stored" "$_prev")"
      if [ -z "$_sha" ]; then
        log "GATE INTEGRITY: could not resolve the commit $WORK_BRANCH was cut from in ${rname:-repo} ($rpath) for #$NUM — the gates fall back to the base branch $rbase"
        continue
      fi
      _DELIV_BASE_SHAS+="$rpath"$'\t'"$_sha"$'\n'
      [ "$_sha" = "$_stored" ] && continue
      # Only a commit this tick cut the branch at may replace a stored base.
      _recut=""; [ -n "$_cut" ] && [ "$_sha" = "$_cut" ] && [ -n "$_stored" ] && _recut="--base-recut"
      if wg ticket repo-delivery record "$NUM" "${rid:-$rname}" --base-sha "$_sha" $_recut --as system >/dev/null 2>&1; then
        log "GATE INTEGRITY: #$NUM ${rname:-repo} delivery base recorded: $(printf '%s' "$_sha" | cut -c1-12) (off $rbase${_recut:+, branch re-cut})"
      else
        log "GATE INTEGRITY: #$NUM ${rname:-repo} delivery base $(printf '%s' "$_sha" | cut -c1-12) did not record (non-fatal; this tick's gates still use it)"
      fi
    done <<< "$WT_ROWS"
  }
  # The recorded base commit for a write repo (empty when none was resolved).
  _gaffer_delivery_base_for() { awk -F'\t' -v p="$1" '$1==p{print $2; exit}' <<<"$_DELIV_BASE_SHAS"; }
  _gaffer_record_delivery_bases
}

# Agent env, MCP runtime, sandbox strictness. Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_prepare_launch() {
  # ── Agent-environment install (runs before EVERY attempt's launch) ──────────
  # Installs the project-local agent environment into the PRIMARY write worktree
  # (the agent's cwd; in single-repo mode PRIMARY_REPO == the one delivery worktree):
  #   • the ticket's skill mount — ONLY the selected SKILLS + quality LENSES + the
  #     universal delivery-mechanics set, not the whole library (~5k fewer
  #     tokens/call). Fail-soft inside: whole-library fallback (skills-mount.sh);
  #   • .claude/settings.json — wires runner/safety-hook.mjs as the PreToolUse
  #     hook, THE deterministic containment boundary. The template ships a
  #     ${RUNNER_DIR} placeholder; copying it verbatim would point at the
  #     author's machine and the hook would FAIL OPEN elsewhere — substitute it;
  #   • CLAUDE.factory.md — the factory brief;
  #   • the git exclude that keeps all of the above off the delivery branch.
  # WHY per-attempt, not once: the rework retry path (GUARD B) tears the
  # worktree down between attempts (gaffer_cleanup_worktrees) and re-adds a
  # FRESH checkout of the preserved branch. All of this config is untracked and
  # git-excluded, so the fresh checkout contains NONE of it — a retry launched
  # without a re-install would run WITHOUT the safety hook wired (uncontained).
  # FAIL-CLOSED: returns non-zero unless the written settings verifiably wire
  # the hook; callers must NOT launch the agent for that attempt on failure —
  # launching without the hook is the one unacceptable outcome.
  gaffer_install_agent_env() {
    gaffer_assert_safety_hook || { log "SAFETY: refusing to prepare the agent env (fail closed)"; return 1; }
    # Skills mount + render/VERIFY settings.json (PreToolUse safety-hook wiring) +
    # workspace trust + the brief — the ONE shared installer (lib/agent-env.sh) the
    # reviewer and clarify sites use too; any failure fails closed.
    gaffer_install_agent_dir "$PRIMARY_REPO" "$SKILLS, $LENSES" "delivery-$NUM" || return 1
    gaffer_exclude_runner_config "$PRIMARY_REPO"   # keep runner config out of `git add -A`
    return 0
  }
  # Attempt 1's install (the retry loop re-runs it for every later attempt).
  if ! gaffer_install_agent_env; then
    # A path in the worktree the runner refused to write through (a committed symlink
    # at .claude, .claude/settings.json, .claude/skills or CLAUDE.factory.md) is the
    # repository's, not a setup fault: it is still there on the next tick, so park the
    # ticket blocked with the path and the fix instead of releasing it to ready.
    if [ -n "${_GAFFER_UNSAFE_PATH_ERROR:-}" ]; then
      gaffer_park_unsafe_path "$NUM" "delivery agent"
      result error; exit 0
    fi
    [ -n "${_GAFFER_TRUST_ERROR:-}" ] \
      && gaffer_abort_setup TRUST "$_GAFFER_TRUST_ERROR; refusing live run for #$NUM, no agent launched (fail closed)"
    gaffer_abort_setup SAFETY "agent-env install failed for #$NUM — refusing live run (fail closed)"
  fi
  # Substitute the real DB paths into a RUNTIME copy OUTSIDE the repo. Writing into
  # $PRIMARY_REPO/.mcp.json breaks when the target repo IS the runner itself (source
  # == destination → the redirect truncates the file → "Invalid MCP configuration").
  MCP_RUNTIME="$GAFFER_DATA/mcp-runtime.$$.json"
  gaffer_assert_db_vars || gaffer_abort_setup DB-VARS "DISPATCH_DB/MEMORY_DB empty — refusing live run (fail closed)"
  # RUNNER-OWNED-BOOKKEEPING: inject the runner-held claim token into the dispatch
  # MCP server env (GAFFER_CLAIM_TOKEN) so the agent's token-gated evidence writes
  # resolve it from the server env — the agent never handles the token. A resumed
  # delivery carries the lease token resume-begin took; only a tokenless resume
  # fallback leaves it empty, which the MCP server treats as "no token".
  #
  # MEMORY-SCOPE BINDING: the ticket's in-scope repo NAMES (WT_ROWS col-2, the
  # names sourced from repositories.name in the same rows that produce
  # GAFFER_WRITE_ROOTS) are injected as ${GAFFER_TICKET_REPOS} so the memory MCP
  # server can refuse a DIRECT-APPLY write (digest / feature) targeting a repo
  # this ticket has no scope over. COLON-joined (not newline) so the value stays
  # a single-line, valid JSON string; empty names are skipped (an unnamed repo is
  # not a memory-write target). Paired with GAFFER_FACTORY=1 (a literal in the
  # template) which arms the guard — standalone memory-mcp never sets it.
  # shellcheck disable=SC2034  # read by gaffer_render_mcp_runtime (factory.config.sh)
  GAFFER_TICKET_REPOS="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' '$2!=""{print $2}' | paste -sd: -)"
  # CARD-CANONICAL BINDING: each ticket repo's name → the canonical its file cards
  # are keyed under (WT_ROWS col-3 is the REAL repo, not the worktree), rendered into
  # the memory server as ${GAFFER_REPO_CANONICALS}. The agent's card tools then find
  # the cards from its worktree without guessing a canonical — for a repo with no
  # remote its guess (the worktree path) matched nothing. Fail-soft: empty ⇒ unbound.
  # shellcheck disable=SC2034  # read by gaffer_render_mcp_runtime (factory.config.sh)
  GAFFER_REPO_CANONICALS="$(printf '%s\n' "$WT_ROWS" | grep . | awk -F'\t' '{print $2 "\t" $3}' | gaffer_repo_canonicals_json)"
  # MEMORY ROI: the delivery ticket ref is injected as ${GAFFER_RECALL_TICKET} so
  # the memory MCP server's READ path can attribute a retrieval to this ticket
  # (best-effort, fail-soft). Empty ⇒ the read path logs nothing (inert), exactly
  # like standalone memory-mcp. Same one-hop plumbing pattern as GAFFER_TICKET_REPOS.
  # Render via the single seam (factory.config.sh → packages/crew renderMcpCli.js).
  # Recall is the ticket $NUM so the memory read path can attribute a retrieval to it.
  # Fail-closed: a render error (ts renderer rejects a broken/drifted template)
  # must abort the delivery before the agent launch — the bare sed never did.
  # FACTORY TICKET SCOPE: the scope ticket ($NUM, rendered into the dispatch server's
  # GAFFER_SCOPE_TICKET) makes the server refuse the agent's writes (ACs, dependencies,
  # test contract, decisions…) on any other ticket — also on a resume, where the claim
  # token is empty.
  gaffer_render_mcp_runtime "$MCP_CONFIG" "$MCP_RUNTIME" "$NUM" "$NUM" \
    || gaffer_abort_setup MCP-RENDER "failed to render delivery runtime .mcp.json — refusing live run (fail closed)"
  chmod 600 "$MCP_RUNTIME" 2>/dev/null || true  # carries the live claim token — owner-only
  # ── GOLDEN CAPTURE (runner/CLAUDE.md) ───────────────────────
  # Default-OFF dump of the assembled context (the delivery PROMPT + the rendered
  # MCP runtime config) so the TS renderer (packages/crew/src/runtime/context/)
  # can be byte-compared against this bash path. With GAFFER_CONTEXT_DUMP_ONLY=1
  # the tick additionally exits BEFORE the agent launch (render-only fixture
  # capture: the claim is released back to ready and the EXIT trap tears the
  # worktrees + branch down). Both vars unset ⇒ byte-identical behaviour.
  if [ -n "${GAFFER_CONTEXT_DUMP_DIR:-}" ]; then
    mkdir -p "$GAFFER_CONTEXT_DUMP_DIR" 2>/dev/null || true
    printf '%s' "$PROMPT" > "$GAFFER_CONTEXT_DUMP_DIR/prompt.txt"
    cp -f "$MCP_RUNTIME" "$GAFFER_CONTEXT_DUMP_DIR/mcp-runtime.json"
    if [ "${GAFFER_CONTEXT_DUMP_ONLY:-0}" = "1" ]; then
      gaffer_release_delivery ready "context-dump render-only exit (P1b fixture capture)"
      log "context-dump: wrote prompt + mcp-runtime to $GAFFER_CONTEXT_DUMP_DIR; exiting before agent launch"
      result no_work; exit 0
    fi
  fi
  # Repo-access boundary (FG-007): tell the runtime safety hook the exact set of
  # repos this run may WRITE to (GAFFER_WRITE_ROOTS) and additionally READ from
  # (GAFFER_READ_ROOTS). The hook then deterministically blocks writes/branches
  # outside the write roots and reads outside (write ∪ read) roots — the boundary
  # becomes real enforcement, not prompt text. Roots are newline-separated absolute
  # paths (the format the hook's parser expects). In single-repo / mono-fallback
  # mode WRITE_ROOTS is exactly the one delivery repo and READ_ROOTS is empty, so
  # the hook applies the same single-write-root rule as today.
  # The run log captures any hook BLOCK (stderr → $GAFFER_LOG); we scan that slice
  # afterwards to surface boundary violations (FG-007 AC, best-effort).
  RUN_LOG_MARK="$(wc -l < "$GAFFER_LOG" 2>/dev/null || echo 0)"
  # ── Strict execution mode (OPTIONAL, best-effort OS-level containment) ──────
  # When STRICT_MODE=1 we additionally wrap the live `claude -p` in an OS sandbox
  # PROVIDER (sandbox-exec or docker; a microVM provider is a design sketch) so writes
  # the in-process safety hook can't see (dynamic paths in `python3 -c …`, exec'd
  # children) are refused by the OS, not just by our shell. The provider is fed
  # the SAME write/read roots the safety hook uses. WRAP is a command prefix
  # ("sandbox-exec -f <profile>") or EMPTY (provider none/unsupported → no extra
  # containment; worktree isolation + safety hook still apply). STRICT_MODE=0
  # leaves WRAP empty, so the invocation below is byte-for-byte as before.
  WRAP=""
  # VALIDATION ISOLATION: the DoD gates (tests / typecheck / lint) and the AC check
  # commands run code the agent has just modified — a test file, an import, a config —
  # with the RUNNER's privileges. Sandboxing only `claude -p` left that step bare. The
  # same OS wrap the agent gets is handed to lib/dod.sh (gaffer_dod_run_one) through
  # GAFFER_DOD_WRAP, so under an active provider the gate commands run inside the same
  # container / profile with the same write roots. Empty when no provider wraps the
  # agent (then the gates are only as contained as the agent was — documented in
  # SECURITY.md). GAFFER_DOD_SANDBOX=0 opts a repo out (a gate that cannot run inside
  # the image); the verdict is still recorded by the runner, outside the gate process.
  export GAFFER_DOD_WRAP=""
  # Consult the provider when the sandbox is ON (STRICT_MODE=1) OR REQUIRED
  # (GAFFER_STRICT_REQUIRE — auto-set by every autonomy flag). Gating this on
  # STRICT_MODE alone let `GAFFER_MODE=autonomous` announce "fails closed without an
  # OS sandbox" and then launch uncontained, because nothing here ever asked.
  # THE COMMAND WORKER'S CONTAINMENT RULE, checked before any wrap is composed: its only
  # accepted boundary is the docker sandbox with the host-side MCP bridge (lib/worker.mjs
  # commandContainmentProblem). The seam refuses anything else at the spawn (rc 75);
  # parking HERE keeps that refusal from being counted as a failed delivery attempt.
  if [ "${GAFFER_WORKER_PROVIDER:-claude-code}" = command ] && ! _gaffer_strict_require_opted_out \
     && ! _CMD_WHY="$(SANDBOX_PROVIDER="${SANDBOX_PROVIDER:-sandbox-exec}" node "$RUNNER_DIR/lib/worker.mjs" command-containment 2>/dev/null)"; then
    [ -n "$_CMD_WHY" ] || _CMD_WHY="$(_gaffer_worker_command_refusal_msg none)"
    log "STRICT_REQUIRE: refusing to launch the agent (fail closed, strict_require_unavailable): $_CMD_WHY"
    wg attach-evidence "$NUM" --type manual_note \
      --summary "PARKED (strict_require_unavailable): $_CMD_WHY" >/dev/null 2>&1 || true
    gaffer_release_delivery blocked "GAFFER_WORKER_PROVIDER=command needs the docker sandbox with the MCP bridge — fail closed, agent not launched" strict_require_unavailable
    gaffer_skip_ticket "$NUM"
    result error; exit 0
  fi
  if [ "${STRICT_MODE:-0}" = "1" ] || _sandbox_strict_required; then
    # C4: sandbox_wrap_cmd returns NON-ZERO only when GAFFER_STRICT_REQUIRE=1 and no OS
    # sandbox provider is available — a hard fail-closed: the operator demanded OS
    # containment this host can't supply, so we do NOT launch the agent uncontained.
    if WRAP="$(sandbox_wrap_cmd "$WRITE_ROOTS" "$READ_ROOTS" 2>>"$GAFFER_LOG")"; then
      if [ -n "$WRAP" ]; then
        log "STRICT_MODE active: wrapping live agent via provider '${SANDBOX_PROVIDER:-sandbox-exec}' ($WRAP)"
        case "${GAFFER_DOD_SANDBOX:-1}" in
          0|false|no|off) log "STRICT_MODE: GAFFER_DOD_SANDBOX=0 — DoD gates + AC checks run OUTSIDE the OS sandbox (operator opt-out)" ;;
          *) export GAFFER_DOD_WRAP="$WRAP"
             log "STRICT_MODE: DoD gates + AC checks will run under the same OS sandbox as the agent" ;;
        esac
      else
        log "STRICT_MODE active but provider '${SANDBOX_PROVIDER:-sandbox-exec}' added no OS sandbox — worktree isolation + safety hook still apply"
      fi
    else
      # The command worker has no in-process safety hook, which is WHY the sandbox is
      # required (factory.config.sh defaults GAFFER_STRICT_REQUIRE=1 for it): say so.
      _SR_WHY=""
      [ "${GAFFER_WORKER_PROVIDER:-claude-code}" = command ] \
        && _SR_WHY=" (GAFFER_WORKER_PROVIDER=command has no in-process safety hook, so it needs one: set SANDBOX_PROVIDER=docker with a running daemon, or GAFFER_STRICT_REQUIRE=0 in the environment if the runner is contained out-of-band)"
      log "STRICT_REQUIRE: no OS sandbox provider available on this host — refusing to launch the agent (fail closed)$_SR_WHY"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "PARKED (strict_require_unavailable): GAFFER_STRICT_REQUIRE=1 but no OS sandbox provider is available on this host — the agent was NOT launched (fail closed)$_SR_WHY" >/dev/null 2>&1 || true
      gaffer_release_delivery blocked "GAFFER_STRICT_REQUIRE=1 but no OS sandbox provider available, agent not launched: $(gaffer_sandbox_unavailable_hint ticket)$_SR_WHY" strict_require_unavailable
      gaffer_skip_ticket "$NUM"
      result error; exit 0
    fi
  fi
}

# Pre-spawn budget gate, launch via the worker seam, post-call accounting. Moved verbatim from tick.sh; called from gaffer_tick_delivery_attempts (lib/tick-gates.sh).
gaffer_tick_launch_attempt() {
  # USAGE LEDGER: switch to --output-format json and CAPTURE stdout (the JSON
  # result object) to a temp file so we can ledger the real usage, WITHOUT
  # changing the delivery path — stderr still streams to $GAFFER_LOG, and the
  # agent's text (`.result`) is appended to the log below so the human-readable
  # log is preserved. The agent's actual work is unaffected: it communicates via
  # the MCP servers, and the runner reads ticket state from `wg ticket show`, not
  # from this stdout (which was previously discarded into the log anyway).
  # PRE-SPAWN BUDGET GATE (C3): a ticket whose cumulative measured spend has already
  # reached its ceiling must NOT burn another agent turn — park BEFORE spawning. The
  # post-attempt rework bound below only fires AFTER an attempt has run, so it can't
  # stop the first spawn of a tick for a ticket that already overspent in a prior run.
  if [ "${DRY_RUN:-0}" != "1" ] && gaffer_budget_exhausted "$NUM"; then
    log "BUDGET: #$NUM reached its cost ceiling (spent \$${GAFFER_BUDGET_SPENT} ≥ \$${GAFFER_BUDGET_CEIL}) — NOT spawning another agent turn; parking to blocked (pre-spawn gate)"
    wg attach-evidence "$NUM" --type manual_note \
      --summary "PARKED (budget_exhausted): cumulative spend \$${GAFFER_BUDGET_SPENT} reached the ceiling \$${GAFFER_BUDGET_CEIL} before this attempt — needs a human" >/dev/null 2>&1 || true
    gaffer_release_delivery blocked "cost ceiling reached (spent \$${GAFFER_BUDGET_SPENT} ≥ \$${GAFFER_BUDGET_CEIL}) before spawning — pre-spawn budget gate" budget_exhausted
    gaffer_skip_ticket "$NUM"
    result error; exit 0
  fi
  USAGE_JSON="$GAFFER_DATA/.usage-$NUM.json"; : > "$USAGE_JSON"
  # C1/M2: scrub ambient credentials via an allowlist (env -i) inside worker_deliver.
  # The scrub sits INSIDE the optional OS-sandbox $WRAP so the sandbox still wraps the
  # whole agent; the per-call boundary vars in WORKER_CALL_ENV are layered on top.
  # shellcheck disable=SC2034  # read by worker_deliver (lib/worker.sh)
  WORKER_CALL_ENV=(
    "GAFFER_WRITE_ROOTS=$WRITE_ROOTS" "GAFFER_READ_ROOTS=$READ_ROOTS"
    "GAFFER_DATA=$GAFFER_DATA" "GAFFER_TICKET=$NUM"
    "DISPATCH_DB=$DISPATCH_DB" "MEMORY_DB=$MEMORY_DB"
  )
  # Opt-in per-call dollar cap (GAFFER_MAX_CALL_USD): for a delivery it also carries
  # the ticket's remaining ceiling, so this one call cannot run past it.
  _CALL_BUDGET_ARGS=()
  if [ -n "${GAFFER_MAX_CALL_USD:-}" ]; then
    _CALL_BUDGET="$(gaffer_call_budget_usd "$(gaffer_ticket_budget_remaining "$NUM")")"
    [ -n "$_CALL_BUDGET" ] && _CALL_BUDGET_ARGS=(--max-budget-usd "$_CALL_BUDGET")
  fi
  # What every write repo's refs held at spawn: the branch-switch recovery below only
  # adopts commits the agent made and only deletes a branch the agent created.
  _PRESPAWN_REFS="$(gaffer_snapshot_refs "$WT_ROWS")"
  GAFFER_TICK_TIMEOUT="$_AGENT_TIMEOUT"  # the deadline guard's clamp (attempt 1 only)
  _SKILL_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"  # skill telemetry: tool-ledger rows from here on
  # JOIN KEYS (MF4): the delivery row names its repo and the ticket's risk at call time
  # (shell variables gaffer_usage_record reads; never exported to the agent).
  GAFFER_USAGE_REPO="${_CARD_REPO_NAME:-}"; GAFFER_USAGE_RISK="${ROUTE_RISK:-}"
  # REPLAY MANIFEST (lib/replay-manifest.sh, delta gap 4): right after the stamp below,
  # gaffer_manifest_start opens this attempt's record
  # ($GAFFER_DATA/manifests/<ticket>-<n>.json: repos and base commits, the routing
  # decision, the settings, hashes of the prompt and scout packet, the ledger join key).
  # It is completed where the attempt ends. A measurement; fail-soft; nothing in a DRY_RUN.
  # REWORK COST: stamp this spawn's attempt + start time onto its delivery ledger row
  # (gaffer_usage_record reads both), so spend after a send-back is charged as rework.
  read -r GAFFER_USAGE_ATTEMPT_ID GAFFER_USAGE_STARTED_AT <<<"$(gaffer_delivery_attempt_stamp "$_DELIV_ATTEMPT")" || true
  export GAFFER_USAGE_ATTEMPT_ID GAFFER_USAGE_STARTED_AT
  gaffer_manifest_start "$PROMPT$_REWORK_BLOCK"
  GAFFER_LAUNCH_KIND=delivery worker_deliver "$PRIMARY_REPO" "$PROMPT$_REWORK_BLOCK" "$_ATTEMPT_IMPL_FLAG" "$MCP_RUNTIME" "$USAGE_JSON" "$WRAP" \
    "" ${_CALL_BUDGET_ARGS[@]+"${_CALL_BUDGET_ARGS[@]}"}
  rc=$?
  GAFFER_TICK_TIMEOUT="$_TICK_TIMEOUT_CFG"
  _T_AGENT_DONE="$(date +%s)"
  # SKILL TELEMETRY: record which skills were MOUNTED for this delivery (the mount dir:
  # selection + lenses + universal set) and, best-effort, which were APPLIED — named in
  # the agent's output JSON or opened (tool ledger). Fail-soft; captured here before the
  # ledger removes $USAGE_JSON on either the pause or normal path.
  gaffer_record_skill_usage "$NUM" delivery "${SKILL_STACKS:-$STACK}" "$SKILLS, $LENSES" "$USAGE_JSON" \
    "delivery-$NUM" "$PRIMARY_REPO" "$_SKILL_SINCE"
  # PROVENANCE: which model served this attempt and which CLI ran it, as the ticket's
  # agent-run evidence (the ticket page's attempt history reads it). Fail-soft.
  gaffer_record_agent_run "$NUM" "$USAGE_JSON" "$rc" "$_DELIV_ATTEMPT" "$_MAX_DELIVERY_ATTEMPTS"
  # RESUME REPORT: the resume prompt tells the agent to END its message with the AC ->
  # test lines and the smallest-change note (written for the tokenless resume, whose
  # record_ac_evidence calls are refused; a leased resume's evidence writes now land
  # too). Record that final text as evidence (runner-attributed) so the minimalism gate
  # and the reviewer can read it either way. Fail-soft.
  if [ "$_RESUMING" = "1" ]; then
    gaffer_record_resume_report "$NUM" "$USAGE_JSON" \
      || log "RESUME: could not record the resumed agent's report for #$NUM (continuing)"
  fi
  # ── USAGE WINDOW: a usage-limit / rate-limit refusal is NOT a failed delivery ──
  # The agent was refused by the plan's usage window or a rate limit before it could
  # work (lib/worker.mjs detectUsageLimit — the ONE table of matched strings). Read
  # as a failure it went through the no-commit counter / the rework ladder, burned
  # an attempt every tick until the window reset, and parked good tickets overnight.
  # Instead: record the factory-wide pause ($GAFFER_DATA/usage-pause.json, its end
  # from the reset the CLI printed or GAFFER_USAGE_PAUSE_DEFAULT_MIN), keep whatever
  # the agent made before the refusal (WIP checkpoint; the branch is kept when it has
  # commits and the next delivery builds on it), release the claim to `ready` with
  # reason-code usage_limit (a ticket.usage_limited event) WITHOUT counting an
  # attempt, and stop. Every admission point waits for the pause to end. A resumed
  # delivery goes back to `paused` (worktree kept) for its Continue.
  # rc 1 = an ordinary result (also any failure to CLASSIFY — that runs without the
  # pause lock, so a held lock or a crash cannot fake a refusal); rc 0 = a refusal,
  # pause written; rc 2 = a confirmed refusal whose pause could not be written.
  _UL_REC="$(gaffer_usage_pause_record "$USAGE_JSON" "$NUM" delivery)"; _UL_RC=$?
  if [ "$_UL_RC" != 1 ]; then
    _UL_UNTIL=""; _UL_KIND=""; _UL_MSG=""
    IFS=$'\t' read -r _ _UL_UNTIL _UL_KIND _ _UL_MSG <<<"$_UL_REC"
    _UL_LINE="$(gaffer_usage_pause_active || echo "paused: usage limit")"
    gaffer_usage_record delivery "$NUM" "$rc" "$USAGE_JSON" >>"$GAFFER_LOG" 2>/dev/null || true
    rm -f "$USAGE_JSON"
    gaffer_wip_checkpoint "$WT_ROWS" "$NUM" "$TITLE" \
      && log "USAGE: #$NUM had uncommitted work at the refusal — WIP checkpoint committed on $WORK_BRANCH"
    if [ "$_RESUMING" = "1" ]; then
      gaffer_resume_abort "${_UL_KIND:-usage_limit}: ${_UL_MSG:-refused by the usage window}"
      log "USAGE: resumed #$NUM was refused (${_UL_MSG:-usage limit}) — re-paused with its worktree; $_UL_LINE"
      result usage_paused; exit 0
    fi
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_cleanup_worktrees
      _UL_BRANCH="branch $WORK_BRANCH kept for the next attempt"
    else
      gaffer_cleanup_worktrees drop-branch
      _UL_BRANCH="no work to keep"
    fi
    gaffer_release_delivery ready \
      "usage limit: ${_UL_MSG:-refused by the usage window}; ${_UL_LINE}; not counted as an attempt" \
      usage_limit "" "" "$_UL_UNTIL"
    if [ "$_UL_RC" != 0 ]; then
      # FAIL CLOSED: the pause could not be written, so nothing would stop the next
      # tick re-claiming this ticket straight into the same refusal. Skip it for the
      # rest of this run (the next ticket meets the same refusal and is skipped too).
      gaffer_skip_ticket "$NUM"
      log "USAGE: WARNING — #$NUM was refused by a usage/rate limit but the pause could not be written under $GAFFER_DATA; skipping the ticket for the rest of this run"
    fi
    log "USAGE: #$NUM refused by the model's usage window (${_UL_MSG:-usage limit}) — released to ready without counting an attempt ($_UL_BRANCH); $_UL_LINE"
    result usage_paused; exit 0
  fi
  # ── CLAUDE AUTH: a call that could not authenticate is NOT a failed delivery ──
  # The CLI was logged out or its key rejected ("Invalid API key · Please run /login";
  # lib/worker.mjs detectAuthError, error envelopes only), so the agent never worked.
  # Read as a failure it counted toward the no-commit park and GAFFER_MAX_DELIVERY_
  # ATTEMPTS, and three runs parked a good ticket (exploratory finding fresh-user/F-06).
  # Release the claim to `ready` WITHOUT counting an attempt (the branch kept only when
  # it already had commits), say how to log in, and report auth_error: loop.sh and
  # worker.sh stop the run there. A resumed delivery goes back to `paused`.
  _AUTH_MSG=""
  if [ "${DRY_RUN:-0}" != "1" ] && [ -f "$USAGE_JSON" ] \
     && _AUTH_MSG="$(node "$RUNNER_DIR/lib/worker.mjs" parse-result auth-error --json-file "$USAGE_JSON" 2>/dev/null)"; then
    gaffer_usage_record delivery "$NUM" "$rc" "$USAGE_JSON" >>"$GAFFER_LOG" 2>/dev/null || true
    rm -f "$USAGE_JSON"
    _AUTH_HINT="$(gaffer_claude_auth_hint 2>/dev/null || echo 'claude is not logged in: run `claude /login`')"
    if [ "$_RESUMING" = "1" ]; then
      gaffer_resume_abort "claude_auth: ${_AUTH_MSG:-authentication failed}"
      log "AUTH: resumed #$NUM could not authenticate (${_AUTH_MSG:-authentication failed}) — re-paused with its worktree; $_AUTH_HINT"
      result auth_error; exit 0
    fi
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_cleanup_worktrees
    else
      gaffer_cleanup_worktrees drop-branch
    fi
    gaffer_release_delivery ready "claude could not authenticate: ${_AUTH_MSG:-authentication failed}; not counted as an attempt" claude_auth
    log "AUTH: #$NUM — ${_AUTH_MSG:-authentication failed}: $_AUTH_HINT; released to ready without counting an attempt"
    result auth_error; exit 0
  fi
  # ── BUDGET ADMISSION REFUSED: no agent was spawned, so it is not an attempt ──
  # worker_deliver asks lib/budget-admission.mjs right before the launch; a refusal
  # (a daily or lifetime cap reached since the run admitted this tick, a rework attempt
  # past it, no dollar cap at all on a tick run by hand) returns 77 with nothing spent.
  # Read as a failure it counted a no-commit failure and parked a good ticket. Release
  # it to `ready` uncounted (the branch kept only with commits), skip it for this run,
  # and report no_work: nothing was spent, and the loop's own cap check ends the run.
  if [ "${DRY_RUN:-0}" != "1" ] && [ "${WORKER_LAST_BUDGET_REFUSED:-0}" = 1 ]; then
    rm -f "$USAGE_JSON"
    if [ "$_RESUMING" = "1" ]; then
      gaffer_resume_abort "budget_refused: the paid launch was refused by the budget admission"
      log "BUDGET: resumed #$NUM — the paid launch was refused by the budget admission (see the line above) — re-paused with its worktree"
      result no_work; exit 0
    fi
    if gaffer_any_branch_has_commits "$WT_ROWS"; then
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_cleanup_worktrees
    else
      gaffer_cleanup_worktrees drop-branch
    fi
    gaffer_release_delivery ready "the paid delivery launch was refused by the budget admission (no agent ran); not counted as an attempt" budget_refused
    gaffer_skip_ticket "$NUM"
    log "BUDGET: #$NUM — the paid delivery launch was refused by the budget admission (see the line above); released to ready without counting an attempt"
    result no_work; exit 0
  fi
  # ── GUARD C: PAUSE-ON-CAP detection (BEFORE the ledger removes the JSON) ─────
  # If the agent hit the TURN cap (num_turns at/over the cap, or a max-turns stop
  # reason) OR the BUDGET cap (GAFFER_BUDGET_REMAINING exhausted) mid-delivery AND it
  # produced ≥1 commit, the work is incomplete but salvageable: do NOT silent-fail or
  # tear it down. PAUSE IN PLACE — keep the worktree + branch (committed AND
  # uncommitted work) ALIVE, set the ticket `paused` with the durable resume context,
  # notify the human gate (spend + dashboard URL, via the dispatch notifier), and stop
  # the tick cleanly with NO teardown and NO auto-retry. A human's one-click Continue
  # re-enters the SAME worktree; Stop tears it down + abandons. A cap-hit with NO
  # commit is an empty/unrecoverable delivery and falls through to the normal empty
  # path below (no false pause of a worktree with nothing in it).
  _CAP_HIT=0
  if gaffer_is_cap_hit "$USAGE_JSON" "$rc"; then _CAP_HIT=1; fi
  # WASTE CONTROL: the wall-clock kill (rc 124) used to be a plain failure — the work
  # on the branch survived but the attempt was burned and the retry started over. It is
  # now pause-eligible like a turn cap: the human sees WHY and presses Continue.
  _TIMEOUT_HIT=0
  [ "$rc" = "124" ] && _TIMEOUT_HIT=1
  # Budget is the HARD ceiling: if the live USD headroom is exhausted, pause even when
  # the turn cap wasn't reached, so the factory never silently keeps spending past it.
  # B28(b): GAFFER_BUDGET_REMAINING was summed from the ledger when this tick was
  # sourced — BEFORE this delivery spent. Its own measured spend is not in the ledger
  # yet (gaffer_usage_record runs below), so subtract it here: the pause sees the
  # headroom as it stands AFTER this call, not as it stood before it. A non-numeric
  # spend ("unknown") coerces to 0 in awk, i.e. the pre-call figure (never a crash).
  _BUDGET_HIT=0
  _LIVE_REMAINING="${GAFFER_BUDGET_REMAINING:-}"
  if [ -n "$_LIVE_REMAINING" ]; then
    _LIVE_REMAINING="$(awk -v r="$_LIVE_REMAINING" -v s="$(gaffer_delivery_spend "$USAGE_JSON")" \
      'BEGIN{r+=0; s+=0; d=r-s; if (d<0) d=0; printf "%.6f", d}' 2>/dev/null || printf '%s' "$_LIVE_REMAINING")"
  fi
  if [ -n "$_LIVE_REMAINING" ] && _num_le "$_LIVE_REMAINING" 0; then
    _BUDGET_HIT=1
  fi
  # The call stopped on its own per-call dollar cap (--max-budget-usd): a budget pause,
  # never a turn-cap one, so a Continue is not misread as "it needs more turns". On a
  # Continue the pre-spawn gate re-checks the ticket's ceiling and parks it
  # (budget_exhausted) when that is what ran out, instead of respawning into $0.
  if gaffer_is_budget_stop "$USAGE_JSON"; then _BUDGET_HIT=1; fi
  # WASTE CONTROL: a cap that lands before the agent's first commit used to mean no
  # pause (nothing on the branch to keep) and a from-scratch retry. Checkpoint the
  # uncommitted work first, so the pause below has commits to preserve.
  if { [ "$_CAP_HIT" = "1" ] || [ "$_BUDGET_HIT" = "1" ] || [ "$_TIMEOUT_HIT" = "1" ]; } \
     && [ "${GAFFER_PAUSE_ON_CAP:-1}" = "1" ]; then
    if gaffer_wip_checkpoint "$WT_ROWS" "$NUM" "$TITLE"; then
      log "CAP: #$NUM had uncommitted work at the cap — WIP checkpoint committed on $WORK_BRANCH so the pause keeps it"
    fi
  fi
  if { [ "$_CAP_HIT" = "1" ] || [ "$_BUDGET_HIT" = "1" ] || [ "$_TIMEOUT_HIT" = "1" ]; } \
     && [ "${GAFFER_PAUSE_ON_CAP:-1}" = "1" ] \
     && gaffer_any_branch_has_commits "$WT_ROWS"; then
    _CAP_SPEND="$(gaffer_delivery_spend "$USAGE_JSON")"
    _CAP_TURNS="$(gaffer_cap_num_turns "$USAGE_JSON")"
    _PAUSE_REASON="cap_hit"
    [ "$_TIMEOUT_HIT" = "1" ] && _PAUSE_REASON="timeout"
    [ "$_BUDGET_HIT" = "1" ] && _PAUSE_REASON="budget_cap"
    gaffer_manifest_finish "paused:$_PAUSE_REASON" "$rc"
    gaffer_usage_record delivery "$NUM" "$rc" "$USAGE_JSON" "" "$_DELIV_ATTEMPT" >>"$GAFFER_LOG" 2>/dev/null || true
    rm -f "$USAGE_JSON"
    # Serialise the full worktree map (one entry per write repo) so a multi-repo
    # delivery resumes EVERY worktree, not just the primary. WT_ROWS is the runner's
    # TSV: rid \t rname \t rpath \t rbase \t rwt.
    _WT_JSON="$(printf '%s\n' "$WT_ROWS" | gaffer_json worktree-rows-json 2>/dev/null || echo '[]')"
    log "CAP: #$NUM hit the ${_PAUSE_REASON} cap mid-delivery (turns=${_CAP_TURNS:-?}, spend=${_CAP_SPEND}) — PAUSING in place; worktree + branch $WORK_BRANCH kept alive for one-click Continue"
    # Pause the delivery: transition the ticket to `paused`, persist the resume
    # context (branch, primary worktree, full worktree map, repo, attempt, turns,
    # spend), and notify the human gate (the dispatch notifier carries spend +
    # dashboard URL; GAFFER_NOTIFY_REDACT honoured at the dispatch layer).
    if wg ticket pause "$NUM" --reason "$_PAUSE_REASON" \
        --branch "$WORK_BRANCH" --worktree "$PRIMARY_REPO" \
        --worktrees-json "$_WT_JSON" --repo "${REPO_PATH:-}" \
        --attempt "$_DELIV_ATTEMPT" \
        ${_CAP_TURNS:+--turns "$_CAP_TURNS"} --spend "$_CAP_SPEND" >/dev/null 2>&1; then
      log "CAP: paused #$NUM (-> paused) — resume context persisted, human gate notified"
    else
      log "CAP: WARNING — could not pause #$NUM via dispatch; worktree is still kept alive (KEEP flag set) — needs a human"
    fi
    # THE CRUX: keep the worktree alive past this tick's normal end-of-run cleanup AND
    # any crash/signal. Raise the retention flag so the EXIT/INT/TERM trap's
    # gaffer_crash_cleanup becomes a complete no-op for this paused ticket; do NOT call
    # gaffer_cleanup_worktrees here. The worktree survives for the resume.
    GAFFER_PAUSE_KEEP_WORKTREE=1
    gaffer_skip_ticket "$NUM"
    log "delivery PAUSED (cap-hit) for #$NUM — worktree + branch $WORK_BRANCH PRESERVED for one-click resume"
    result paused; exit 0
  fi
  # Ledger the call (best-effort, swallowed) and append the agent's text to the log.
  # Capture the attempt's REAL spend before the envelope is removed — the eval
  # judge attaches it to the quality record at submit time (cost-per-pass metric).
  _DELIVERY_SPEND_USD="$(gaffer_delivery_spend "$USAGE_JSON" 2>/dev/null || true)"
  gaffer_usage_record delivery "$NUM" "$rc" "$USAGE_JSON" "" "$_DELIV_ATTEMPT" >>"$GAFFER_LOG" 2>/dev/null || true
  rm -f "$USAGE_JSON"
  GAFFER_USAGE_ATTEMPT_ID=""; GAFFER_USAGE_STARTED_AT=""; GAFFER_USAGE_REPO=""; GAFFER_USAGE_RISK=""
  log "delivery tick for #$NUM finished (rc=$rc)"

  # FG-007 AC ("Dispatch event log records attempted boundary violations"):
  # best-effort. The deterministic boundary lives in the safety hook, which logs
  # every denial as "BLOCKED by gaffer safety hook: …" to stderr → $GAFFER_LOG. If
  # the slice for THIS run contains a write/branch boundary block, record a
  # manual_note on the ticket so the violation is visible in Dispatch's event
  # log. NEVER fatal: if recording is awkward/unavailable we log it as a soft
  # follow-up and carry on (do not fail the build over it).
  VIOLATIONS="$(tail -n "+$((RUN_LOG_MARK + 1))" "$GAFFER_LOG" 2>/dev/null \
    | grep -iE 'BLOCKED by gaffer safety hook:.*(write outside write-roots|branch creation outside write-roots|read outside allowed roots)' \
    | head -5 || true)"
  if [ -n "$VIOLATIONS" ]; then
    log "FG-007: boundary violation(s) BLOCKED during #$NUM — recording a Dispatch note"
    if wg attach-evidence "$NUM" --type manual_note \
         --summary "FG-007 boundary violation(s) blocked by the safety hook during delivery:"$'\n'"$VIOLATIONS" >/dev/null 2>&1; then
      log "FG-007: recorded boundary-violation note on #$NUM"
    else
      log "FG-007: could not record boundary-violation note on #$NUM (soft follow-up) — violations were: $VIOLATIONS"
    fi
  fi
}
