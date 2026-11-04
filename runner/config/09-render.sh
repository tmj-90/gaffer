# shellcheck shell=bash
# runner/config/09-render.sh: helper functions: the portable timeout and its preflight, sed escaping, the
# MCP runtime-config render and env binding, the delivery prompt render.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# Portable wall-clock timeout. Usage: gaffer_timeout <seconds> <command> [args...]
# Exit 124 on timeout (matching GNU timeout's convention) so callers can detect it.
gaffer_timeout() {
  local secs="$1"; shift
  if [ -z "$secs" ] || [ "$secs" -le 0 ] 2>/dev/null; then "$@"; return $?; fi
  if command -v perl >/dev/null 2>&1; then
    # perl alarm() + fork: the child does setpgrp() (its own process group, so a
    # spawned `claude -p` AND all its MCP/child processes share the child's PGID)
    # then exec's the command; the parent arms alarm($t) and waits.
    #
    # ORPHAN-REAP (wallet-drain fix): a timed-out or killed agent must never leave
    # an orphaned `claude -p` burning tokens. On ANY teardown path — SIGALRM
    # (timeout), or the parent itself receiving SIGTERM/SIGINT (the tick's crash
    # trap, or the outer per-tick timeout) — we tear down the WHOLE child process
    # group and ESCALATE TERM -> KILL after a short grace, so a signal-ignoring
    # agent cannot survive. Forwarding on TERM/INT is what stops the child being
    # orphaned when the PARENT is killed (perl's default SIGTERM would just die and
    # leave the child group running). Optionally records the child PGID to
    # $GAFFER_TIMEOUT_PGID_FILE so a belt-and-braces tick-exit trap can reap a
    # survivor; the file is removed on normal completion so it never goes stale.
    perl -e '
      use POSIX ":sys_wait_h";
      my $t = shift;
      my $pid = fork();
      die "fork: $!" unless defined $pid;
      if ($pid == 0) { setpgrp(0,0); exec @ARGV or exit 127; }
      my $pf = $ENV{GAFFER_TIMEOUT_PGID_FILE};
      if ($pf) { if (open(my $fh, ">", $pf)) { print $fh $pid; close $fh; } }
      my $clear = sub { unlink $pf if $pf; };
      # FINDING-6 (b): the TERM->KILL grace is GAFFER_REAP_GRACE (default 30s),
      # not a hardcoded ~2s. The TERMed tick runs its crash trap — claim-release
      # (a node/HTTP wg call) + worktree teardown — and must be allowed to finish
      # before the group KILL; the wait polls every 0.1s so a fast exit still
      # reaps immediately (no fixed-cost stall). A non-numeric/zero override
      # falls back to 30s — the grace may be tuned, never disabled.
      my $grace = $ENV{GAFFER_REAP_GRACE} // "";
      $grace = 30 unless $grace =~ /^[0-9]+$/ && $grace > 0;
      my $reap = sub {
        my ($code) = @_;
        kill "TERM", -$pid; kill "TERM", $pid;
        my $gone = 0;
        for (1..($grace * 10)) { if (waitpid($pid, WNOHANG) == $pid) { $gone = 1; last } select(undef,undef,undef,0.1); }
        # ALWAYS escalate the whole process GROUP to KILL after the grace — even when
        # the foreground child ($pid) has ALREADY exited on TERM. A claude -p that dies
        # cleanly can leave a GRANDCHILD (its MCP server) still alive in the same group;
        # gating the KILL on the direct child being reaped ($gone) is the exact
        # wallet-drain — that lingering MCP grandchild would survive and keep burning
        # tokens. Sweeping the GROUP with KILL reaps EVERY descendant regardless of how
        # the foreground child died (a KILL to an already-empty group is a harmless
        # ESRCH no-op). Only the direct-PID KILL stays gated — redundant once reaped.
        kill "KILL", -$pid;
        kill "KILL", $pid unless $gone;
        $clear->();
        exit $code;
      };
      $SIG{ALRM} = sub { $reap->(124) };
      $SIG{TERM} = sub { $reap->(143) };
      $SIG{INT}  = sub { $reap->(130) };
      alarm $t;
      waitpid($pid, 0);
      my $st = $?;
      $clear->();
      exit($st >> 8 ? $st >> 8 : ($st & 127 ? 128 + ($st & 127) : 0));
    ' "$secs" "$@"
    return $?
  fi
  # GNU/BSD timeout fallbacks: `-s TERM -k <grace>` escalates to SIGKILL after the
  # grace if the command ignores TERM, so a runaway agent is still reaped. Same
  # configurable grace as the perl path (FINDING-6 (b)) so the tick's crash-trap
  # claim-release gets to finish on this path too.
  if command -v timeout >/dev/null 2>&1; then timeout -s TERM -k "$GAFFER_REAP_GRACE" "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout -s TERM -k "$GAFFER_REAP_GRACE" "$secs" "$@"; return $?; fi
  # FAIL CLOSED (R-10): no timeout primitive (perl / timeout / gtimeout) is
  # available. Running the command unbounded here is the denial-of-wallet hole —
  # a runaway `claude -p` could burn unbounded wall-clock and tokens. Refuse to
  # run the command, emit a clear setup error, and return 127 so every caller
  # treats it as a fatal setup fault (see gaffer_timeout_preflight, which aborts
  # the run up front rather than relying on each call site to notice).
  echo "gaffer_timeout: FATAL — no timeout primitive (perl, timeout, or gtimeout) found; refusing to run '$1' unbounded. Install perl or coreutils." >&2
  return 127
}

