#!/usr/bin/env bash
# runner/lib/tick-bootstrap.sh
# The greenfield create-a-repo delivery of a bootstrap ticket: its own path from the
# claim to the submit (the repo is created, delivered into, gated, registered, onboarded).
#
# Sourced by runner/tick.sh only (required there: a missing file fails the tick
# closed). Function definitions only, so sourcing it runs nothing. Every body was
# moved verbatim out of tick.sh; the functions read and write tick.sh's globals
# (NUM, SHOW, WT_ROWS, CLAIM_TOKEN, ...) exactly as the inline code did, and the
# gaffer_tick_* / _gaffer_idle_* wrappers declare no locals, so every assignment in
# them stays global. See runner/CLAUDE.md for the map of the tick phases.

# A bootstrap ticket is delivered here and the tick exits. Moved verbatim from tick.sh; called from tick.sh.
gaffer_tick_bootstrap() {
  if [ "$IS_BOOTSTRAP" = "1" ]; then
    B_NAME="$(gaffer_bootstrap_repo_name "$SHOW")"
    if [ -z "$B_NAME" ]; then
      log "BOOTSTRAP: #$NUM is marked bootstrap but no target repo name could be derived — leaving for a human"
      gaffer_release_delivery ready "bootstrap: no target repo name — leaving for a human"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi
    B_DIR="$(gaffer_bootstrap_repo_dir "$B_NAME")" || B_DIR=""
    if [ -z "$B_DIR" ]; then
      log "BOOTSTRAP: #$NUM target repo name '$B_NAME' is unsafe (path traversal) — refusing"
      gaffer_release_delivery ready "bootstrap: unsafe target repo name — refusing"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi
    # SELF-OPERATION BAN (greenfield): a bootstrap target that would land IN a
    # Gaffer component must be refused too — same override, same set-aside.
    if [ "${GAFFER_ALLOW_SELF_DELIVERY:-0}" != "1" ] && gaffer_is_self_target "$B_DIR"; then
      log "SELF-OP: refusing bootstrap #$NUM — target '$B_DIR' is (or is inside) a Gaffer component; the factory must not scaffold over its own source. Set GAFFER_ALLOW_SELF_DELIVERY=1 to override (first-party dogfooding only)."
      wg attach-evidence "$NUM" --type manual_note \
        --summary "SELF-OP BAN: refused bootstrap — target '$B_DIR' is a Gaffer component (factory's own source). Override with GAFFER_ALLOW_SELF_DELIVERY=1." >/dev/null 2>&1 || true
      # RUNNER-OWNED-BOOKKEEPING: the runner holds the claim now, so release it first
      # (claimed → ready), THEN un-ready (ready -> draft) so the loop won't re-select it.
      gaffer_release_delivery ready "self-op: bootstrap target is a Gaffer component"
      wg ticket move "$NUM" draft --as system >/dev/null 2>&1 || true
      gaffer_skip_ticket "$NUM"
      log "SELF-OP: set aside bootstrap #$NUM for a human (released claim + un-readied ready→draft + skipped this run)"
      result no_work; exit 0
    fi
    if ! B_REFUSE="$(gaffer_bootstrap_target_ok "$B_DIR")"; then
      log "BOOTSTRAP: #$NUM refused — $B_REFUSE"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "BOOTSTRAP REFUSED: $B_REFUSE" >/dev/null 2>&1 || true
      gaffer_release_delivery ready "bootstrap refused: $B_REFUSE"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi
    log "ready=$READY_COUNT → BOOTSTRAP #$NUM ('$TITLE') → create new repo '$B_NAME' at $B_DIR [stack=$STACK]"

    # Recommended skills for the bootstrap: the BOOTSTRAP ROLE profile (`--role
    # bootstrap`) — the normal delivery selection plus the scaffold packs a fresh repo
    # needs (ci-cd-pipeline, docker-development, shell-scripting, the quality lens). A
    # greenfield agent used to get the plain delivery selection, so CI / Docker guidance
    # only reached it when the brief happened to name them.
    # Derive an area from the stack where unambiguous so area-gated packs (FIX-2)
    # still fire for a clearly-domained stack (e.g. a web stack → frontend pack).
    # B30: hand the selector the ticket's title + description head too (`--text`),
    # exactly as the delivery path does — a bootstrap brief that plainly calls for
    # an off-domain pack (a CLI tool, a Terraform module, a docs site) was otherwise
    # unreachable, since the bootstrap passed no text and matched on stack alone.
    # An argv, never a shell string: the untrusted text cannot inject flags.
    B_AREA="$(gaffer_area_for_stack "$STACK")"
    _B_SKILL_TEXT="$(printf '%s\n%s' "${TITLE:-}" "$(echo "$SHOW" | jget '(d.ticket.description || "").slice(0, 600)' 2>/dev/null || true)")"
    B_SKILLS="$(node "$HERE/bin/select-skills.mjs" --role bootstrap --stack "$STACK" ${B_AREA:+--area "$B_AREA"} --text "$_B_SKILL_TEXT" --skills-dir "$SKILLS_DIR" 2>/dev/null || true)"
    [ -n "$B_SKILLS" ] || B_SKILLS="(scaffold the stack from the ticket's ACs)"

    if [ "$DRY_RUN" = "1" ]; then
      log "DRY_RUN: BOOTSTRAP would mkdir + git init $B_DIR with a baseline README commit on main, then branch gaffer/ticket-$NUM-<slug> and run the delivery agent there to scaffold the stack ON THE BRANCH"
      log "DRY_RUN: BOOTSTRAP would export GAFFER_BOOTSTRAP_INSTALL=1 GAFFER_BOOTSTRAP_DIR=$B_DIR so the safety hook permits the FIRST install in the fresh dir only"
      log "DRY_RUN: BOOTSTRAP would assert delivery hygiene (oversized minimalism EXEMPTED for a fresh scaffold), record the smallest-change note, record the delivery branch_name, then register+onboard $B_NAME + submit via the NORMAL claim-gated lane (→ in_review)"
      result worked; exit 0
    fi

    # Fail closed: never run a live agent without the deterministic safety hook.
    gaffer_assert_safety_hook || gaffer_abort_setup SAFETY "refusing live bootstrap (fail closed)"

    # SANDBOX REQUIREMENT, before anything is created. Under GAFFER_STRICT_REQUIRE (every
    # autonomy flag defaults it) the worker seam refuses to spawn without an OS sandbox.
    # Asked only there, the bootstrap had already git-init'd the new repo and parked as a
    # generic "bootstrap failed (rc=75)". Ask the provider now, and park the way a normal
    # delivery does, with the fix on the card. The wrap files a docker/sandbox-exec probe
    # writes carry this tick's PID, so the exit cleanup sweeps them.
    if _sandbox_strict_required && ! sandbox_wrap_cmd "$B_DIR" "" >/dev/null 2>>"$GAFFER_LOG"; then
      _B_SBX_WHY="$(gaffer_sandbox_unavailable_hint)"
      log "STRICT_REQUIRE: bootstrap #$NUM parked before creating $B_DIR — $_B_SBX_WHY"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "PARKED (strict_require_unavailable): $_B_SBX_WHY" >/dev/null 2>&1 || true
      gaffer_release_delivery blocked "$_B_SBX_WHY" strict_require_unavailable
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi

    # EXECUTION PREFLIGHT (lib/registry-probe.sh): the bootstrap's one permitted
    # install needs the package registry from INSIDE the agent's allowlisted env.
    # Probe it there first — bounded, no model call. A dead registry used to surface
    # only as the agent's npm retrying TLS failures until the 30-min tick timeout,
    # parked as a generic "timeout" (seen live). Clearly non-node stacks skip it.
    _B_OFFLINE_NOTE=""
    case "$(printf '%s' "${STACK:-}" | tr '[:upper:]' '[:lower:]')" in
      python*|go|golang|rust|java|kotlin|ruby|dotnet|csharp|php|elixir|swift|c|cpp|terraform|shell|bash) ;;
      *)
        if declare -F gaffer_registry_probe >/dev/null 2>&1; then
          _PROBE_RC=0; gaffer_registry_probe || _PROBE_RC=$?
          if [ "$_PROBE_RC" -eq 3 ]; then
            # Offline, but the agent's npm cache is warm: go ahead and install from it
            # (the npm_config_ prefix carries this into the agent's env).
            export npm_config_prefer_offline=true
            log "BOOTSTRAP: #$NUM the npm registry is unreachable (${GAFFER_REGISTRY_PROBE_CODE:-offline}) but the npm cache at ${GAFFER_REGISTRY_PROBE_CACHE:-?} is warm — going ahead offline (npm_config_prefer_offline=true)"
            # Said on the card too, and on any park below: a package the cache does not
            # hold fails the install with the same offline error, and that is the cause.
            _B_OFFLINE_NOTE="the npm registry was unreachable (${GAFFER_REGISTRY_PROBE_CODE:-offline}), so this bootstrap installed offline from the npm cache at ${GAFFER_REGISTRY_PROBE_CACHE:-?}; a package that cache does not hold cannot install: connect to the registry (or warm the cache) and move #$NUM back to ready"
            wg attach-evidence "$NUM" --type manual_note \
              --summary "OFFLINE INSTALL: $_B_OFFLINE_NOTE" >/dev/null 2>&1 || true
          fi
          if [ "$_PROBE_RC" -eq 1 ]; then
            _PROBE_WHY="environment: the npm registry is unreachable from the agent env (${GAFFER_REGISTRY_PROBE_CODE:-unknown}) — $(gaffer_registry_probe_hint "${GAFFER_REGISTRY_PROBE_CODE:-}")${GAFFER_REGISTRY_PROBE_NOTE:+; $GAFFER_REGISTRY_PROBE_NOTE}. No model call was spent; fix the environment (runner/preflight.sh runs the same probe) and move #$NUM back to ready."
            log "BOOTSTRAP: #$NUM parked before spawning — $_PROBE_WHY${GAFFER_REGISTRY_PROBE_DETAIL:+ [$GAFFER_REGISTRY_PROBE_DETAIL]}"
            wg attach-evidence "$NUM" --type manual_note \
              --summary "ENVIRONMENT: $_PROBE_WHY" >/dev/null 2>&1 || true
            gaffer_release_delivery blocked "$_PROBE_WHY" env_registry_unreachable
            gaffer_skip_ticket "$NUM"; result error; exit 0
          fi
        fi ;;
    esac

    # BUDGET ADMISSION, before anything is created. worker_deliver asks it again right
    # before the launch (lib/worker.sh); asked only there, a refused bootstrap had
    # already git-init'd the new repo and parked as "bootstrap failed (rc=77)". Asked
    # here too, a cap that is already spent releases the ticket to ready, uncounted and
    # with nothing made, the same way a refused delivery launch is released.
    if [ "${GAFFER_WORKER_PROVIDER:-claude-code}" = "claude-code" ] \
       && declare -F gaffer_paid_launch_admitted >/dev/null 2>&1 \
       && ! gaffer_paid_launch_admitted bootstrap; then
      gaffer_release_delivery ready "the paid bootstrap launch was refused by the budget admission (no agent ran, nothing created); not counted as an attempt" budget_refused
      gaffer_skip_ticket "$NUM"
      log "BUDGET: bootstrap #$NUM — the paid launch was refused by the budget admission (see the line above); released to ready before creating $B_DIR, not counted as an attempt"
      result no_work; exit 0
    fi

    # Create + init the new repo dir WITH a baseline README commit on `main` (repo
    # display name + the ticket's intent). A failure here leaves no half-made repo.
    if ! gaffer_bootstrap_init "$B_DIR" "$B_NAME" "$TITLE"; then
      log "BOOTSTRAP: #$NUM could not mkdir/git-init $B_DIR — failing"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi

    # Capture the repo's DEFAULT branch (`main`, where the baseline lives) from the
    # freshly-baselined repo — used as the onboard branch + the diff/review base.
    # gaffer_bootstrap_base_branch reads `symbolic-ref --short HEAD` (a clean "main",
    # never the "HEAD\nmain" garbage `rev-parse --abbrev-ref … || echo main` yields on an
    # unborn repo — see the greenfield E2E regression test) — captured HERE, BEFORE we
    # branch off below — and on a RESUME, where HEAD is already the prior attempt's
    # gaffer/ticket-N-… branch, resolves the real base (main) instead of the delivery
    # branch itself (which made the scaffold check below compare HEAD with HEAD and
    # park a complete scaffold as "no scaffold commit").
    B_DEFAULT_BRANCH="$(gaffer_bootstrap_base_branch "$B_DIR")"
    # DELIVER LIKE EVERY OTHER TICKET: create + check out the SAME `gaffer/ticket-N-<slug>`
    # branch shape a normal delivery uses (shared gaffer_ticket_slug), so the scaffold
    # lands on a branch the agent reviewer can diff against `main` and auto-approve+merge
    # — NOT straight onto `main` (which left the reviewer with no branch to review). -B is
    # idempotent on a resume (re-points the branch at the baseline). The agent then commits
    # on the current branch (its prompt already says "commit on the current branch").
    B_SLUG="$(gaffer_ticket_slug "$TITLE")"
    B_WORK_BRANCH="gaffer/ticket-$NUM-$B_SLUG"
    # WASTE CONTROL: on a RESUME the branch may already carry a prior attempt's scaffold
    # commits (auto-committed or the agent's own). `checkout -B` re-points it at HEAD
    # (main after the post-onboard checkout) and silently discards them — a live run
    # lost a complete scaffold that way and paid for it again. Re-enter the existing
    # branch unless GAFFER_RETRY_FRESH_BRANCH=1 asks for the clean-slate reset.
    _B_KEPT=0
    if [ "${GAFFER_RETRY_FRESH_BRANCH:-0}" != "1" ] \
       && git -C "$B_DIR" rev-parse --verify -q "refs/heads/$B_WORK_BRANCH" >/dev/null 2>&1; then
      _B_KEPT="$(git -C "$B_DIR" rev-list --count "$B_DEFAULT_BRANCH..$B_WORK_BRANCH" 2>/dev/null || echo 0)"
    fi
    if [ "${_B_KEPT:-0}" -gt 0 ] 2>/dev/null && git -C "$B_DIR" checkout "$B_WORK_BRANCH" >/dev/null 2>&1; then
      log "BOOTSTRAP #$NUM: re-entered EXISTING branch $B_WORK_BRANCH — $_B_KEPT prior commit(s) kept (set GAFFER_RETRY_FRESH_BRANCH=1 for a clean-slate retry)"
    elif ! git -C "$B_DIR" checkout -B "$B_WORK_BRANCH" >/dev/null 2>&1; then
      log "BOOTSTRAP: #$NUM could not create delivery branch $B_WORK_BRANCH — failing"
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi

    # Install the project-local config (skills, settings+hook, CLAUDE brief, MCP)
    # into the NEW repo — identical mechanics to normal delivery, just rooted at
    # the fresh dir (which IS the single write-root for this run).
    # Mount ONLY the selected (B_SKILLS) + universal skill subset — not the whole
    # library — so Claude Code doesn't auto-load all ~66 frontmatter blocks.
    # Fail-soft: falls back to the whole library on any error (see skills-mount.sh).
    # The ONE shared installer (lib/agent-env.sh) every other spawn site uses:
    # skills mount + render AND VERIFY .claude/settings.json (the PreToolUse
    # safety-hook wiring) + workspace trust + the CLAUDE.factory.md brief. This site
    # used to render the settings with a bare `sed` and no verification, so a bad
    # template or a full disk could launch the bootstrap agent — the one agent that
    # is also allowed a dependency install — with no deterministic containment
    # boundary. FAIL CLOSED: release the claim back to ready (the scaffold resumes on
    # the next attempt), skip the ticket this run, and never spawn.
    if ! gaffer_install_agent_dir "$B_DIR" "$B_SKILLS" "bootstrap-$NUM"; then
      gaffer_abort_setup SAFETY "agent-env install failed for bootstrap #$NUM (settings/hook wiring unverified) — refusing live bootstrap (fail closed)"
    fi
    MCP_RUNTIME="$GAFFER_DATA/mcp-runtime.$$.json"
    gaffer_assert_db_vars || gaffer_abort_setup DB-VARS "DISPATCH_DB/MEMORY_DB empty — refusing live bootstrap (fail closed)"
    # RUNNER-OWNED-BOOKKEEPING: inject the runner-held claim token into the dispatch
    # MCP server env so the agent's evidence writes resolve it without ever handling
    # the token string. Substituted alongside the DB/bin placeholders.
    #
    # MEMORY-SCOPE BINDING: a bootstrap ticket has exactly one target repo — the
    # fresh repo being scaffolded ($B_NAME) — so that is the sole in-scope name
    # bound into ${GAFFER_TICKET_REPOS}. Paired with GAFFER_FACTORY=1 (template
    # literal) it lets the memory server refuse a direct-apply write against any
    # OTHER repo. (The main-delivery twin at the live run derives this from WT_ROWS.)
    GAFFER_TICKET_REPOS="$B_NAME"
    # CARD-CANONICAL BINDING (see the main-delivery twin): the one fresh repo.
    # shellcheck disable=SC2034  # read by gaffer_render_mcp_runtime (factory.config.sh)
    GAFFER_REPO_CANONICALS="$(printf '%s\t%s\n' "$B_NAME" "$B_DIR" | gaffer_repo_canonicals_json)"
    # MEMORY ROI: a bootstrap has no delivery-recall context, so ${GAFFER_RECALL_TICKET}
    # renders empty — the memory read path then logs no retrieval (inert), matching
    # the standalone posture. The main-delivery twin sets it to the ticket $NUM.
    # Render via the single seam (factory.config.sh → packages/crew renderMcpCli.js).
    # Recall is empty for a bootstrap (no delivery-recall context ⇒ memory read inert).
    # Fail-closed: a render error (ts renderer rejects a broken/drifted template)
    # must abort the bootstrap before the agent launch — the bare sed never did.
    # FACTORY TICKET SCOPE: the scope ticket ($NUM, rendered into the dispatch server's
    # GAFFER_SCOPE_TICKET) makes the server refuse this agent's writes on any OTHER
    # ticket (it does not depend on the claim token alone, which is empty on a resume).
    gaffer_render_mcp_runtime "$MCP_CONFIG" "$MCP_RUNTIME" "" "$NUM" \
      || gaffer_abort_setup MCP-RENDER "failed to render bootstrap runtime .mcp.json — refusing live bootstrap (fail closed)"
    chmod 600 "$MCP_RUNTIME" 2>/dev/null || true  # carries the live claim token — owner-only
    gaffer_exclude_runner_config "$B_DIR"   # keep runner config out of `git add -A`

    # The prompt text (and the title's quarantine envelope) is rendered by crew:
    # packages/crew/src/runtime/context/deliveryPrompt.ts via renderPromptCli.js.
    B_PROMPT="$(gaffer_render_delivery_prompt bootstrap)" \
      || gaffer_abort_setup PROMPT-RENDER "failed to render bootstrap prompt for #$NUM — refusing live bootstrap (fail closed)"

    RUN_LOG_MARK="$(wc -l < "$GAFFER_LOG" 2>/dev/null || echo 0)"
    # The scoped install allowance: GAFFER_BOOTSTRAP_INSTALL=1 + GAFFER_BOOTSTRAP_DIR
    # are exported ONLY for this bootstrap invocation, so the safety hook permits
    # exactly the first install inside $B_DIR. GAFFER_WRITE_ROOTS is the new repo.
    # npm_config_ignore_scripts=true is an env-level kill switch so even the ONE
    # permitted bootstrap install cannot run dependency lifecycle scripts
    # (postinstall ACE) — belt-and-braces with the safety hook's --ignore-scripts
    # requirement. Per-call resource caps (gaffer_timeout + --max-turns) bound the
    # wall-clock and token spend of this headless call.
    # USAGE LEDGER: capture --output-format json stdout for the ledger; stderr →
    # log; agent's `.result` text appended to the log below (preserves the log).
    B_USAGE_JSON="$GAFFER_DATA/.usage-$NUM.json"; : > "$B_USAGE_JSON"
    # C1/M2: strip ambient credentials from the live agent's env (allowlist via
    # env -i) — done inside worker_deliver. The per-call boundary/install vars in
    # WORKER_CALL_ENV are layered on top of the allowlist so they win.
    WORKER_CALL_ENV=(
      "GAFFER_WRITE_ROOTS=$B_DIR" "GAFFER_READ_ROOTS="
      "GAFFER_BOOTSTRAP_INSTALL=1" "GAFFER_BOOTSTRAP_DIR=$B_DIR"
      "npm_config_ignore_scripts=true"
      "DISPATCH_DB=$DISPATCH_DB" "MEMORY_DB=$MEMORY_DB"
    )
    _B_SKILL_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    GAFFER_LAUNCH_KIND=bootstrap worker_deliver "$B_DIR" "$B_PROMPT" "$GAFFER_IMPL_MODEL_FLAG" "$MCP_RUNTIME" "$B_USAGE_JSON"
    brc=$?
    gaffer_usage_record bootstrap "$NUM" "$brc" "$B_USAGE_JSON" >>"$GAFFER_LOG" 2>/dev/null || true
    gaffer_record_skill_usage "$NUM" bootstrap "$STACK" "$B_SKILLS" "$B_USAGE_JSON" \
      "bootstrap-$NUM" "$B_DIR" "$_B_SKILL_SINCE"
    # USAGE WINDOW: a bootstrap refused by the plan's usage window / a rate limit is not
    # a failed scaffold (same rc 0/1/2 contract as the delivery path below). Record the
    # pause, release the claim to `ready` without parking it for a human, and keep the
    # partial scaffold: the dir stays a resumable bootstrap target for the retry.
    _B_UL_REC="$(gaffer_usage_pause_record "$B_USAGE_JSON" "$NUM" bootstrap)"; _B_UL_RC=$?
    rm -f "$B_USAGE_JSON"
    log "bootstrap delivery for #$NUM finished (rc=$brc)"
    if [ "$_B_UL_RC" != 1 ]; then
      _UL_UNTIL=""; _UL_MSG=""
      IFS=$'\t' read -r _ _UL_UNTIL _ _ _UL_MSG <<<"$_B_UL_REC"
      _UL_LINE="$(gaffer_usage_pause_active || echo "paused: usage limit")"
      gaffer_release_delivery ready \
        "usage limit: ${_UL_MSG:-refused by the usage window}; ${_UL_LINE}; not counted as an attempt (scaffold kept at $B_DIR)" \
        usage_limit "" "" "$_UL_UNTIL"
      if [ "$_B_UL_RC" != 0 ]; then
        gaffer_skip_ticket "$NUM"   # FAIL CLOSED: no pause written, so do not re-claim it this run
        log "USAGE: WARNING — bootstrap #$NUM was refused by a usage/rate limit but the pause could not be written under $GAFFER_DATA; skipping the ticket for the rest of this run"
      fi
      log "USAGE: bootstrap #$NUM refused by the model's usage window (${_UL_MSG:-usage limit}) — released to ready, scaffold kept at $B_DIR; $_UL_LINE"
      result usage_paused; exit 0
    fi
    # BUDGET ADMISSION REFUSED at the launch itself (a cap reached since the check
    # above): no agent ran, so it is not a failed scaffold. Release to ready uncounted;
    # the dir stays a resumable bootstrap target for the retry.
    if [ "${WORKER_LAST_BUDGET_REFUSED:-0}" = 1 ]; then
      gaffer_release_delivery ready "the paid bootstrap launch was refused by the budget admission (no agent ran); not counted as an attempt (repo kept at $B_DIR)" budget_refused
      gaffer_skip_ticket "$NUM"
      log "BUDGET: bootstrap #$NUM — the paid launch was refused by the budget admission; released to ready without counting an attempt"
      result no_work; exit 0
    fi
    if [ "$brc" -ne 0 ]; then
      # FINDING-12: park bootstrap failures to the VISIBLE `blocked` column (event +
      # attention count in status.sh / the human queue) — `refining` hid them from
      # selection, clarify, status and the human queue.
      gaffer_release_delivery blocked "bootstrap failed (rc=$brc) — scaffold left at $B_DIR for inspection${_B_OFFLINE_NOTE:+; $_B_OFFLINE_NOTE}" bootstrap_failed
      gaffer_skip_ticket "$NUM"
      log "BOOTSTRAP FAILED for #$NUM (rc=$brc) — leaving $B_DIR for inspection; not onboarding"
      result error; exit 0
    fi

    # WASTE CONTROL: the bootstrap agent often writes the whole scaffold and stops
    # without `git commit` (the delivery path has auto-committed that case for a long
    # time; the bootstrap path parked it as "no scaffold commit" and threw the work
    # away — a live run lost a complete four-minute scaffold that way). Commit the
    # uncommitted scaffold first, exactly like the delivery path.
    if gaffer_autocommit_dir "$B_DIR" "deliver #$NUM: $TITLE (scaffold; agent had not committed)"; then
      log "BOOTSTRAP #$NUM: auto-committed the uncommitted scaffold (agent edited but did not commit)"
    fi
    # Empty delivery: the scaffold must add at least one commit ON TOP of the README
    # baseline. The delivery branch HEAD identical to the baseline `main` ⇒ the agent
    # produced nothing to onboard (a bare baseline is not a scaffold).
    if [ "$(git -C "$B_DIR" rev-parse HEAD 2>/dev/null)" = "$(git -C "$B_DIR" rev-parse "$B_DEFAULT_BRANCH" 2>/dev/null)" ]; then
      log "BOOTSTRAP #$NUM produced no scaffold commit (branch == baseline) — parking (no scaffold to onboard)"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "PARKED: bootstrap produced no scaffold commit beyond the baseline — needs clarification" >/dev/null 2>&1 || true
      # FINDING-12: VISIBLE park (see the rc-failure park above).
      gaffer_release_delivery blocked "bootstrap produced no initial commit${_B_OFFLINE_NOTE:+; $_B_OFFLINE_NOTE}" bootstrap_failed
      gaffer_skip_ticket "$NUM"; result error; exit 0
    fi

    # ── Hygiene gate (HARD FAIL) — same assertions as normal delivery, run on the
    # initial-commit tree (diff vs the empty tree). Catches a leaked events log,
    # broken symlinks, etc. node_modules added by the install is NOT a hygiene
    # violation for a bootstrap (it is expected), so we relax ONLY the node_modules
    # fragment — all other forbidden paths (.crew/, *.events.jsonl, .claude/,
    # CLAUDE.factory.md, .mcp.json, mcp-runtime) remain forbidden.
    # BUG 3 fix: previously used HYGIENE_FORBIDDEN_PATHS='.crew/ *.events.jsonl'
    # which silently exempted .claude/, CLAUDE.factory.md, .mcp.json and
    # mcp-runtime. Now we build the relaxed list by taking the full default
    # and removing only the node_modules fragment. (The `mcp-runtime.` fragment —
    # trailing dot, finding 11 — covers the generated `mcp-runtime.json` /
    # per-tick `mcp-runtime.<pid>.json` files without rejecting a legit
    # `src/mcp-runtime/` source dir.)
    EMPTY_TREE="$(git -C "$B_DIR" hash-object -t tree /dev/null 2>/dev/null || echo 4b825dc642cb6eb9a060e54bf8d69288fbee4904)"
    _BOOTSTRAP_HYGIENE_PATHS="$(printf '%s\n' ${HYGIENE_FORBIDDEN_PATHS:-node_modules .crew/ *.events.jsonl .claude/ CLAUDE.factory.md .mcp.json mcp-runtime.} | grep -v '^node_modules$' | tr '\n' ' ')"
    B_HYGIENE="$(HYGIENE_FORBIDDEN_PATHS="$_BOOTSTRAP_HYGIENE_PATHS" \
                 gaffer_assert_clean_delivery "$B_DIR" "$EMPTY_TREE" 2>/dev/null)" || true
    if [ -n "$B_HYGIENE" ]; then
      log "BOOTSTRAP HYGIENE: #$NUM scaffold is NOT hygienic:"$'\n'"$B_HYGIENE"
      if [ "${HYGIENE_ENFORCE:-1}" = "1" ]; then
        wg attach-evidence "$NUM" --type manual_note \
          --summary "PARKED: bootstrap hygiene violation (not onboarded):"$'\n'"$B_HYGIENE" >/dev/null 2>&1 || true
        # FINDING-12: VISIBLE park (see the rc-failure park above).
        gaffer_release_delivery blocked "bootstrap hygiene: $(printf '%s' "$B_HYGIENE" | tr '\n' ' ')" bootstrap_failed
        gaffer_skip_ticket "$NUM"
        log "BOOTSTRAP FAILED for #$NUM — hygiene violation; not onboarding"
        result error; exit 0
      else
        log "HYGIENE_ENFORCE=0 — logging the bootstrap hygiene violation but not failing"
      fi
    fi

    # ── Minimalism note: REQUIRED (same as normal delivery) but oversized is
    # EXEMPT for a bootstrap — a fresh scaffold is legitimately large. A missing
    # smallest-change note still FAILS; an oversized scaffold is FLAGGED only.
    # Stats are the scaffold vs the BASELINE branch (what the reviewer diffs): the
    # empty tree is not a commit, so `<empty-tree>...HEAD` has no merge base and the
    # stat silently read "0 files / 0 lines" for every bootstrap.
    read -r _BMZ_FILES _BMZ_LINES <<< "$(gaffer_diff_stats "$B_DIR" "$B_DEFAULT_BRANCH")"
    _BMZ_NOTE="$(wg ticket show "$NUM" 2>/dev/null | gaffer_json smallest-change-note 2>/dev/null || echo '')"
    _BMZ_TRIM="$(printf '%s' "$_BMZ_NOTE" | tr -d '[:space:]')"
    if [ -z "$_BMZ_TRIM" ]; then
      # A greenfield bootstrap creates a repo FROM THE EMPTY TREE — there is no
      # pre-existing code to make a "smallest change" against, so a smallest-change note
      # (a meaningful gate for FEATURE edits) is contradictory here, and being
      # agent-authored it is flaky run-to-run (a valid scaffold otherwise gets parked on
      # a missing note, stranding the whole epic). Consistent with the oversized
      # exemption below — a fresh scaffold is legitimately large — FLAG a missing note
      # for human review, never FAIL the bootstrap on it.
      log "BOOTSTRAP MINIMALISM: #$NUM has no smallest-change note — EXEMPT (fresh scaffold); flagging not failing ($_BMZ_FILES files / $_BMZ_LINES lines)"
      wg attach-evidence "$NUM" --type manual_note \
        --summary "needs_human_review: bootstrap has no smallest-change note (${_BMZ_FILES} files / ${_BMZ_LINES} lines) — exempt from minimalism hard-fail (greenfield scaffold)" >/dev/null 2>&1 || true
    else
      # Note present. Oversized is EXEMPT for bootstrap — flag visibly, never fail.
      if { [ "${OVERSIZED_MAX_LINES:-400}" -gt 0 ] && [ "${_BMZ_LINES:-0}" -gt "${OVERSIZED_MAX_LINES:-400}" ]; } \
         || { [ "${OVERSIZED_MAX_FILES:-12}" -gt 0 ] && [ "${_BMZ_FILES:-0}" -gt "${OVERSIZED_MAX_FILES:-12}" ]; }; then
        log "BOOTSTRAP MINIMALISM: #$NUM scaffold is oversized ($_BMZ_FILES files / $_BMZ_LINES lines) — EXEMPT (fresh scaffold); flagging not failing"
        wg attach-evidence "$NUM" --type manual_note \
          --summary "needs_human_review: oversized bootstrap scaffold (${_BMZ_FILES} files / ${_BMZ_LINES} lines) — exempt from minimalism hard-fail" >/dev/null 2>&1 || true
      else
        log "BOOTSTRAP MINIMALISM: #$NUM within caps ($_BMZ_FILES files / $_BMZ_LINES lines)"
      fi
    fi

    # ── Register + onboard the new repo so the now-done bootstrap unblocks the
    # dependent feature tickets (which target it via the normal worktree flow).
    if gaffer_bootstrap_onboard "$NUM" "$B_NAME" "$B_DIR" "$STACK" "" "$B_DEFAULT_BRANCH"; then
      log "BOOTSTRAP: registered + onboarded new repo '$B_NAME' ($B_DIR) into the factory"
      # FIX-BRANCH invariant: the delivery branch $B_WORK_BRANCH is about to become
      # review-visible via the records below. Raise the branch-retention flag FIRST —
      # strictly BEFORE any delivery record — so no later crash/signal can drop a
      # review-worthy branch (matches the normal-delivery ordering). The bootstrap holds
      # no throwaway worktree, so at runtime this is a no-op belt-and-braces.
      GAFFER_KEEP_DELIVERY_BRANCH=1
      # Link the new repo to the bootstrap ticket + record the delivery so the
      # done-gate/reviewer can resolve it (best-effort, non-fatal).
      wg repo link "$NUM" "$B_NAME" --as system >/dev/null 2>&1 ||
        log "BOOTSTRAP: repo link #$NUM ↔ $B_NAME did not record (non-fatal)"
      # Record the delivery on the NORMAL lane: the diff is the scaffold delta on TOP of
      # the README baseline (main..branch — exactly what the reviewer diffs), and the
      # persisted branch_name is the `gaffer/ticket-N-<slug>` DELIVERY branch (NOT `main`),
      # so the reviewer resolves `d['ticket']['branch_name']`, worktrees the branch, diffs
      # it vs `main`, and can auto-approve+merge — no more "no delivery branch recorded".
      B_DIFFSTAT="$(git -C "$B_DIR" diff "$B_DEFAULT_BRANCH".."$B_WORK_BRANCH" --stat 2>/dev/null | tail -15)"
      B_HEAD_SHA="$(git -C "$B_DIR" rev-parse "$B_WORK_BRANCH" 2>/dev/null || echo '')"
      wg attach-evidence "$NUM" --type diff_summary \
        --summary "Bootstrapped new repo $B_NAME at $B_DIR — delivered on branch $B_WORK_BRANCH (base $B_DEFAULT_BRANCH)"$'\n'"$B_DIFFSTAT" >/dev/null 2>&1 ||
        log "BOOTSTRAP: diff_summary evidence for #$NUM did not record (non-fatal)"
      wg delivery-artifact "$NUM" --branch "$B_WORK_BRANCH" --diff "$B_DIFFSTAT" --as system >/dev/null 2>&1 ||
        log "BOOTSTRAP: delivery-artifact for #$NUM did not record (non-fatal)"
      # Per-repo delivery record (WG-005 parity with the normal lane): the done-gate /
      # reviewer see a review_ready delivery for the new repo on the delivery branch.
      # This row is LOAD-BEARING (the done-gate resolves the delivery from it), so a
      # failure must be visible, never silently swallowed.
      B_SHA_ARG=""; [ -n "$B_HEAD_SHA" ] && B_SHA_ARG="--commit $B_HEAD_SHA"
      # LOAD-BEARING: the done-gate resolves the delivery from this row. If it does not
      # record, submitting anyway strands the ticket in `in_review` forever (the gate can
      # never resolve) while the operator is told bootstrap succeeded. So on failure we
      # surface the real error, park → refining (blocks blind reclaim), skip, and fail the
      # tick for a human handoff — NEVER fall through to gaffer_submit_delivery.
      _B_RD_ERR="$GAFFER_DATA/.bootstrap-rd-err.$$"
      if ! wg ticket repo-delivery record "$NUM" "$B_NAME" --branch "$B_WORK_BRANCH" $B_SHA_ARG --status review_ready --as system 2>"$_B_RD_ERR"; then
        log "BOOTSTRAP: per-repo delivery record for #$NUM ($B_NAME) FAILED — done-gate cannot resolve this delivery; parking → blocked (NOT submitting): $(head -c 400 "$_B_RD_ERR" 2>/dev/null | tr '\n' ' ')"
        rm -f "$_B_RD_ERR"
        # Park VISIBLY to `blocked` (pages a human via the attention count), never
        # `refining` (invisible to every human surface), matching the other bootstrap
        # failure parks. Do NOT fall through to gaffer_submit_delivery: a submit without
        # this load-bearing row strands the ticket in `in_review` forever.
        gaffer_release_delivery blocked "bootstrap per-repo delivery record failed for #$NUM ($B_NAME) — the done-gate cannot resolve this delivery; record it manually before submitting" bootstrap_failed
        gaffer_skip_ticket "$NUM"
        result error; exit 0
      fi
      rm -f "$_B_RD_ERR"
      # Rest the new repo's PRIMARY working tree back on its default branch (`main`), so
      # the delivery branch is a plain ref the reviewer's throwaway worktree can check out
      # cleanly, and dependents branch off a tidy `main` after the scaffold merges.
      git -C "$B_DIR" checkout "$B_DEFAULT_BRANCH" >/dev/null 2>&1 || true
      # Greenfield epics wire themselves up: link the new repo as a WRITE repo to
      # the epic's sibling feature tickets that still lack one, so they become
      # deliverable. Deterministic for the single-bootstrap epic; the planner
      # escalates the genuinely-ambiguous multi-app case to a headless decision.
      # Best-effort/non-fatal + idempotent (re-running never double-links).
      gaffer_inherit_repo "$NUM" || true
      # A new repo has no remote: with PR mode on, ask the person where it lives before
      # the tickets it serves start (lib/greenfield.sh).
      gaffer_bootstrap_remote_decision "$NUM" "$B_NAME" "$B_DIR" || true
    else
      # Registration failed, so there is no repo to link, no branch_name and no per-repo
      # delivery row: submitting would strand the ticket in in_review (the reviewer has
      # nothing to diff, the done-gate cannot resolve it) with every dependent blocked
      # behind it. Park VISIBLY instead, with the cause, keeping the scaffold + branch;
      # a retry resumes the scaffold and counts a now-registered repo as success.
      log "BOOTSTRAP: dispatch registration of '$B_NAME' FAILED (${GAFFER_ONBOARD_ERR:-unknown}) — parking #$NUM → blocked (NOT submitting)"
      GAFFER_KEEP_DELIVERY_BRANCH=1
      gaffer_release_delivery blocked "bootstrap repo registration of '$B_NAME' failed: ${GAFFER_ONBOARD_ERR:-unknown} — register it with 'wg repo add' (scaffold kept at $B_DIR, branch $B_WORK_BRANCH), then unblock it ('gaffer wg unblock $NUM')" bootstrap_failed
      gaffer_skip_ticket "$NUM"
      result error; exit 0
    fi

    # RUNNER-OWNED-BOOKKEEPING: the runner (holding the claim) submits the bootstrap
    # ticket for review now that its gates passed and the delivery is recorded. The
    # agent no longer submits.
    if gaffer_submit_delivery "bootstrapped new repo $B_NAME at $B_DIR — delivered on branch $B_WORK_BRANCH"; then
      log "BOOTSTRAP: submitted #$NUM for review (→ in_review) on branch $B_WORK_BRANCH"
      result worked; exit 0
    fi
    # M1 (data-loss path): the submit FAILED. Do NOT exit "worked" leaving the ticket
    # `claimed` — on TTL expiry it is blindly reclaimed and re-bootstrapped, and the
    # already-recorded delivery evidence then points at a superseded scaffold. Park the
    # runner-held claim to `refining` (blocks the blind reclaim), skip it this run, and
    # fail the tick for a manual review handoff.
    gaffer_release_delivery refining "runner submit failed — needs manual review handoff"
    gaffer_skip_ticket "$NUM"
    log "BOOTSTRAP: WARNING — submit FAILED for #$NUM; parked → refining, NOT exiting worked — needs a human / claim-recovery"
    result error; exit 0
  fi
}
