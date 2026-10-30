#!/usr/bin/env bash
# =====================================================================
# The claim / concurrency / lifecycle tests are the ONLY guard on the dispatch
# CLI contract they drive (`agent register` → d.agent.id, `ticket create` → a
# number). They used to `echo SKIP; exit 0` when that contract broke, so a
# regression in exactly what they guard turned them GREEN.
#
# This meta-test simulates the regression with a PATH `node` shim that forwards
# to the real node but (a) renames "id" → "agentId" in `agent register` output
# (exit 0 — a shape change, not a crash) and (b) with TICKET_BREAK=1 makes
# `ticket create` exit 1. Every listed test must then FAIL (non-zero, not 77)
# with its contract message ("… the dispatch CLI contract this test guards") —
# so a timeout or an unrelated crash does not count — and must not report a SKIP.
# Run: bash runner/test/cli-contract-regression.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI_JS" ] || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cli-contract-regression.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REAL_NODE="$(command -v node)"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/node" <<SH
#!/usr/bin/env bash
args=" \$* "
if [[ "\$args" == *" agent register "* ]]; then
  out="\$("$REAL_NODE" "\$@")"; rc=\$?
  printf '%s' "\$out" | sed 's/"id"/"agentId"/g'; exit \$rc
fi
if [ -n "\${TICKET_BREAK:-}" ] && [[ "\$args" == *" ticket create "* ]]; then echo "boom" >&2; exit 1; fi
exec "$REAL_NODE" "\$@"
SH
chmod +x "$WORK/bin/node"

# Sanity: the shim really breaks the contract (else this test proves nothing).
"$WORK/bin/node" "$CLI_JS" --db "$WORK/probe.sqlite" init >/dev/null 2>&1
REG="$("$WORK/bin/node" "$CLI_JS" --db "$WORK/probe.sqlite" agent register -n p --max-risk high 2>/dev/null)"
grep -q '"agentId"' <<<"$REG" && ! grep -q '"id"' <<<"$REG" \
  && ok "shim: agent register output lost d.agent.id" || fail "shim did not rewrite agent register output: ${REG:0:200}"

check() { # <test> [ENV=VAL …]
  local t="$1"; shift
  local out rc
  out="$(env PATH="$WORK/bin:$PATH" "$@" perl -e 'alarm shift; exec @ARGV' 120 bash "$HERE/$t.test.sh" 2>&1 </dev/null)"; rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 77 ] && ! grep -qE '^[[:space:]]*(ok[[:space:]]+)?SKIP' <<<"$out" \
     && grep -q 'FAIL.*the dispatch CLI contract this test guards' <<<"$out"; then
    ok "$t FAILS (rc $rc) when the CLI contract breaks"
  else
    fail "$t did not fail on a CLI contract regression (rc $rc): $(grep -E 'SKIP|FAIL' <<<"$out" | head -2 | tr '\n' ' ')"
  fi
}

for t in bootstrap-park-visible concurrency-bookkeeping e2e-afk-autonomous-ship human-claim-skip \
         nocommit-crash-bound parallel-claim runner-claim-at-selection tick-unrecoverable-claim-release; do
  check "$t"
done
check ac-checks TICKET_BREAK=1
check delivery-lifecycle TICKET_BREAK=1
check dod-gate

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "cli-contract-regression: ALL $PASS checks passed"; exit 0
fi
echo "cli-contract-regression: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
