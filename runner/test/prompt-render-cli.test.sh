#!/usr/bin/env bash
# =====================================================================
# P1b prompt-render CLI (docs/tick-sh-runtime-migration.md) — proves the typed
# delivery/bootstrap PROMPT entrypoint
# (packages/crew/src/runtime/context/renderPromptCli.ts) renders BYTE-IDENTICALLY
# to the REAL bash heredoc, via the captured golden.
# ---------------------------------------------------------------------
# This is the prompt analogue of runner/test/mcp-render-parity.test.sh, at the
# stage BEFORE the live tick.sh seam is wired: the CLI exists and is proven
# equal to the captured bash prompt (packages/crew/test/fixtures/tick-context/
# prompt.fresh.golden.txt, captured from a REAL tick by capture-context-golden.sh)
# so a later, flag-gated slice can route tick.sh's $PROMPT through it with the
# byte-identity contract already green — exactly how renderMcpCli.js landed
# before gaffer_render_mcp_runtime was wired.
#
# Covers: fresh-delivery byte-identity (--out AND stdout, no trailing-newline
# drift), workBranch DERIVATION parity (the golden encodes the derived branch),
# bootstrap render, and the fail-closed negative controls (empty write-repo set /
# empty title / empty bootstrap dir → exit 1, nothing written).
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CREW_DIR="$ROOT/packages/crew"
CLI="$CREW_DIR/dist/runtime/context/renderPromptCli.js"
FIXTURES="$CREW_DIR/test/fixtures/tick-context"
GOLDEN="$FIXTURES/prompt.fresh.golden.txt"
INPUTS="$FIXTURES/inputs.json"

command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$CLI" ] || { echo "SKIP: crew not built ($CLI) — run pnpm --filter crew build"; exit 0; }
[ -f "$GOLDEN" ] && [ -f "$INPUTS" ] || { echo "SKIP: context goldens missing (run capture-context-golden.sh)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/prompt-render-cli.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
no() { echo "  FAIL $1"; fail=$((fail + 1)); }

# ── A. fresh delivery: --out is byte-identical to the captured bash golden ────
node "$CLI" --out "$WORK/prompt.out" < "$INPUTS" \
  && cmp -s "$WORK/prompt.out" "$GOLDEN" \
  && ok "fresh delivery (--out) is byte-identical to the real bash prompt golden" \
  || no "fresh delivery (--out) diverged from the golden"

# ── B. stdout mode is byte-identical too (no trailing-newline drift) ──────────
node "$CLI" < "$INPUTS" > "$WORK/prompt.stdout"
cmp -s "$WORK/prompt.stdout" "$GOLDEN" \
  && ok "fresh delivery (stdout) is byte-identical (no trailing-newline drift)" \
  || no "fresh delivery (stdout) diverged from the golden"

# ── C. workBranch DERIVATION parity: inputs.json carries NO workBranch, so the
#      match in A/B proves the CLI derives gaffer/ticket-<n>-<slug> exactly as
#      bash did. Assert the derived branch is actually present in the render. ──
grep -q "on branch gaffer/ticket-1-add-password-reset-flow" "$WORK/prompt.out" \
  && ok "workBranch derived (gaffer/ticket-1-add-password-reset-flow) matches the bash pipeline" \
  || no "derived workBranch missing/incorrect in the render"

# ── D. bootstrap render ──────────────────────────────────────────────────────
printf '%s' '{"kind":"bootstrap","ticketNumber":"9","title":"Scaffold the app","skills":"minimalism","bootstrapDir":"/tmp/gf/ticket-9/app"}' \
  | node "$CLI" > "$WORK/bootstrap.out"
if grep -q "GREENFIELD bootstrap agent" "$WORK/bootstrap.out" \
   && grep -q "Bootstrap ticket #9" "$WORK/bootstrap.out" \
   && grep -q "/tmp/gf/ticket-9/app" "$WORK/bootstrap.out"; then
  ok "bootstrap render carries the greenfield header, ticket #, and the writable dir"
else
  no "bootstrap render missing expected content"
fi

# ── E. fail-closed: empty write-repo set → exit 1, nothing written ───────────
python3 - "$INPUTS" > "$WORK/nowrite.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["writeRepos"] = []
print(json.dumps(d))
PY
if node "$CLI" --out "$WORK/should-not-exist" < "$WORK/nowrite.json" 2>/dev/null; then
  no "empty write-repo set should FAIL CLOSED (non-zero) but exited 0"
else
  [ ! -f "$WORK/should-not-exist" ] \
    && ok "empty write-repo set fails closed (exit 1, no file written)" \
    || no "empty write-repo set exited non-zero but still wrote a file"
fi

# ── F. fail-closed: empty title → exit 1 ─────────────────────────────────────
python3 - "$INPUTS" > "$WORK/notitle.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["title"] = ""
print(json.dumps(d))
PY
node "$CLI" < "$WORK/notitle.json" >/dev/null 2>&1 \
  && no "empty title should FAIL CLOSED but exited 0" \
  || ok "empty title fails closed (exit 1)"

# ── G. fail-closed: bootstrap with empty dir → exit 1 ────────────────────────
printf '%s' '{"kind":"bootstrap","ticketNumber":"9","title":"x","skills":"","bootstrapDir":""}' \
  | node "$CLI" >/dev/null 2>&1 \
  && no "bootstrap with empty dir should FAIL CLOSED but exited 0" \
  || ok "bootstrap with empty bootstrapDir fails closed (exit 1)"

echo ""
echo "prompt-render-cli: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
