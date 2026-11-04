# shellcheck shell=bash
# runner/config/17-cli.sh: the CLI helpers: the dist bins, the DB-var fail-closed guard, wg / fg / lg
# and the JSON helpers.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# CLI helpers (use the built dist bins)
# memory-mcp uses its own bin layout + the MEMORY_DB env var (no --db flag).
: "${MEMORY_CLI_BIN:=$MEMORY_DIR/dist/bin/memory.js}"
: "${MEMORY_MCP_BIN:=$MEMORY_DIR/dist/bin/memory-mcp.js}"
: "${DISPATCH_MCP_BIN:=$DISPATCH_DIR/dist/mcp/bin.js}"   # substituted into .mcp.json by tick.sh

# --- DB-var fail-CLOSED guard (P1-B) -----------------------------------------
# The .mcp.json ships "${DISPATCH_DB}" / "${MEMORY_DB}" placeholders that
# tick.sh sed-substitutes, and the lg/wg wrappers + the memory server launch
# pass these through to the MCP servers. If either var is EMPTY/unset, the sed
# substitution writes a literal value and a stray DB file named e.g.
# `${MEMORY_DB}` gets created in cwd — and the MCP servers silently point at
# the wrong (empty-named) database. Fail CLOSED instead: assert both are
# non-empty before any consumption, with a clear, actionable error.
#
# Call this immediately before a sed-substitution of the MCP config OR before
# launching anything (lg/wg/memory server) that relies on these vars.
gaffer_assert_db_vars() {
  local missing=()
  [ -n "${DISPATCH_DB:-}" ] || missing+=("DISPATCH_DB")
  [ -n "${MEMORY_DB:-}" ]  || missing+=("MEMORY_DB")
  if [ "${#missing[@]}" -gt 0 ]; then
    printf 'gaffer: refusing to run — required DB var(s) empty/unset: %s\n' "${missing[*]}" >&2
    printf 'gaffer: set them (factory.config.sh defaults to $GAFFER_DATA/*.sqlite) so the MCP\n' >&2
    printf 'gaffer: servers point at a real database and no literal-named ${...} DB file is\n' >&2
    printf 'gaffer: created in the working directory.\n' >&2
    return 1
  fi
  return 0
}

wg() { gaffer_assert_db_vars || return 1; node "$DISPATCH_DIR/dist/cli/index.js" --db "$DISPATCH_DB" "$@"; }
# fg pins crew to the factory's $DISPATCH_DB (CREW_DISPATCH_DB beats crew.yaml's
# sqlite_path), so a drifted crew.yaml can't send drafts to a DB nobody reads.
# It also names the factory's memory store and the brownfield decomposer, as crew
# FALLBACKS (an explicit crew.yaml value wins): CREW_MEMORY_MCP_BIN + MEMORY_DB give
# the async idle loops a real memory client on the factory DB, CREW_DECOMPOSE_SCRIPT
# gives the feature-backlog loop its decomposer. Without them a `crew init` config
# left both null and the Settings "Feature backlog" toggle could never run.
fg() {
  CREW_DISPATCH_DB="${DISPATCH_DB:-}" MEMORY_DB="${MEMORY_DB:-}" \
  CREW_MEMORY_MCP_BIN="${CREW_MEMORY_MCP_BIN:-${MEMORY_MCP_BIN:-}}" \
  CREW_DECOMPOSE_SCRIPT="${CREW_DECOMPOSE_SCRIPT:-$RUNNER_DIR/bin/decompose.mjs}" \
    node "$CREW_DIR/dist/cli/index.js" -c "$CREW_CONFIG" "$@"
}
lg() { gaffer_assert_db_vars || return 1; MEMORY_DB="$MEMORY_DB" node "$MEMORY_CLI_BIN" "$@"; }

# The runner's JSON helpers (node — lib/json-tool.mjs replaces the former inline
# python3 programs; python3 is no longer a runtime dependency).
#   gaffer_json <subcommand> [args]   — see the table in lib/json-tool.mjs
#   jget '<js expression over d>'      — stdin JSON → d; prints the value ("" for
#                                        null); a parse/eval failure exits 1 with
#                                        no output so `|| echo <default>` applies.
gaffer_json() { node "$RUNNER_DIR/lib/json-tool.mjs" "$@"; }
jget() { gaffer_json expr "$1"; }

_GAFFER_CONFIG_PART=17-cli
