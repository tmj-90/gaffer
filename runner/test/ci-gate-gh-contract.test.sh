#!/usr/bin/env bash
# =====================================================================
# CI GATE ↔ the REAL GitHub CLI — a contract test.
# ---------------------------------------------------------------------
# The gate asked `gh pr checks --json name,status,conclusion,detailsUrl`; the real CLI
# refuses that (`Unknown JSON field: "status"`), so with CI required every poll read
# "no checks data". This test's stub gh enforces the field lists the real CLI documents
# (recorded from gh 2.89.0 in fixtures/gh/*-fields.txt) exactly as the CLI does, and
# serves recorded output shapes (fixtures/gh/pr-checks-*.json):
#   1  the gate asks only for real fields (pr checks AND pr view) — the stub would refuse;
#   2  the pre-fix field list IS refused by the same rules (the contract is live);
#   3  recorded shapes → verdicts: green → rc 0 + PASS recorded for the candidate commit;
#      red → rc 2 + FAIL recorded with the failing check; cancelled → red; running → the
#      poll waits (strict timeout → rc 2, FAIL recorded);
#   4  checks for a commit other than the candidate are never accepted as a pass;
#   5  when a real gh is installed, its `--help` JSON FIELDS still contain every field the
#      gate uses (skipped without gh).
# Run: bash runner/test/ci-gate-gh-contract.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
FX="$HERE/fixtures/gh"
export CREW_DIR="$ROOT/packages/crew"
[ -f "$CREW_DIR/dist/runtime/ci/ciGateCli.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
log() { :; }
gaffer_ci_sleep() { :; }
# shellcheck source=../lib/pr-create.sh
source "$RUNNER_DIR/lib/pr-create.sh"
# shellcheck source=../lib/ci-gate.sh
source "$RUNNER_DIR/lib/ci-gate.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ci-gh-contract.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"; mkdir -p "$REPO"
( cd "$REPO" && git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init \
  && git branch gaffer/ticket-7 && git remote add origin https://github.com/acme/api.git )
CAND="$(git -C "$REPO" rev-parse gaffer/ticket-7)"
WG_CALLS="$WORK/wg.calls"; : > "$WG_CALLS"
wg() { printf '%s\n' "$*" >> "$WG_CALLS"; }

# The stub gh: `pr checks <b> --json F` / `pr view <b> --json F`. Every requested field
# must be in the real list, else it fails like the real CLI. Output: $GH_CHECKS (a
# recorded file) and {"headRefOid": $GH_HEAD} (default: the branch head).
GH_LOG="$WORK/gh.log"; : > "$GH_LOG"
cat > "$WORK/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$GH_LOG"
sub="\$1 \$2"; fields=""; prev=""
for a in "\$@"; do [ "\$prev" = "--json" ] && fields="\$a"; prev="\$a"; done
case "\$sub" in
  "pr checks") list="$FX/pr-checks-fields.txt" ;;
  "pr view")   list="$FX/pr-view-fields.txt" ;;
  *) echo "unknown command" >&2; exit 1 ;;
esac
IFS=, read -r -a want <<< "\$fields"
for f in "\${want[@]}"; do
  grep -qx -- "\$f" "\$list" || { printf 'Unknown JSON field: "%s"\nAvailable fields:\n' "\$f" >&2; sed 's/^/  /' "\$list" >&2; exit 1; }
done
if [ "\$sub" = "pr checks" ]; then cat "\${GH_CHECKS:?}"; exit 0; fi
printf '{"headRefOid":"%s"}\n' "\${GH_HEAD:-\$(git rev-parse "refs/heads/\$3" 2>/dev/null)}"
STUB
chmod +x "$WORK/gh"
export GAFFER_GH_BIN="$WORK/gh" GAFFER_REQUIRE_CI=1 GAFFER_CI_POLL_ATTEMPTS=2 GAFFER_CI_POLL_INTERVAL_SECS=0
unset GAFFER_CI_TIMEOUT_POLICY

gate() { : > "$WG_CALLS"; GH_CHECKS="$FX/$1" gaffer_ci_gate 7 "$REPO" gaffer/ticket-7 ""; }
recorded() { grep -c -- "ticket ci-result 7 --commit $CAND --state $1" "$WG_CALLS" | tr -d ' '; }

