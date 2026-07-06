# Gaffer intake-clarify pass — extracted from tick.sh (B-H3: paying down the
# monolith). This file is sourced by tick.sh; the body runs VERBATIM as it did
# inline — only relocated into a function so tick.sh can invoke it at the same
# point in the no-ready-work flow. When it clarifies a draft it exits the tick;
# otherwise it returns and tick.sh continues to the maintenance/idle lanes. Relies
# on tick.sh runtime globals (log, wg, jget, result, worker_deliver, the trap
# helpers gaffer_on_exit/gaffer_on_signal/gaffer_crash_cleanup, _gaffer_sed_repl,
# …) which are all defined before the call site executes.
# shellcheck shell=bash
# shellcheck disable=SC2154  # globals provided by tick.sh at call time

_gaffer_clarify_pass() {
# ── Intake clarify gate ──────────────────────────────────────────────────────
# The clarify skill turns an ambiguous DRAFT into well-specified work, but it
# isn't self-running. Wire it here: with nothing ready to deliver, route the next
# un-clarified DRAFT through a headless clarify pass BEFORE any human marks it
# ready. Clarify finds the load-bearing ambiguities, files them as acceptance
# criteria (or escalates a genuine decision / blocks on an open question) and
# NEVER marks the ticket ready itself — so a draft cannot reach `ready` while
# load-bearing ambiguity remains. Clarify is read-only on the repo (it only
# writes via the Dispatch/Memory MCP servers), so no worktree/branch is
# needed. A per-run skip file (cleared each run by loop.sh) gives each draft one
# clarify attempt per run so a tick can't re-clarify the same draft forever.
# OFF BY DEFAULT: clarifying drafts spends tokens on every idle tick, so the gate is
# opt-in. Set CLARIFY_DRAFTS_WHEN_IDLE=1 to have idle ticks clarify un-specified drafts.
# Default keeps an idle factory at ~0 token cost (it just polls + stops).
DRAFT_JSON="$(wg ticket list -s draft 2>/dev/null || echo '[]')"
DRAFT_COUNT="$(echo "$DRAFT_JSON" | jget 'len(d)' 2>/dev/null || echo 0)"
if [ "${CLARIFY_DRAFTS_WHEN_IDLE:-0}" = "1" ] && [ "${DRAFT_COUNT:-0}" -gt 0 ]; then
  CLARIFIED_FILE="$GAFFER_DATA/.clarified-tickets"; touch "$CLARIFIED_FILE"
  # FINDING B-M2: pass the skip-file path via the environment, not interpolated into
  # the single-quoted Python literal — a path containing a `'` would break the string
  # (silent parse failure → the clarified-skip set is lost and the draft re-clarifies).
  CNUM="$(echo "$DRAFT_JSON" | _GF_SKIP_FILE="$CLARIFIED_FILE" python3 -c "import sys,json,os; skip=set(open(os.environ['_GF_SKIP_FILE']).read().split()); c=[str(t['number']) for t in json.load(sys.stdin) if str(t['number']) not in skip]; print(c[0] if c else '')" 2>/dev/null)"
  if [ -n "$CNUM" ]; then
    CSHOW="$(wg ticket show "$CNUM" 2>/dev/null)"
    CREPO="$(echo "$CSHOW" | jget "(d['repositories'][0]['local_path'] if d['repositories'] else '') or ''" 2>/dev/null)"
    CTITLE="$(echo "$CSHOW" | jget "d['ticket']['title']" 2>/dev/null || echo '')"
    if [ -n "$CREPO" ] && [ -d "$CREPO" ]; then
      log "no ready tickets → intake: clarifying draft #$CNUM ('$CTITLE') in $CREPO"
      if [ "$DRY_RUN" = "1" ]; then
        log "DRY_RUN: would run a clarify pass (clarify skill) on draft #$CNUM — files ACs / escalates decisions; never marks it ready"
        result clarified; exit 0
      fi
      [ -f "$RUNNER_DIR/safety-hook.mjs" ] || { log "SAFETY: hook missing — refusing live clarify (fail closed)"; result error; exit 1; }
      # BUG 2 fix: remove injected runner config from the clarify repo on exit
      # (success OR failure / crash) so the real repo is always left clean.
      _clarify_cleanup() {
        rm -f "$CREPO/CLAUDE.factory.md"
        rm -f "$CREPO/.claude/settings.json"
        rm -f "$CREPO/.claude/skills"
        rmdir "$CREPO/.claude" 2>/dev/null || true
        gaffer_skills_mount_cleanup "clarify-$CNUM"
      }
      # FINDING B-H1: install EXIT *and* signal traps (mirroring the reviewer block).
      # Clarify injects runner config directly into the contributor's REAL repo (no
      # throwaway worktree — clarify is read-only), and gaffer_crash_cleanup does NOT
      # know about that injected config. With only an EXIT trap, a Ctrl-C/SIGTERM was
      # caught by the GLOBAL INT/TERM handler (gaffer_on_signal), which clears the EXIT
      # trap FIRST and then runs gaffer_crash_cleanup — so _clarify_cleanup never fired
      # and CLAUDE.factory.md / .claude/settings.json / .claude/skills leaked into the
      # real repo. Each handler clears all three traps (no re-entry), runs the clarify
      # cleanup, then chains the global crash cleanup and exits with the right code.
      _clarify_on_exit() { local rc=$?; trap - EXIT INT TERM; _clarify_cleanup; gaffer_crash_cleanup; exit "$rc"; }
      _clarify_on_int()  { trap - EXIT INT TERM; _clarify_cleanup; gaffer_crash_cleanup; exit 130; }
      _clarify_on_term() { trap - EXIT INT TERM; _clarify_cleanup; gaffer_crash_cleanup; exit 143; }
      trap _clarify_on_exit EXIT
      trap _clarify_on_int  INT
      trap _clarify_on_term TERM
      # Mount only the clarify-relevant + universal skill subset (not all ~66).
      gaffer_skills_mount "$CREPO" "clarify, record-evidence" "clarify-$CNUM"
      sed "s#\${RUNNER_DIR}#$(_gaffer_sed_repl "$RUNNER_DIR")#g" "$CLAUDE_SETTINGS" > "$CREPO/.claude/settings.json"
      gaffer_trust_workspace "$CREPO"
      MCP_RUNTIME="$GAFFER_DATA/mcp-runtime.$$.json"
      gaffer_assert_db_vars || { log "DB-VARS: DISPATCH_DB/MEMORY_DB empty — refusing live clarify (fail closed)"; result error; exit 1; }
      # Reviewer/clarify agents hold no delivery claim, so GAFFER_CLAIM_TOKEN is
      # substituted EMPTY (the MCP server treats "" as "no token"). Substituting it
      # strips the placeholder so the literal ${GAFFER_CLAIM_TOKEN} never leaks in.
      sed -e "s#\${DISPATCH_DB}#$(_gaffer_sed_repl "$DISPATCH_DB")#g" -e "s#\${MEMORY_DB}#$(_gaffer_sed_repl "$MEMORY_DB")#g" -e "s#\${DISPATCH_MCP_BIN}#$(_gaffer_sed_repl "$DISPATCH_MCP_BIN")#g" -e "s#\${MEMORY_MCP_BIN}#$(_gaffer_sed_repl "$MEMORY_MCP_BIN")#g" -e "s#\${GAFFER_CLAIM_TOKEN}#$(_gaffer_sed_repl "$CLAIM_TOKEN")#g" "$MCP_CONFIG" > "$MCP_RUNTIME"
      cp -f "$HERE/claude/CLAUDE.md" "$CREPO/CLAUDE.factory.md"
      # File-card context for the intake agent — orients it on the repo before
      # it reads the ticket and spots ambiguities. FAIL-SOFT via gaffer_prime_context_block.
      _CDESC="$(echo "$CSHOW" | jget "(d['ticket'].get('description') or '')[:400]" 2>/dev/null || echo '')"
      _CLARIFY_CARDS="$(gaffer_prime_context_block "$CREPO" "$(basename "$CREPO")" \
        "$(printf '%s %s' "$CTITLE" "$_CDESC")" 2>/dev/null || true)"
      read -r -d '' CPROMPT <<EOF || true
You are an INTAKE agent — do NOT implement anything and do NOT write code. Use the
clarify skill on DRAFT ticket #$CNUM: call get_ticket (dispatch) and search_lore
(memory), read the repo read-only, then find the load-bearing ambiguities (the
gaps whose answer would change the implementation, scope, or acceptance). For each,
either add_acceptance_criterion (a knowable answer or noted sane default) or
request_decision (a genuine unmade decision). NEVER mark the ticket ready and never
guess past a real ambiguity — if one stays unresolved, mark_ticket_blocked with the
open question. Work only in: $CREPO
EOF
      CPROMPT="${CPROMPT}${_CLARIFY_CARDS}"
      C_USAGE_JSON="$GAFFER_DATA/.usage-$CNUM.json"; : > "$C_USAGE_JSON"
      # C1/M2: scrub ambient credentials from the clarify agent's env (allowlist)
      # inside worker_deliver; the per-call vars in WORKER_CALL_ENV layer on top.
      WORKER_CALL_ENV=(
        "GAFFER_WRITE_ROOTS=$CREPO"
        "DISPATCH_DB=$DISPATCH_DB" "MEMORY_DB=$MEMORY_DB"
      )
      worker_deliver "$CREPO" "$CPROMPT" "$GAFFER_PLAN_MODEL_FLAG" "$MCP_RUNTIME" "$C_USAGE_JSON"
      crc=$?
      gaffer_usage_record clarify "$CNUM" "$crc" "$C_USAGE_JSON" >>"$GAFFER_LOG" 2>/dev/null || true
      rm -f "$C_USAGE_JSON"
      _gaffer_locked .skip.lock _gaffer_append_line "$CLARIFIED_FILE" "$CNUM"
      log "clarify pass for draft #$CNUM finished (rc=$crc)"
      # Normal completion: run cleanup once, then RESTORE the global traps (mirroring
      # the reviewer block) so the subsequent exit runs under the standard handlers and
      # our clarify-scoped EXIT/INT/TERM handlers can't re-fire.
      _clarify_cleanup
      trap gaffer_on_exit EXIT
      trap 'gaffer_on_signal 130' INT
      trap 'gaffer_on_signal 143' TERM
      result clarified; exit 0
    fi
  fi
fi
}
