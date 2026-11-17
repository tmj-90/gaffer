#!/usr/bin/env bash
# =====================================================================
# External review 21, item 1, the runner's side: the readers behind the runner's own
# approve decision (the lite trivial classifier and the security second opinion's
# qualifier) read the COMMITS the review resolved once, never the branch name.
# ---------------------------------------------------------------------
# lib/review.sh resolves the reviewed head (RSHA) and the base branch's tip (RDEF_SHA)
# once and pins RSHA. The two qualifiers used to diff `$RDEFAULT...$RBRANCH`, so a branch
# moved to a harmless commit while they ran (and moved back before the tamper check)
# skipped the security reviewer and could call a sensitive change trivial. Pinned here:
#   1. review.sh passes "$RDEF_SHA" "$RSHA" to both;
#   2. with the branch moved to a safe commit, the qualifiers still judge the reviewed
#      commit (a sensitive path: second opinion runs, not trivial);
#   3. a diff git cannot give (an empty end, an unknown commit) holds: the second
#      opinion runs and the ticket is not trivial (it used to read as no paths).
# Zero deps beyond node and git. Run: bash runner/test/review-pinned-commit.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
CFG="$RUNNER_DIR/factory.config.sh"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir review-pinned-commit)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
mkdir -p "$WORK/home" "$WORK/data"

# cfg <snippet>: run the snippet in a clean env after sourcing the real config.
cfg() {
  env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" ERRF="$WORK/err" \
    bash --norc --noprofile -c 'source "$0" 2>"$ERRF"; eval "$1"' "$CFG" "$1"
}

echo "== review.sh hands the qualifiers the resolved commits =="
REV="$RUNNER_DIR/lib/review.sh"
grep -F 'gaffer_needs_security_review "$RNUM" "$RREPO" "$RDEF_SHA" "$RSHA"' "$REV" >/dev/null \
  && ok "the security qualifier reads the base tip and the reviewed commit" \
  || fail "review.sh calls gaffer_needs_security_review with something other than RDEF_SHA RSHA"
grep -F 'gaffer_ticket_is_trivial "$RNUM" "$RREPO" "$RDEF_SHA" "$RSHA"' "$REV" >/dev/null \
  && ok "the lite classifier reads the base tip and the reviewed commit" \
  || fail "review.sh calls gaffer_ticket_is_trivial with something other than RDEF_SHA RSHA"
_byname="$(grep -nE 'gaffer_(needs_security_review|ticket_is_trivial) [^#]*\$RBRANCH' "$REV" || true)"
[ -z "$_byname" ] && ok "no qualifier call reads the delivery branch by name" \
  || fail "a qualifier still reads the branch by name: $_byname"

echo "== the qualifiers judge the commit they are given =="
R="$WORK/repo"
g() { git -C "$R" -c user.name=t -c user.email=t@t "$@"; }
git init -q -b main "$R"
printf 'x\n' > "$R/README"; g add -A; g commit -qm base
BASE="$(g rev-parse HEAD)"
g checkout -q -b work
printf 'y\n' > "$R/README"; g commit -qam safe
SAFE="$(g rev-parse HEAD)"
mkdir -p "$R/src/auth"; printf 'export const ok = () => true;\n' > "$R/src/auth/check.js"
g add -A; g commit -qm "touch auth"
RISKY="$(g rev-parse HEAD)"
g update-ref refs/heads/work "$SAFE"   # the branch moved away while the qualifiers read
WG='wg() { printf "%s" "{\"ticket\":{\"risk_level\":\"low\"},\"risk_level\":\"low\"}"; };'

V="$(cfg "$WG"' gaffer_needs_security_review 1 "'"$R"'" "'"$BASE"'" "'"$RISKY"'" && printf "review:%s" "$GAFFER_SECURITY_REVIEW_REASON" || printf skip')"
case "$V" in review:sensitive-path*) ok "the reviewed commit's auth path gets the second opinion with the branch moved away" ;; *) fail "security qualifier on the reviewed commit: $V" ;; esac
V="$(cfg "$WG"' gaffer_needs_security_review 1 "'"$R"'" "'"$BASE"'" "'"$SAFE"'" && printf review || printf skip')"
[ "$V" = "skip" ] && ok "control: the safe commit alone needs no second opinion" || fail "control security: $V"
V="$(cfg "$WG"' gaffer_ticket_is_trivial 1 "'"$R"'" "'"$BASE"'" "'"$RISKY"'" && printf trivial || printf "held:%s" "$GAFFER_LITE_REASON"')"
[ "$V" = "held:nontrivial:sensitive-path" ] && ok "the reviewed commit is not trivial (sensitive path) with the branch moved away" || fail "lite on the reviewed commit: $V"
V="$(cfg "$WG"' gaffer_ticket_is_trivial 1 "'"$R"'" "'"$BASE"'" "'"$SAFE"'" && printf trivial || printf "held:%s" "$GAFFER_LITE_REASON"')"
[ "$V" = "trivial" ] && ok "control: the safe commit alone is trivial" || fail "control lite: $V"

echo "== a diff git cannot give holds =="
NOPE="0123456789abcdef0123456789abcdef01234567"
for args in "\"\" \"$RISKY\"" "\"$BASE\" \"\"" "\"$BASE\" \"$NOPE\""; do
  V="$(cfg "$WG"' gaffer_needs_security_review 1 "'"$R"'" '"$args"' && printf review || printf skip')"
  [ "$V" = "review" ] && ok "security qualifier with ends ($args): runs the second opinion" || fail "security qualifier unreadable ($args): $V"
  V="$(cfg "$WG"' gaffer_ticket_is_trivial 1 "'"$R"'" '"$args"' && printf trivial || printf "held:%s" "$GAFFER_LITE_REASON"')"
  [ "$V" = "held:nontrivial:diff-unreadable" ] && ok "lite classifier with ends ($args): not trivial" || fail "lite unreadable ($args): $V"
done

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "review-pinned-commit: ALL $PASS checks passed"
  exit 0
fi
echo "review-pinned-commit: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