echo "== 1/3: recorded shapes through the gate =="
gate pr-checks-pass.json; rc=$?
[ "$rc" -eq 0 ] && ok "green run → rc 0" || fail "green run rc=$rc ($(tail -2 "$GH_LOG" | tr '\n' '|'))"
[ "$(recorded pending)" = 1 ] && [ "$(recorded pass)" = 1 ] && ok "pending (poll opened) then PASS recorded for the candidate $CAND" || fail "records: $(tr '\n' '|' < "$WG_CALLS")"
gate pr-checks-fail.json; rc=$?
[ "$rc" -eq 2 ] && ok "red run → rc 2" || fail "red run rc=$rc"
grep -q -- "--state fail --detail check 'test (ubuntu-latest)' failed; see https://github.com/acme/api/actions/runs/102/job/204" "$WG_CALLS" && ok "FAIL recorded with the failing check and its link" || fail "fail record: $(tr '\n' '|' < "$WG_CALLS")"
gate pr-checks-cancel.json; rc=$?
[ "$rc" -eq 2 ] && [ "$(recorded fail)" = 1 ] && ok "a cancelled run is not a pass (rc 2, FAIL recorded)" || fail "cancelled run rc=$rc"
gate pr-checks-pending.json; rc=$?
[ "$rc" -eq 2 ] && [ "$(recorded pass)" = 0 ] && [ "$(recorded fail)" = 1 ] && ok "still running at the strict timeout → rc 2, FAIL recorded, never a pass" || fail "pending run rc=$rc records=$(tr '\n' '|' < "$WG_CALLS")"
grep -vq -- '--json name,state,bucket,link\|--json headRefOid' "$GH_LOG" && fail "the gate asked gh for other fields: $(grep -v -- '--json name,state,bucket,link\|--json headRefOid' "$GH_LOG" | head -2)" || ok "every gh call used the real fields (pr checks: name,state,bucket,link; pr view: headRefOid)"

echo "== 2: the pre-fix query is refused by the same rules =="
( cd "$REPO" && GH_CHECKS="$FX/pr-checks-pass.json" "$WORK/gh" pr checks gaffer/ticket-7 --json name,status,conclusion,detailsUrl ) >"$WORK/old.out" 2>&1; rc=$?
[ "$rc" -ne 0 ] && grep -q 'Unknown JSON field: "status"' "$WORK/old.out" && ok "name,status,conclusion,detailsUrl → Unknown JSON field: \"status\" (as the real CLI says)" || fail "pre-fix query not refused: $(head -2 "$WORK/old.out")"

echo "== 4: checks for another commit are never a pass =="
GH_HEAD="$(printf 'b%.0s' $(seq 1 40))" gate pr-checks-pass.json; rc=$?
[ "$rc" -eq 2 ] && [ "$(recorded pass)" = 0 ] && ok "a green PR head that is not the candidate → no PASS, rc 2" || fail "foreign-head pass rc=$rc records=$(tr '\n' '|' < "$WG_CALLS")"

echo "== 5: the live CLI's field lists (when gh is installed) =="
REAL_GH="$(command -v gh 2>/dev/null || true)"
if [ -n "$REAL_GH" ] && "$REAL_GH" pr checks --help >"$WORK/help" 2>/dev/null; then
  fields="$(sed -n '/JSON FIELDS/,/^$/p' "$WORK/help" | tail -n +2 | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$')"
  miss=""; for f in ${GAFFER_GH_CHECK_FIELDS//,/ }; do grep -qx "$f" <<<"$fields" || miss+="$f "; done
  [ -z "$miss" ] && ok "real $("$REAL_GH" --version | head -1 | cut -d' ' -f1-3): pr checks documents every field the gate uses" || fail "real gh lacks: $miss"
  _view_help="$("$REAL_GH" pr view --help 2>/dev/null | sed -n '/JSON FIELDS/,/^$/p')"
  grep -q headRefOid <<<"$_view_help" && ok "real gh: pr view documents headRefOid" || fail "real gh pr view lacks headRefOid"
else
  ok "SKIP live check: no gh on PATH"
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "ci-gate-gh-contract: ALL $PASS checks passed"; exit 0; fi
echo "ci-gate-gh-contract: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