# Preflight (R-10): assert a timeout primitive exists BEFORE any agent call.
# gaffer_timeout fails closed (returns 127) when none is present, but a runaway
# call should never even be attempted — so callers (loop.sh, tick.sh) run this
# once at startup and ABORT the whole run with a setup error if it fails. Returns
# 0 when a primitive is available, 127 (with a stderr message) when not.
gaffer_timeout_preflight() {
  if command -v perl >/dev/null 2>&1 \
    || command -v timeout >/dev/null 2>&1 \
    || command -v gtimeout >/dev/null 2>&1; then
    return 0
  fi
  echo "gaffer: FATAL SETUP ERROR — no wall-clock timeout primitive available (need perl, timeout, or gtimeout). Refusing to start: agent calls cannot be bounded and could run away. Install perl or GNU coreutils." >&2
  return 127
}

# --- Safe sed replacement escaping (B-M1) ------------------------------------
# Escape a value for use as the REPLACEMENT half of a `sed s#…#REPL#g`. The three
# characters that are special in a sed replacement are `\`, `&`, and the delimiter
# itself (`#`). tick.sh templates .claude/settings.json and the MCP runtime config
# by sed-substituting real filesystem PATHS (RUNNER_DIR, DISPATCH_DB, the MCP bins,
# …) and the claim token into placeholders; a path containing `#` (a legal POSIX
# filename byte) would otherwise prematurely close the substitution and corrupt the
# generated config. Passing every value through this escaper makes the templating
# robust regardless of what the path contains. Pure text-in/text-out.
_gaffer_sed_repl() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }

