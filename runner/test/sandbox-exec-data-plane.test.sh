#!/usr/bin/env bash
# =====================================================================
# The macOS (sandbox-exec) profiles never let sandboxed code write the host's control
# files under $GAFFER_DATA (sandbox audit F1b/F1c).
# ---------------------------------------------------------------------
# The agent profile used to grant writes to the whole of $GAFFER_DATA, so code the agent
# wrote (or a test the gates ran) could rewrite settings.json, clear the usage pause,
# truncate the usage ledger, plant a skill or replace another worker's MCP config, and the
# next runner process (outside the sandbox) obeyed. Now:
#   D1  the AGENT profile grants writes under $GAFFER_DATA only to the in-sandbox writers'
#       files (the databases with their SQLite siblings, the crew events log, the hook's
#       two ledgers) and its write roots; every control file is denied, also when a temp
#       grant or a write root contains $GAFFER_DATA, and no parent of it can be renamed;
#   D2  the VALIDATION profile (the gates) has no $GAFFER_DATA grant at all beyond its
#       write roots, and no HOME grant;
#   D3  the set the agent profile lets a process write equals the set the docker
#       provider's legacy layout leaves unmasked (lib/sandbox-docker.sh), so the two
#       providers keep one data plane;
#   D4  on macOS the kernel agrees: a sandboxed append to settings.json fails, a sqlite
#       write to the dispatch database succeeds, a rename of $GAFFER_DATA fails, and a hard
#       link does not carry a write through to settings.json.
# D1-D3 read REAL generated profiles through runner/test/lib/sbpl-eval.mjs (an evaluator
# for the SBPL subset lib/sandbox.sh writes), so they run on every host. D4 needs macOS.
# Run: bash runner/test/sandbox-exec-data-plane.test.sh   (bash 3.2 safe)
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
. "$(dirname "${BASH_SOURCE[0]}")/lib/skip.sh"
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir sbx-data-plane)" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT
EVAL="$HERE/lib/sbpl-eval.mjs"

# HOME is a path OUTSIDE every temp root (it need not exist: profiles are generated, and
# evaluated, as text), so a HOME grant is told apart from the temp grant that would
# otherwise contain it. The kernel section (D4) uses no HOME path.
export HOME="/nonexistent-gaffer-test-home.$$" GAFFER_DATA="$WORK/data"
unset DISPATCH_DB MEMORY_DB GAFFER_CREW_EVENTS GAFFER_USAGE_LEDGER CLAUDE_CONFIG_DIR
export GAFFER_CREW_EVENTS="$GAFFER_DATA/events.jsonl"
export STRICT_ALLOW_NETWORK=1 STRICT_ALLOW_HOME="$HOME/.claude $HOME/.cache"
WT="$GAFFER_DATA/worktrees/ticket-1"
mkdir -p "$WT" "$GAFFER_DATA/worktrees/ticket-2"
# shellcheck source=../lib/sandbox.sh
source "$RUNNER_DIR/lib/sandbox.sh"

D="$GAFFER_DATA"
# What sandboxed code must never write (who trusts each: docs/sandbox.md).
CONTROL="$D/settings.json $D/.settings.123.0a1b.tmp $D/settings.json.bak $D/usage-pause.json $D/.usage-pause.lock
$D/usage-ledger.jsonl $D/usage-ledger.held.jsonl $D/.ledger.lock $D/eval-ledger.jsonl $D/delivery-metrics.jsonl
$D/.failed-tickets $D/.reviewed-tickets $D/.tester-held $D/.merge-held-tickets $D/.daily-ticks $D/.route/7.deliver.json
$D/.workers/w1 $D/crew.yaml $D/mcp-runtime.4242.json $D/mcp-product-owner-runtime.json $D/strict-profile.4242.AbC123
$D/sandbox-write-roots.4242.x $D/worker-prompt.4242.x $D/dashboard-token $D/dashboard-url $D/dashboard.pid
$D/acceptance-signing.key $D/agent_id $D/agent_reviewer_id $D/factory.log $D/skills-mounts/k/SKILL.md
$D/memory-audit.jsonl $D/audit.jsonl $D/locks/l $D/run-state/r $D/manifests/7-1.json
$D/worktrees/ticket-2/src/x.js $D $WORK"
# What the in-sandbox writers need.
WRITERS="$D/dispatch.sqlite $D/dispatch.sqlite-wal $D/dispatch.sqlite-shm $D/dispatch.sqlite-journal
$D/memory.sqlite $D/memory.sqlite-wal $D/memory.sqlite-shm $D/memory.sqlite-journal
$D/events.jsonl $D/safety-blocks.jsonl $D/tool-metrics.jsonl"

