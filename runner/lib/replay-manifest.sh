# runner/lib/replay-manifest.sh: the REPLAY MANIFEST of each delivery attempt (delta
# roadmap gap 4, P0). tick.sh gathers; lib/replay-manifest.mjs builds and writes.
# shellcheck shell=bash
#
# One file per attempt, $GAFFER_DATA/manifests/<ticket>-<n>.json: opened right before the
# agent is spawned (gaffer_manifest_start), completed where the attempt ends
# (gaffer_manifest_finish: the submit, a gate's rework or park, a pause at a cap; a release
# through gaffer_release_delivery covers the usage-window, auth and budget refusals and
# every other park), and closed by the crash trap when nothing else did (gaffer_manifest_close:
# `killed` on a signal, `ended` otherwise). Later facts (a lane verdict, the landed sha) are
# added to the ticket's latest manifest (gaffer_manifest_annotate).
#
# A measurement: nothing reads a manifest to decide anything on the live path. Every call
# is FAIL-SOFT (a failure is logged and the delivery carries on) and a no-op in a DRY_RUN.
# The manifest holds hashes of the prompt and the scout packet, never their text, and no
# secrets (lib/replay-manifest.mjs says exactly what it keeps).
_GAFFER_MANIFEST_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAFFER_MANIFEST_FILE=""

_gaffer_manifest_log() { type log >/dev/null 2>&1 && log "MANIFEST: $*"; return 0; }
# The manifest's GAFFER_SCOUT_PACKET setting: 1 when the deterministic packet is built,
# 0 when GAFFER_SCOUT=none (or the deprecated GAFFER_SCOUT_PACKET=0) turned it off.
_gaffer_manifest_packet_on() {
  if [ "${GAFFER_SCOUT:-off}" = none ] || [ "${GAFFER_SCOUT_PACKET:-1}" = 0 ]; then printf 0; else printf 1; fi
}

# _gaffer_manifest_heads <file>: one `name<TAB>head` row per write repo ($WT_ROWS): the
# commit the ticket branch holds in the real repo now.
_gaffer_manifest_heads() {
  local out="$1" rname rpath h
  : > "$out" 2>/dev/null || return 0
  [ -n "${WORK_BRANCH:-}" ] || return 0
  while IFS=$'\t' read -r _ rname rpath _ _; do
    [ -n "$rpath" ] || continue
    h="$(git -C "$rpath" rev-parse --verify --quiet "refs/heads/$WORK_BRANCH" 2>/dev/null || true)"
    [ -n "$h" ] && printf '%s\t%s\n' "$rname" "$h" >> "$out"
  done <<< "${WT_ROWS:-}"
  return 0
}

# gaffer_manifest_start <prompt>: open this attempt's manifest. Reads the delivery's
# globals: NUM, SHOW, WT_ROWS, _DELIV_BASE_SHAS, _DELIV_ATTEMPT, _MAX_DELIVERY_ATTEMPTS,
# GAFFER_USAGE_ATTEMPT_ID / GAFFER_USAGE_STARTED_AT (the ledger join key), ROUTE_RISK (the
# effective risk), ROUTE_AC, ROUTE_ATTEMPT, _ATTEMPT_IMPL_FLAG, SKILLS, LENSES,
# PRODUCT_CONTEXT_BLOCK, FILE_CARDS_BLOCK, _RESUMING. Sets GAFFER_MANIFEST_FILE.
gaffer_manifest_start() {
  GAFFER_MANIFEST_FILE=""
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  [ -n "${GAFFER_DATA:-}" ] && [ -n "${NUM:-}" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  local mjs="$_GAFFER_MANIFEST_LIB/replay-manifest.mjs" dir="$GAFFER_DATA/manifests" tmp out
  [ -f "$mjs" ] || return 0
  tmp="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/gaffer-manifest.XXXXXX" 2>/dev/null)" || { _gaffer_manifest_log "could not open the manifest for #$NUM (no temp dir); the delivery continues"; return 0; }
  printf '%s' "${SHOW:-}" > "$tmp/show.json" 2>/dev/null
  printf '%s\n' "${WT_ROWS:-}" > "$tmp/repos.tsv" 2>/dev/null
  printf '%s' "${_DELIV_BASE_SHAS:-}" > "$tmp/bases.tsv" 2>/dev/null
  local model="${_ATTEMPT_IMPL_FLAG:-}"; model="${model#--model }"; model="${model#--model=}"
  out="$(printf '%s' "${1:-}" | GAFFER_SCOUT="${GAFFER_SCOUT:-}" GAFFER_SCOUT_PACKET="$(_gaffer_manifest_packet_on)" \
      GAFFER_TESTING="${GAFFER_TESTING:-}" GAFFER_WORKER_PROVIDER="${GAFFER_WORKER_PROVIDER:-claude-code}" \
      STRICT_MODE="${STRICT_MODE:-}" SANDBOX_PROVIDER="${SANDBOX_PROVIDER:-}" \
      GAFFER_MAX_DELIVERY_ATTEMPTS="${_MAX_DELIVERY_ATTEMPTS:-}" REVIEW_MODE="${REVIEW_MODE:-}" GAFFER_MODE="${GAFFER_MODE:-}" \
      node "$mjs" start --dir "$dir" --ticket "$NUM" \
        --attempt "${_DELIV_ATTEMPT:-1}" --max-attempts "${_MAX_DELIVERY_ATTEMPTS:-}" \
        --attempt-id "${GAFFER_USAGE_ATTEMPT_ID:-}" --started-at "${GAFFER_USAGE_STARTED_AT:-}" \
        --show-file "$tmp/show.json" --repos-file "$tmp/repos.tsv" --bases-file "$tmp/bases.tsv" \
        --route-file "$GAFFER_DATA/.route/$NUM.implement.json" \
        --packet-file "$GAFFER_DATA/scout/ticket-$NUM/attempt-${ROUTE_ATTEMPT:-0}.json" \
        --risk-effective "${ROUTE_RISK:-}" --ac-count "${ROUTE_AC:-}" --attempt-model "${model:-default}" \
        --skills "${SKILLS:-}, ${LENSES:-}" \
        --product-context "$([ -n "${PRODUCT_CONTEXT_BLOCK:-}" ] && echo 1 || echo 0)" \
        --file-cards "$([ -n "${FILE_CARDS_BLOCK:-}" ] && echo 1 || echo 0)" \
        --resumed "${_RESUMING:-0}" --prompt-stdin 2>"$tmp/err")"
  local rc=$?
  # stdout is the path alone (a warning on stderr can no longer garble it and leave a
  # written manifest untracked, open for good).
  out="$(printf '%s' "$out" | tail -n 1)"
  if [ "$rc" -eq 0 ] && [ -f "$out" ]; then
    GAFFER_MANIFEST_FILE="$out"
  else
    _gaffer_manifest_log "could not write the replay manifest for #$NUM ($(tail -n 1 "$tmp/err" 2>/dev/null | cut -c1-200)); the delivery continues"
  fi
  rm -rf "$tmp"
  return 0
}