# --- MCP runtime-config render -----------------------------------------------
# Render the per-tick runtime .mcp.json from the template, substituting the
# ${NAME} placeholders, through the typed renderer (packages/crew renderMcpCli.js →
# renderMcpRuntimeConfig). This is the SINGLE render site the delivery and bootstrap
# ticks both call (they once carried duplicate inline sed chains, which is exactly
# how the two drifted). Output is pinned by runner/test/mcp-render-golden.test.sh.
#
# Usage: gaffer_render_mcp_runtime <template> <out> <recall_ticket> [<scope_ticket>]
#   Reads the other six values from the ambient shell scope (DISPATCH_DB, MEMORY_DB,
#   DISPATCH_MCP_BIN, MEMORY_MCP_BIN, CLAIM_TOKEN, GAFFER_TICKET_REPOS — each set by
#   the caller before the call — plus the optional GAFFER_REPO_CANONICALS, see
#   gaffer_repo_canonicals_json below; unset renders it empty). The recall ticket (empty on bootstrap, $NUM on
#   delivery) and the scope ticket differ per site, so they are positional. The scope
#   ticket is the dispatch server's factory ticket scope (GAFFER_SCOPE_TICKET: the
#   agent's ticket writes on any other ticket are refused) — delivery, bootstrap and
#   clarify pass their ticket; omitted/empty binds nothing (fail closed). It is a
#   template placeholder, not a post-render edit, so the bash render stays
#   byte-identical to the TS renderer's golden.
#
# FAIL-CLOSED: a non-zero exit (the renderer rejects a leftover placeholder /
# invalid JSON / missing server; the dist bin is missing) propagates, and the caller
# treats it as a hard error — an agent is never launched on an unrendered config.
gaffer_render_mcp_runtime() {
  local tmpl="$1" out="$2" recall="$3" scope="${4:-}"
  # FAIL CLOSED without the crew dist: an agent is never launched on an unrendered
  # MCP config (the caller treats non-zero as a hard error).
  if [ ! -f "$CREW_DIR/dist/runtime/context/renderMcpCli.js" ]; then
    log "renderMcpCli.js missing — packages/crew is not built (run pnpm -r build)" 2>/dev/null || true
    return 1
  fi
  GAFFER_MCP_DISPATCH_DB="$DISPATCH_DB" \
  GAFFER_MCP_MEMORY_DB="$MEMORY_DB" \
  GAFFER_MCP_DISPATCH_BIN="$DISPATCH_MCP_BIN" \
  GAFFER_MCP_MEMORY_BIN="$MEMORY_MCP_BIN" \
  GAFFER_MCP_CLAIM_TOKEN="$CLAIM_TOKEN" \
  GAFFER_MCP_TICKET_REPOS="$GAFFER_TICKET_REPOS" \
  GAFFER_MCP_RECALL_TICKET="$recall" \
  GAFFER_MCP_SCOPE_TICKET="$scope" \
  GAFFER_MCP_REPO_CANONICALS="${GAFFER_REPO_CANONICALS:-}" \
    node "$CREW_DIR/dist/runtime/context/renderMcpCli.js" --template "$tmpl" --out "$out" || return 1
}

# --- Card-canonical binding for the memory MCP server ----------------------------
# Print the JSON object {repo name: canonical} for the rows on stdin (TAB-separated
# `<name>\t<real repo path>`), for the caller to set as GAFFER_REPO_CANONICALS before
# gaffer_render_mcp_runtime. The canonical is `memory repo-canonical` of the REAL repo
# (remote.origin.url, else its realpath) — the exact key onboarding wrote the file
# cards under — so the agent's card tools find them from a worktree, where its own
# guess (the worktree path) matches nothing for a repo with no remote. FAIL-SOFT:
# a row with no name / no dir / no canonical is skipped, and no rows print nothing
# (the memory server then takes the agent's repoCanonical, as before).
gaffer_repo_canonicals_json() {
  local _rc_name _rc_path _rc_canon _rc_rows=""
  while IFS=$'\t' read -r _rc_name _rc_path; do
    [ -n "$_rc_name" ] && [ -n "$_rc_path" ] && [ -d "$_rc_path" ] || continue
    _rc_canon="$(lg repo-canonical --repo-root "$_rc_path" 2>/dev/null)" || continue
    [ -n "$_rc_canon" ] || continue
    _rc_rows+="$_rc_name"$'\t'"$_rc_canon"$'\n'
  done
  [ -n "$_rc_rows" ] || return 0
  printf '%s' "$_rc_rows" | gaffer_json tsv-object 2>/dev/null || true
}

# --- MCP runtime env binding -----------------------------------------------------
# Add ONE env var to ONE server of an already-rendered runtime .mcp.json, in place.
# Used for per-pass bindings the shared template has no placeholder for (the review
# pass binds GAFFER_REVIEW_TICKET into the dispatch server so the reviewer's claimless
# evidence notes are accepted for that ticket only). Parses + re-serialises the JSON
# (never a textual splice), fails non-zero on unparseable input or a missing server so
# the caller can refuse the launch (fail closed).
# Usage: gaffer_mcp_runtime_set_env <runtime.json> <server> <KEY> <value>
gaffer_mcp_runtime_set_env() {
  local file="$1" server="$2" key="$3" value="$4"
  [ -f "$file" ] || return 1
  GAFFER_MCP_SET_FILE="$file" GAFFER_MCP_SET_SERVER="$server" GAFFER_MCP_SET_KEY="$key" GAFFER_MCP_SET_VALUE="$value" \
    node -e '
      const fs = require("node:fs");
      const { GAFFER_MCP_SET_FILE: f, GAFFER_MCP_SET_SERVER: s, GAFFER_MCP_SET_KEY: k, GAFFER_MCP_SET_VALUE: v } = process.env;
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const srv = j && j.mcpServers && j.mcpServers[s];
      if (!srv || typeof srv !== "object") { process.stderr.write(`mcp-set-env: no server ${s}\n`); process.exit(1); }
      srv.env = { ...(srv.env || {}), [k]: v };
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    ' || return 1
}

