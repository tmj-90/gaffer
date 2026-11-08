# shellcheck shell=bash
# runner/lib/scout.sh — the PRE-WORK SCOUT's gatherer (delta roadmap gap 3).
#
# Before a delivery spawns, tick.sh calls gaffer_scout_run: it gathers the raw inputs
# (the ticket JSON, the names json-tool ticket-named-code took from it, the base tree
# from git, the code index's neighbours from the memory CLI, the send-back reasons) and
# hands them to lib/scout.mjs (the packet) and lib/risk-classify.mjs (the effective
# risk). No wording here: the prompt block is rendered by crew's deliveryPrompt.ts.
# Optionally (GAFFER_SCOUT=auto|on, default off) gaffer_model_scout then spends ONE
# bounded read-only model call through the worker seam and merges its checked
# suggestions into the packet.
#
# FAIL-SOFT everywhere: any missing piece (node, git, the memory CLI, the index, the
# crew dist) leaves a smaller packet or none; a delivery never waits on or fails for
# the scout. Outputs (globals, all "" when there is nothing):
#   SCOUT_PACKET_FILE  the packet JSON (with .risk) in a temp dir the caller removes
#                      via gaffer_scout_cleanup
#   SCOUT_PROMPT       the compact prompt input (json-tool prompt-inputs GF_SCOUT)
#   SCOUT_RISK         the effective risk level (low|medium|high|critical)
#   SCOUT_RAISED       the "risk raised to …" sentence when the classifier raised it
#   SCOUT_INDEX_FILE   the index's answer for the seeds (delivery-metrics' index fields)
_GAFFER_SCOUT_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${GAFFER_SCOUT_PACKET:=1}"   # 1 = build the deterministic scout packet before each delivery (named files, stack frames, the code index's importers and tests); 0 = off
: "${GAFFER_SCOUT:=off}"        # The bounded MODEL scout: off (default), auto (only when the effective risk is medium or higher), on (every delivery). One read-only paid call (kind scout)

SCOUT_PACKET_FILE=""; SCOUT_PROMPT=""; SCOUT_RISK=""; SCOUT_RAISED=""; SCOUT_INDEX_FILE=""
_SCOUT_TMP=""

gaffer_scout_cleanup() {
  [ -n "$_SCOUT_TMP" ] && [ -d "$_SCOUT_TMP" ] && rm -rf "$_SCOUT_TMP"
  _SCOUT_TMP=""; SCOUT_PACKET_FILE=""; SCOUT_INDEX_FILE=""
  return 0
}

# _gaffer_scout_canonical <repo> — memory's canonical key (the primer's contract).
_gaffer_scout_canonical() {
  local c=""
  declare -F lg >/dev/null 2>&1 && c="$(lg repo-canonical --repo-root "$1" 2>/dev/null)"
  if [ -z "$c" ]; then
    c="$(git -C "$1" config --get remote.origin.url 2>/dev/null)"
    [ -n "$c" ] || c="$(cd "$1" 2>/dev/null && pwd -P)"
  fi
  printf '%s' "$c"
}

# _gaffer_scout_neighbours <canonical> <base_sha> <P/S lines> <out> — the index's answer
# (`{"status":"unavailable"}` when the CLI gives none). Names go as --flag=value.
_gaffer_scout_neighbours() {
  local canon="$1" sha="$2" lines="$3" out="$4" k v n=0
  local argv=(index neighbours --canonical "$canon" --per-item 8 --json)
  [ -n "$sha" ] && argv+=("--commit=$sha")
  while IFS=$'\t' read -r k v; do
    [ -n "$v" ] || continue
    case "$k" in
      P) argv+=("--paths=$v"); n=$((n + 1)) ;;
      S) argv+=("--symbols=$v"); n=$((n + 1)) ;;
    esac
  done <<< "$lines"
  [ "$n" -gt 0 ] || return 1
  lg "${argv[@]}" > "$out" 2>/dev/null || : > "$out"
  [ -s "$out" ] || printf '{"status":"unavailable"}' > "$out"
  return 0
}