# expect <profile> <allow|deny> <label> <path>...: every path gets the verdict.
expect() {
  local prof="$1" want="$2" label="$3" out bad
  shift 3
  # shellcheck disable=SC2068  # one path per word on purpose
  out="$(node "$EVAL" "$prof" write $@ 2>&1)" || { fail "$label: the evaluator refused the profile: $out"; return; }
  bad="$(printf '%s\n' "$out" | grep -v "^$want " || true)"
  [ -z "$bad" ] && ok "$label" || fail "$label: $(printf '%s' "$bad" | tr '\n' ';')"
}

echo "== D1: the agent profile =="
PA="$WORK/agent.sb"
GAFFER_SANDBOX_PROFILE="" _sandbox_exec_profile "$WT" "$PA" "" || fail "D1: the agent profile was refused"
grep -q '^;; variant: agent$' "$PA" && ok "D1: the profile says it is the agent variant" || fail "D1: no variant line"
# No allow form grants the whole of $GAFFER_DATA any more.
if awk '/^\(allow file-write\*/{a=1} a&&/^\)|\)\)$/{a=0} a' "$PA" | grep -qF "(subpath \"$D\")"; then
  fail "D1: an allow form still grants (subpath \"\$GAFFER_DATA\")"
else ok "D1: no allow form grants the whole of \$GAFFER_DATA"; fi
expect "$PA" deny "D1: every control file under \$GAFFER_DATA (and \$GAFFER_DATA itself, its parent, a sibling worktree) is denied" $CONTROL
expect "$PA" allow "D1: the databases with their -wal/-shm/-journal, the crew events log and the hook's two ledgers stay writable" $WRITERS
expect "$PA" allow "D1: the agent's own worktree, the temp dir and ~/.claude/projects stay writable" \
  "$WT/src/a.js" "$WT/.git" /tmp/x "$HOME/.claude/projects/p/s.jsonl"
# A temp grant that contains $GAFFER_DATA (GAFFER_DATA under TMPDIR) changes nothing.
PT="$WORK/agent-tmp.sb"
TMPDIR="$WORK" GAFFER_SANDBOX_PROFILE="" _sandbox_exec_profile "$WT" "$PT" ""
expect "$PT" deny "D1: with TMPDIR containing \$GAFFER_DATA the control files are still denied" $CONTROL
expect "$PT" allow "D1: ...and the writers still allowed" $WRITERS
# A write root that contains $GAFFER_DATA (a misconfigured root): the named control files
# are still denied (the last deny block), the databases still allowed.
PW="$WORK/agent-wide.sb"
GAFFER_SANDBOX_PROFILE="" _sandbox_exec_profile "$WORK" "$PW" ""
expect "$PW" deny "D1: with a write root containing \$GAFFER_DATA the named control files are still denied" \
  "$D/settings.json" "$D/.settings.9.f.tmp" "$D/usage-pause.json" "$D/usage-ledger.jsonl" "$D/crew.yaml" \
  "$D/mcp-runtime.1.json" "$D/strict-profile.1.x" "$D/dashboard-token" "$D/agent_id" "$D/skills-mounts/x" "$D/.failed-tickets"
expect "$PW" allow "D1: ...and the databases stay writable" "$D/dispatch.sqlite" "$D/memory.sqlite-wal"
# A database moved out of $GAFFER_DATA is not granted by this profile (nothing loosened).
PX="$WORK/agent-db-out.sb"
DISPATCH_DB="$HOME/elsewhere.sqlite" GAFFER_SANDBOX_PROFILE="" _sandbox_exec_profile "$WT" "$PX" ""
expect "$PX" deny "D1: a DISPATCH_DB outside \$GAFFER_DATA gets no new grant" "$HOME/elsewhere.sqlite"
# A path that cannot be written into SBPL faithfully refuses the profile.
if GAFFER_DATA="$WORK/da\"ta" _sandbox_exec_profile "$WT" "$WORK/bad.sb" "" 2>/dev/null; then
  fail "D1: a GAFFER_DATA with a quote produced a profile"