# --- Delivery/bootstrap PROMPT render ----------------------------------------
# Render the live delivery (fresh / resume) or greenfield bootstrap PROMPT — the
# text tick.sh feeds `claude -p` — through the typed renderer (packages/crew
# renderPromptCli.js → renderDeliveryPrompt / renderBootstrapPrompt). This is the
# prompt twin of gaffer_render_mcp_runtime above and the SINGLE render site the
# three prompt-emitting tick paths call, so they can never drift. Output is pinned
# by runner/test/prompt-render-golden.test.sh and, end to end, by the tick-context
# golden (packages/crew/test/fixtures/tick-context/prompt.fresh.golden.txt).
#
# Usage: gaffer_render_delivery_prompt <fresh|resume|bootstrap>   → prompt on STDOUT
#   The RAW inputs (TITLE, _RF, _RD, _RC, WT_ROWS, READ_ROOTS, SKILLS, LENSES, the context
#   blocks, WORK_BRANCH, PRIMARY_REPO; B_SKILLS/B_DIR for bootstrap) are read from
#   the ambient tick.sh scope and assembled into the renderer's JSON document by
#   _gaffer_prompt_inputs_json below. The render carries no trailing newline.
#
# FAIL-CLOSED: the renderer rejects an empty ticket/title/workBranch/write-repo set
# / bootstrap dir with a non-zero exit, as does a missing dist bin; the caller MUST
# treat that as a hard error and never launch an agent with an unrendered prompt.
gaffer_render_delivery_prompt() {
  local variant="${1:-fresh}"
  # FAIL CLOSED without the crew dist: no agent is launched on an unrendered prompt.
  if [ ! -f "$CREW_DIR/dist/runtime/context/renderPromptCli.js" ]; then
    log "renderPromptCli.js missing — packages/crew is not built (run pnpm -r build)" 2>/dev/null || true
    return 1
  fi
  _gaffer_prompt_inputs_json "$variant" | node "$CREW_DIR/dist/runtime/context/renderPromptCli.js" || return 1
}




# ── Typed branch input assembly: build the renderPromptCli JSON document from the
#    ambient RAW inputs (mirrors runner/test/capture-context-golden.sh's inputs.json
#    emitter). reviewFeedbackReasons is recovered from the pre-block "  - " lines in
#    $_RF; resolvedDecisions from the JSON in $_RD; reviewRequirements from the JSON in
#    $_RC; writeRepos from WT_ROWS ($5 path,
#    $2 name); readRoots from READ_ROOTS.
#    json-tool.mjs (node) json-encodes arbitrary title/path bytes safely. ───────
_gaffer_prompt_inputs_json() {
  local variant="$1"
  if [ "$variant" = "bootstrap" ]; then
    GF_NUM="${NUM:-}" GF_TITLE="${TITLE:-}" GF_SKILLS="${B_SKILLS:-}" GF_DIR="${B_DIR:-}" gaffer_json prompt-inputs bootstrap
    return $?
  fi
  local resuming=false
  [ "$variant" = "resume" ] && resuming=true
  GF_NUM="${NUM:-}" GF_TITLE="${TITLE:-}" GF_RESUMING="$resuming" GF_SKILLS="${SKILLS:-}${SKILLS_NOTE:-}" \
  GF_LENSES="${LENSES:-}" GF_RF="${_RF:-}" GF_RD="${_RD:-}" GF_RC="${_RC:-}" GF_SCOUT="${SCOUT_PROMPT:-}" GF_FCB="${FILE_CARDS_BLOCK:-}" \
  GF_PCB="${PRODUCT_CONTEXT_BLOCK:-}" GF_WORK_BRANCH="${WORK_BRANCH:-}" \
  GF_WT_ROWS="${WT_ROWS:-}" GF_READ_ROOTS="${READ_ROOTS:-}" GF_PRIMARY="${PRIMARY_REPO:-}" gaffer_json prompt-inputs "$variant"
}

_GAFFER_CONFIG_PART=09-render