# gaffer_scout_run <real_repo> <base_sha> <attempt> — build the packet (see the header).
# Reads $SHOW (wg ticket show JSON), $_CARD_NAMED (ticket-named-code) and $_RF.
gaffer_scout_run() {
  local repo="${1:-}" sha="${2:-}" attempt="${3:-}"
  SCOUT_PACKET_FILE=""; SCOUT_PROMPT=""; SCOUT_RISK=""; SCOUT_RAISED=""; SCOUT_INDEX_FILE=""
  [ "${GAFFER_SCOUT_PACKET:-1}" != "0" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  [ -f "$_GAFFER_SCOUT_LIB/scout.mjs" ] && [ -f "$_GAFFER_SCOUT_LIB/risk-classify.mjs" ] || return 0
  _SCOUT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-scout.XXXXXX" 2>/dev/null)" || { _SCOUT_TMP=""; return 0; }
  local t="$_SCOUT_TMP" mjs="$_GAFFER_SCOUT_LIB/scout.mjs"
  printf '%s' "${SHOW:-}" > "$t/show.json" 2>/dev/null || return 0
  printf '%s\n' "${_CARD_NAMED:-}" > "$t/named" 2>/dev/null
  printf '%s\n' "${_RF:-}" > "$t/rf" 2>/dev/null
  : > "$t/files"
  if [ -n "$sha" ] && [ -n "$repo" ] && [ -d "$repo" ]; then
    git -C "$repo" ls-tree -r --name-only --full-tree "$sha" 2>/dev/null | head -200000 > "$t/files" 2>/dev/null || : > "$t/files"
  fi
  local seeds
  seeds="$(node "$mjs" seeds --show "$t/show.json" --named "$t/named" --files "$t/files" 2>/dev/null || true)"
  if [ -n "$seeds" ] && [ "${GAFFER_CODE_INDEX:-1}" != "0" ] && declare -F lg >/dev/null 2>&1 && [ -n "$repo" ]; then
    local canon hop2
    canon="$(_gaffer_scout_canonical "$repo")"
    if _gaffer_scout_neighbours "$canon" "$sha" "$seeds" "$t/nb1.json"; then
      SCOUT_INDEX_FILE="$t/nb1.json"
      hop2="$(node "$mjs" hop2 --nb1 "$t/nb1.json" 2>/dev/null || true)"
      [ -z "$hop2" ] || _gaffer_scout_neighbours "$canon" "$sha" "$hop2" "$t/nb2.json" || true
    fi
  fi
  node "$mjs" packet --show "$t/show.json" --named "$t/named" --files "$t/files" \
    --nb1 "$t/nb1.json" --nb2 "$t/nb2.json" --rf "$t/rf" --base-sha "$sha" --attempt "$attempt" \
    > "$t/packet0.json" 2>/dev/null || return 0
  [ -s "$t/packet0.json" ] || return 0
  node "$_GAFFER_SCOUT_LIB/risk-classify.mjs" --show "$t/show.json" --packet "$t/packet0.json" > "$t/risk.json" 2>/dev/null || : > "$t/risk.json"
  node "$mjs" with-risk --packet "$t/packet0.json" --risk "$t/risk.json" > "$t/packet.json" 2>/dev/null || return 0
  [ -s "$t/packet.json" ] || return 0
  SCOUT_PACKET_FILE="$t/packet.json"
  _gaffer_scout_refresh
  return 0
}

# Re-derive the globals from the packet file (after the model scout merges into it).
_gaffer_scout_refresh() {
  [ -n "$SCOUT_PACKET_FILE" ] && [ -s "$SCOUT_PACKET_FILE" ] || return 0
  SCOUT_PROMPT="$(node "$_GAFFER_SCOUT_LIB/scout.mjs" summary --packet "$SCOUT_PACKET_FILE" 2>/dev/null || true)"
  SCOUT_RISK="$(gaffer_json expr '(d.risk && d.risk.effective) || ""' --file "$SCOUT_PACKET_FILE" 2>/dev/null || true)"
  SCOUT_RAISED="$(gaffer_json expr 'd.risk && d.risk.raised ? "risk raised to " + d.risk.effective + " (declared " + d.risk.declared + "): " + d.risk.signals.filter((s) => s.raises).map((s) => s.detail).join(", ") : ""' --file "$SCOUT_PACKET_FILE" 2>/dev/null || true)"
  return 0
}

# gaffer_scout_persist <ticket> <attempt> — keep the packet under
# $GAFFER_DATA/scout/ticket-<n>/attempt-<k>.json (this attempt's record) and record it on
# the ticket as a system event (`wg ticket scout-record`: Review's backing row, Health's
# scout coverage). Fail-soft; never in a DRY_RUN.
gaffer_scout_persist() {
  local num="${1:-}" attempt="${2:-0}"
  [ -n "$SCOUT_PACKET_FILE" ] && [ -s "$SCOUT_PACKET_FILE" ] && [ -n "$num" ] || return 0
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  case "$num$attempt" in *[!0-9]*) return 0 ;; esac
  if [ -n "${GAFFER_DATA:-}" ]; then
    mkdir -p "$GAFFER_DATA/scout/ticket-$num" 2>/dev/null \
      && cp "$SCOUT_PACKET_FILE" "$GAFFER_DATA/scout/ticket-$num/attempt-$attempt.json" 2>/dev/null || true
  fi
  if type wg >/dev/null 2>&1; then
    wg ticket scout-record "$num" --file "$SCOUT_PACKET_FILE" --as system >/dev/null 2>&1 \
      || { type log >/dev/null 2>&1 && log "SCOUT: could not record the scout packet on #$num (a measurement only)" || true; }
  fi
  return 0
}