# gaffer_manifest_gates <dod-results-file>: keep this attempt's gate rows (GATE name repo
# status) beside the open manifest, read by the finish. The results file is removed by
# tick.sh right after the gates run.
gaffer_manifest_gates() {
  [ -n "$GAFFER_MANIFEST_FILE" ] && [ -f "${1:-}" ] || return 0
  awk -F'\t' '$1=="GATE"{print $1"\t"$2"\t"$3"\t"$4}' "$1" > "$GAFFER_MANIFEST_FILE.gates" 2>/dev/null || true
  return 0
}

# gaffer_manifest_finish <outcome> [rc]: complete this attempt's manifest. The first
# outcome wins: a later call for the same attempt is a no-op.
gaffer_manifest_finish() {
  [ -n "$GAFFER_MANIFEST_FILE" ] || return 0
  local f="$GAFFER_MANIFEST_FILE" heads="$GAFFER_MANIFEST_FILE.heads"
  GAFFER_MANIFEST_FILE=""
  _gaffer_manifest_heads "$heads"
  node "$_GAFFER_MANIFEST_LIB/replay-manifest.mjs" finish --file "$f" --outcome "${1:-ended}" \
    --rc "${2:-${rc:-}}" --gates-file "$f.gates" --heads-file "$heads" >/dev/null 2>&1 \
    || _gaffer_manifest_log "could not complete the replay manifest $f (${1:-ended})"
  rm -f "$heads" "$f.gates" 2>/dev/null
  return 0
}

# gaffer_manifest_close <signal|exit>: the crash trap's catch-all for a manifest no
# outcome completed: `killed` on a signal, `ended` on any other exit.
gaffer_manifest_close() {
  [ -n "$GAFFER_MANIFEST_FILE" ] || return 0
  local f="$GAFFER_MANIFEST_FILE" heads="$GAFFER_MANIFEST_FILE.heads"
  GAFFER_MANIFEST_FILE=""
  _gaffer_manifest_heads "$heads"
  node "$_GAFFER_MANIFEST_LIB/replay-manifest.mjs" close --file "$f" \
    --cause "$([ "${1:-exit}" = signal ] && echo signal || echo exit)" --heads-file "$heads" >/dev/null 2>&1 || true
  rm -f "$heads" "$f.gates" 2>/dev/null
  return 0
}

# gaffer_manifest_annotate <ticket> <lane> <verdict> | <ticket> --landed <sha>: add a later
# fact to the ticket's latest manifest (the judging lanes' verdicts, the landed commit).
gaffer_manifest_annotate() {
  [ -n "${GAFFER_DATA:-}" ] && [ -n "${1:-}" ] || return 0
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  [ -d "$GAFFER_DATA/manifests" ] || return 0
  if [ "${2:-}" = "--landed" ]; then
    node "$_GAFFER_MANIFEST_LIB/replay-manifest.mjs" annotate --dir "$GAFFER_DATA/manifests" \
      --ticket "$1" --landed-sha "${3:-}" >/dev/null 2>&1 || true
  else
    node "$_GAFFER_MANIFEST_LIB/replay-manifest.mjs" annotate --dir "$GAFFER_DATA/manifests" \
      --ticket "$1" --lane "${2:-}" --verdict "${3:-}" >/dev/null 2>&1 || true
  fi
  return 0
}