else [ ! -s "$WORK/bad.sb" ] && ok "D1: a GAFFER_DATA holding a quote refuses the profile (fail closed)" || fail "D1: refused but a profile was left"; fi
if command -v sandbox-exec >/dev/null 2>&1; then :; else
  OUTW="$(SANDBOX_PROVIDER=sandbox-exec GAFFER_STRICT_REQUIRE=1 sandbox_wrap_cmd "$WT" "" 2>/dev/null)"; rc=$?
  [ "$rc" -ne 0 ] && [ -z "$OUTW" ] && ok "D1: with no sandbox-exec on this host the provider still refuses (fail closed)" || fail "D1: provider rc=$rc out=$OUTW"
fi

echo "== D2: the validation profile (the gates) =="
PV="$WORK/validation.sb"
GAFFER_SANDBOX_PROFILE=validation _sandbox_exec_profile "$WT" "$PV" "" || fail "D2: the validation profile was refused"
grep -q '^;; variant: validation$' "$PV" && ok "D2: the profile says it is the validation variant" || fail "D2: no variant line"
expect "$PV" deny "D2: no control file, no database, no ledger and no HOME path is writable from a gate" \
  $CONTROL $WRITERS "$HOME/.claude/projects/p" "$HOME/.cache/x"
expect "$PV" allow "D2: the gate's own worktree and the temp dir stay writable" "$WT/node_modules/.cache/x" "$WT/out.txt" /tmp/x
grep -qF "(subpath \"$HOME/.cache\")" "$PV" && fail "D2: STRICT_ALLOW_HOME is granted to a gate" || ok "D2: STRICT_ALLOW_HOME is not granted to a gate"