# gaffer_scout_selection <ticket> <attempt> <skills> <lenses> <model> <file-cards block>
# — append one line to $GAFFER_DATA/context-selection.jsonl (B0): the files, cards and
# skills this launch was given and why, the scout's coverage, the model and the router's
# reasons. Telemetry only; fail-soft; never in a DRY_RUN.
gaffer_scout_selection() {
  [ -n "${GAFFER_DATA:-}" ] && [ "${DRY_RUN:-0}" != "1" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  local num="${1:-}" attempt="${2:-}" cards
  cards="$(mktemp "${TMPDIR:-/tmp}/gaffer-sel.XXXXXX" 2>/dev/null)" || return 0
  printf '%s\n' "${6:-}" > "$cards" 2>/dev/null
  {
    node "$_GAFFER_SCOUT_LIB/scout.mjs" selection --packet "${SCOUT_PACKET_FILE:-/nonexistent}" \
      --ticket "$num" --attempt "$attempt" --skills "${3:-}" --lenses "${4:-}" --model "${5:-}" \
      --route "$GAFFER_DATA/.route/$num.implement.json" --cards "$cards" \
      >> "$GAFFER_DATA/context-selection.jsonl"
  } 2>/dev/null || true
  rm -f "$cards"
  return 0
}

# _gaffer_scout_rank <level> → 0..3
_gaffer_scout_rank() {
  case "${1:-}" in low) echo 0 ;; high) echo 2 ;; critical) echo 3 ;; *) echo 1 ;; esac
}

# gaffer_model_scout <ticket> <real_repo> <base_sha> — the bounded MODEL scout (B2). Runs
# only when GAFFER_SCOUT=on, or auto with an effective risk of medium or higher, never in a
# DRY_RUN, never during a usage pause. ONE call through worker_deliver (budget admission:
# GAFFER_LAUNCH_KIND=scout) from an empty scratch cwd that carries the verified safety-hook
# settings, the real repo as its only READ root, built-in tools limited to Read, Grep and
# Glob (everything else denied by name too), an empty MCP config, its turn cap
# (GAFFER_ROLE_MAX_TURNS scout=, built in 6).
# Booked in the usage ledger as kind `scout`. Its reply is validated against the base tree
# (lib/scout.mjs merge-model) and merged into the packet as "scout suggested".
gaffer_model_scout() {
  local num="${1:-}" repo="${2:-}" sha="${3:-}"
  [ -n "$SCOUT_PACKET_FILE" ] && [ -s "$SCOUT_PACKET_FILE" ] || return 0
  case "${GAFFER_SCOUT:-off}" in
    on) ;;
    auto) [ "$(_gaffer_scout_rank "$SCOUT_RISK")" -ge 1 ] || return 0 ;;
    *) return 0 ;;
  esac
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  [ -n "$num" ] && [ -n "$repo" ] && [ -d "$repo" ] && [ -n "$sha" ] || return 0
  type worker_deliver >/dev/null 2>&1 && type gaffer_write_agent_settings >/dev/null 2>&1 || return 0
  # Read-only is a claude-code promise (--tools Read,Grep,Glob): the command worker
  # contract can only say "all tools" or "none", so under it the scout does not run.
  if [ "${GAFFER_WORKER_PROVIDER:-claude-code}" != "claude-code" ]; then
    type log >/dev/null 2>&1 && log "SCOUT: model scout for #$num skipped — the ${GAFFER_WORKER_PROVIDER} worker cannot be limited to Read, Grep and Glob" || true
    return 0
  fi
  local cli="${CREW_DIR:-}/dist/runtime/context/renderPromptCli.js"
  [ -f "$cli" ] || return 0
  if declare -F gaffer_usage_pause_active >/dev/null 2>&1 && gaffer_usage_pause_active >/dev/null 2>&1; then
    type log >/dev/null 2>&1 && log "SCOUT: model scout for #$num skipped — usage pause active" || true
    return 0
  fi
  local t="$_SCOUT_TMP/model"
  mkdir -p "$t/cwd" 2>/dev/null || return 0
  if ! gaffer_write_agent_settings "$t/cwd"; then
    type log >/dev/null 2>&1 && log "SCOUT: model scout for #$num skipped — its safety-hook settings could not be rendered and verified" || true
    return 0
  fi
  printf '{"mcpServers":{}}' > "$t/mcp.json"
  local prompt
  # The ticket JSON goes by FILE (gaffer_scout_run wrote it): a long ticket's show JSON
  # can pass the per-variable environment limit, and the render would fail with E2BIG.
  prompt="$(SC_NUM="$num" SC_REPO="$repo" SC_RISK="$SCOUT_RISK" SC_SCOUT="$SCOUT_PROMPT" SC_SHOW_FILE="$_SCOUT_TMP/show.json" node -e '
    const e = process.env; let t = {};
    try { t = (JSON.parse(require("node:fs").readFileSync(e.SC_SHOW_FILE, "utf8") || "{}").ticket) || {}; } catch {}
    let scout = null; try { scout = JSON.parse(e.SC_SCOUT || "null"); } catch {}
    process.stdout.write(JSON.stringify({ kind: "scout", ticketNumber: e.SC_NUM, title: String(t.title || ""),
      description: String(t.description || ""), repoPath: e.SC_REPO, risk: e.SC_RISK || "medium", scout }));
  ' 2>/dev/null | node "$cli" 2>/dev/null)" || return 0
  [ -n "$prompt" ] || return 0
  # The model: GAFFER_ROLE_MODELS scout=, else the deprecated GAFFER_SCOUT_MODEL_FLAG
  # (a whole flag), else the router's scout phase (cheap tier).
  local flag="" model=""
  declare -F gaffer_role_model >/dev/null 2>&1 && model="$(gaffer_role_model scout)"
  if [ -n "$model" ]; then flag="--model $model"; else flag="${GAFFER_SCOUT_MODEL_FLAG:-}"; fi
  model=""
  if [ -z "$flag" ] && declare -F gaffer_route_model >/dev/null 2>&1; then
    model="$(gaffer_route_model scout "$SCOUT_RISK" 0 "${STACK:-}" 1 "$num" 2>/dev/null || true)"
    [ -n "$model" ] && flag="--model $model"
  fi
  local turns=6 rc=0 _wrc=""
  declare -F gaffer_role_cap >/dev/null 2>&1 && turns="$(gaffer_role_cap scout 6)"
  declare -F gaffer_role_turns >/dev/null 2>&1 && turns="$(gaffer_role_turns "$turns")"
  # The overrides stay local to this subshell: CLAUDE_FLAGS is REPLACED (no acceptEdits;
  # the write and shell tools denied by name on top of --tools), the boundary is the
  # scratch cwd (write) and the real repo (read).
  (
    # shellcheck disable=SC2034  # read by worker_deliver
    CLAUDE_FLAGS="--disallowedTools Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite"
    # shellcheck disable=SC2034  # read by worker_deliver
    WORKER_CALL_ENV=("GAFFER_WRITE_ROOTS=$t/cwd" "GAFFER_READ_ROOTS=$repo")
    GAFFER_LAUNCH_KIND=scout worker_deliver "$t/cwd" "$prompt" "$flag" "$t/mcp.json" "$t/envelope.json" "" \
      "$turns" --tools "Read,Grep,Glob" --strict-mcp-config --disable-slash-commands >/dev/null 2>&1
    _wrc=$?
    echo "$_wrc" > "$t/rc"
    # Booked whenever a call was spawned, an empty envelope too (a timeout or a kill: the
    # ledger books its estimate, so the spend caps see it). The runner's own refusals
    # (70 provider, 75 sandbox, 76 bridge, 77 budget) spawned nothing and book nothing.
    case "$_wrc" in 70 | 75 | 76 | 77) [ -s "$t/envelope.json" ] || _wrc="" ;; esac
    if type gaffer_usage_record >/dev/null 2>&1 && [ -n "$_wrc" ]; then
      GAFFER_USAGE_REPO="${_CARD_REPO_NAME:-}" GAFFER_USAGE_RISK="$SCOUT_RISK" \
        gaffer_usage_record scout "$num" "$(cat "$t/rc")" "$t/envelope.json" >/dev/null 2>&1 || true
    fi
  )
  rc="$(cat "$t/rc" 2>/dev/null || echo 1)"
  if declare -F gaffer_usage_pause_record >/dev/null 2>&1 && [ -s "$t/envelope.json" ]; then
    gaffer_usage_pause_record "$t/envelope.json" "$num" scout >/dev/null 2>&1 || true
  fi
  [ -s "$t/envelope.json" ] || {
    type log >/dev/null 2>&1 && log "SCOUT: model scout for #$num did not run (rc=$rc) — the deterministic packet stands" || true
    return 0
  }
  local wm="${_GAFFER_WORKER_MJS:-$_GAFFER_SCOUT_LIB/worker.mjs}" spend
  node "$wm" parse-result result-text --json-file "$t/envelope.json" > "$t/reply" 2>/dev/null || : > "$t/reply"
  spend="$(node "$wm" parse-result spend --json-file "$t/envelope.json" 2>/dev/null || echo unknown)"
  SC_SPEND="${spend#\$}" SC_MODEL="${model:-${flag#--model }}" node -e '
    const c = Number(process.env.SC_SPEND); process.stdout.write(JSON.stringify({
      cost_usd: Number.isFinite(c) ? c : null, model: process.env.SC_MODEL || null }));' > "$t/usage.json" 2>/dev/null
  if node "$_GAFFER_SCOUT_LIB/scout.mjs" merge-model --packet "$SCOUT_PACKET_FILE" --reply "$t/reply" \
       --files "$_SCOUT_TMP/files" --repo "$repo" --base-sha "$sha" --usage "$t/usage.json" > "$t/merged.json" 2>/dev/null \
     && [ -s "$t/merged.json" ]; then
    mv -f "$t/merged.json" "$SCOUT_PACKET_FILE" 2>/dev/null || true
    _gaffer_scout_refresh
    type log >/dev/null 2>&1 && log "SCOUT: model scout for #$num: $(gaffer_json expr '(d.model_scout ? d.model_scout.kept_files + " file(s) kept, " + (d.model_scout.dropped_files + d.model_scout.dropped_symbols) + " dropped, " + (d.model_scout.notes || []).length + " note(s)" : "")' --file "$SCOUT_PACKET_FILE" 2>/dev/null) (spend ${spend})" || true
  fi
  return 0
}