echo "== D3: the agent profile keeps the docker legacy layout's data plane =="
for f in $WRITERS settings.json usage-ledger.jsonl usage-pause.json crew.yaml dashboard-token mcp-runtime.1.json \
         memory-audit.jsonl audit.jsonl agent_id factory.log .failed-tickets eval-ledger.jsonl; do
  case "$f" in /*) : > "$f" ;; *) : > "$D/$f" ;; esac
done
mkdir -p "$D/skills-mounts/k" "$D/.route"
WRF="$WORK/wroots"; printf '%s\n' "$WT" > "$WRF"; RRF="$WORK/rroots"; : > "$RRF"
# The call's own MCP config: docker keeps it visible (the agent CLI reads it); sandbox-exec
# reads it under (allow default) and needs no write to it, so it is left out of the sets.
printf '{}\n' > "$D/mcp-runtime.self.json"
ARGV="$(GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=0 bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- claude --mcp-config "$D/mcp-runtime.self.json" 2>"$WORK/docker.err")"; rc=$?
if [ "$rc" -ne 0 ]; then
  fail "D3: the docker legacy dry run failed rc=$rc: $(tail -3 "$WORK/docker.err")"
else
  DOCKER_KEEP=""; EXEC_KEEP=""
  for e in "$D"/* "$D"/.[!.]*; do
    [ -f "$e" ] || continue
    [ "$e" = "$D/mcp-runtime.self.json" ] && continue
    case "$ARGV" in *"/dev/null:$e:ro"*) ;; *) DOCKER_KEEP="$DOCKER_KEEP $(basename "$e")" ;; esac
    v="$(node "$EVAL" "$PA" write "$e" | cut -d' ' -f1)"
    [ "$v" = allow ] && EXEC_KEEP="$EXEC_KEEP $(basename "$e")"
  done
  [ -n "$DOCKER_KEEP" ] && [ "$DOCKER_KEEP" = "$EXEC_KEEP" ] \
    && ok "D3: the files docker leaves visible are exactly the files sandbox-exec lets a process write:$EXEC_KEEP" \
    || fail "D3: docker keeps [$DOCKER_KEEP] but sandbox-exec allows [$EXEC_KEEP]"
fi

echo "== D4: the kernel (macOS only) =="
if [ "$(uname -s)" = Darwin ] && command -v sandbox-exec >/dev/null 2>&1; then
  printf '{"MAX_TICKS":"5"}\n' > "$D/settings.json"
  : > "$D/dispatch.sqlite"; rm -f "$D/dispatch.sqlite"
  W="$(SANDBOX_PROVIDER=sandbox-exec GAFFER_STRICT_REQUIRE=1 sandbox_wrap_cmd "$WT" "")" || fail "D4: no wrap"
  P="${W#sandbox-exec -f }"
  sb() { sandbox-exec -f "$P" "$@" 2>/dev/null; }
  sb sh -c "echo '{\"NODE_OPTIONS\":\"--require /tmp/x.js\"}' >> '$D/settings.json'"
  grep -q NODE_OPTIONS "$D/settings.json" && fail "D4: a sandboxed append to settings.json LANDED" || ok "D4: a sandboxed append to settings.json is refused by the kernel"
  sb sh -c "printf 'x' > '$D/.settings.1.f.tmp' && mv '$D/.settings.1.f.tmp' '$D/settings.json'"
  grep -q MAX_TICKS "$D/settings.json" && ok "D4: a temp-file-and-rename over settings.json is refused" || fail "D4: settings.json replaced by a rename"
  sb sh -c "printf 'x' > '$D/usage-ledger.jsonl'"; [ -s "$D/usage-ledger.jsonl" ] && fail "D4: the usage ledger was written" || ok "D4: the usage ledger cannot be written"
  if command -v sqlite3 >/dev/null 2>&1; then
    if sb sqlite3 "$D/dispatch.sqlite" 'pragma journal_mode=wal; create table t(x); insert into t values(1);' >/dev/null \
       && [ "$(sqlite3 "$D/dispatch.sqlite" 'select count(*) from t')" = 1 ]; then
      ok "D4: a sandboxed sqlite write (WAL mode) to the dispatch database succeeds"
    else fail "D4: a sandboxed sqlite write to the dispatch database failed"; fi
  else
    gaffer_skip_part "D4 sqlite: the sqlite3 CLI is missing on this macOS host (sandbox-exec check of the database grant)"
  fi
  sb sh -c "echo ok > '$WT/inside.txt'"; [ -f "$WT/inside.txt" ] && ok "D4: a write in the worktree succeeds" || fail "D4: the worktree write was refused"
  sb mv "$D" "$WORK/moved-data"
  [ -d "$D" ] && [ ! -e "$WORK/moved-data" ] && ok "D4: \$GAFFER_DATA cannot be renamed away" || { fail "D4: \$GAFFER_DATA was renamed"; [ -d "$WORK/moved-data" ] && mv "$WORK/moved-data" "$D"; }
  rm -f "$WORK/sl"
  sb sh -c "ln '$D/settings.json' '$WORK/sl' && echo '{\"BASH_ENV\":\"/tmp/x\"}' >> '$WORK/sl'"
  grep -q BASH_ENV "$D/settings.json" && fail "D4: a hard link carried a write through to settings.json" || ok "D4: no hard link carries a write through to settings.json"
  rm -f "$WORK/sl"
  PVK="$(GAFFER_SANDBOX_PROFILE=validation SANDBOX_PROVIDER=sandbox-exec GAFFER_STRICT_REQUIRE=1 sandbox_wrap_cmd "$WT" "")"; PVK="${PVK#sandbox-exec -f }"
  sandbox-exec -f "$PVK" sqlite3 "$D/dispatch.sqlite" 'insert into t values(2);' >/dev/null 2>&1
  [ "$(sqlite3 "$D/dispatch.sqlite" 'select count(*) from t' 2>/dev/null)" = 1 ] && ok "D4: a gate (validation profile) cannot write the dispatch database" || fail "D4: a gate wrote the dispatch database"
else
  gaffer_skip_part "D4: kernel enforcement needs macOS sandbox-exec (the profile meaning is asserted above on every host)"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "sandbox-exec-data-plane: ALL $PASS checks passed"
  exit 0
fi
echo "sandbox-exec-data-plane: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
