#!/usr/bin/env bash
# =====================================================================
# ONBOARDING IDENTITY — a name match is a refresh only for the same repository.
# ---------------------------------------------------------------------
# Two unrelated repositories both named "api" both "onboarded"; the second's ticket
# setup then selected the FIRST checkout, and the stored profile combined the first's
# local path with the second's remote URL. Through the real `gaffer onboard` → onboard-
# run.mjs → crew repo onboard, with a stub claude:
#   1  the second "api" is REFUSED (non-zero exit) with a message naming the existing
#      record and the --name alias, and NEITHER record changes (dispatch path, stored
#      profile path + remote stay the first's);
#   2  re-onboarding the SAME checkout (also through a symlink) is a refresh (exit 0);
#   3  `--name api-two` onboards the second under its own alias: two records, each with
#      its own path and remote, never merged;
#   4  MOVED CLONE: onboard a/web, delete it, onboard b/web with the same remote (another
#      spelling of it) — REFUSED with the --name guidance, and neither record changes
#      (the stored profile used to keep a/web's deleted path with b/web's remote, and
#      dispatch kept local_path=a/web, so deliveries targeted a checkout that was gone);
#   5  a record registered with no local path (`wg repo add -n docs`) is not adopted;
#      the refusal says it has no local path (not "an unknown location").
# Run: bash runner/test/onboard-identity.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: dispatch CLI not built"; exit 0; }
[ -f "$ROOT/packages/crew/dist/cli/index.js" ] || { echo "SKIP: crew not built"; exit 0; }
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/onboard-identity.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/one/api" "$WORK/two/api" "$WORK/data" "$WORK/bin"
for d in one two; do
  ( cd "$WORK/$d/api" && git init -q -b main && printf '{"name":"%s","scripts":{"test":"node -e 0"}}\n' "$d" > package.json \
    && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init \
    && git remote add origin "https://example.test/$d/api.git" )
done
ln -s "$WORK/one/api" "$WORK/api-link"
printf '#!/bin/sh\nprintf %s\n' "'{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"{}\"}'" > "$WORK/bin/claude"; chmod +x "$WORK/bin/claude"
# GAFFER_DATA_DIR isolates crew's repo context store (default ~/.crew) in this test's
# tree: a stale record from an earlier run would otherwise make onboarding refuse the
# fixture repo's name (NAME_TAKEN).
export GAFFER_DATA_DIR="$WORK/crew-data"
export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$WORK/bin/claude" GAFFER_PLAN_MODEL=stub
# shellcheck source=../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
onboard() { ( cd "$WORK" && bash "$RUNNER_DIR/gaffer" onboard "$@" ) >"$WORK/out" 2>&1; }
repos() { wg repo list 2>/dev/null | jget 'JSON.stringify((d.repositories || d).map(r => [r.name, r.local_path]).sort())'; }
profile() { node -e 'try { const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(p.localPath + " " + p.remoteUrl); } catch { process.stdout.write("none"); }' "$(find "$GAFFER_DATA" -path "*/repos/$1/profile.json" | head -1)"; }

onboard "$WORK/one/api"; rc=$?
[ "$rc" -eq 0 ] && ok "the first api onboards" || fail "first onboard exit $rc: $(tail -3 "$WORK/out" | tr '\n' '|')"
BEFORE_REPOS="$(repos)"; BEFORE_PROFILE="$(profile api)"
[ "$BEFORE_PROFILE" = "$WORK/one/api https://example.test/one/api.git" ] && ok "profile: the first's path + remote" || fail "profile after first: $BEFORE_PROFILE"

echo "== 1: an unrelated repo with the same name is refused; nothing changes =="
onboard "$WORK/two/api"; rc=$?
[ "$rc" -ne 0 ] && ok "the second api is refused (exit $rc)" || fail "the second api reported success"
OUT="$(cat "$WORK/out")"
case "$OUT" in *"different repository is already onboarded as \"api\""*"$WORK/one/api"*"--name <alias>"*) ok "the refusal names the existing record and the --name alias" ;; *) fail "refusal message: $(printf '%s' "$OUT" | tail -3 | tr '\n' '|' | cut -c1-400)" ;; esac
[ "$(repos)" = "$BEFORE_REPOS" ] && ok "dispatch records unchanged" || fail "dispatch records changed: $(repos)"
[ "$(profile api)" = "$BEFORE_PROFILE" ] && ok "stored profile unchanged (no path/remote merge)" || fail "profile now: $(profile api)"

echo "== 2: the same checkout (directly, or through a symlink) is a refresh =="
onboard "$WORK/one/api"; rc=$?
[ "$rc" -eq 0 ] && ok "re-onboarding the same checkout succeeds" || fail "re-onboard exit $rc: $(tail -3 "$WORK/out" | tr '\n' '|')"
onboard "$WORK/api-link"; rc=$?
[ "$rc" -eq 0 ] && ok "the same checkout through a symlink is the same repository" || fail "symlink onboard exit $rc: $(tail -3 "$WORK/out" | tr '\n' '|' | cut -c1-300)"

echo "== 3: --name gives the second repository its own record =="
onboard "$WORK/two/api" --name api-two; rc=$?
[ "$rc" -eq 0 ] && ok "--name api-two onboards the second" || fail "alias onboard exit $rc: $(tail -3 "$WORK/out" | tr '\n' '|' | cut -c1-300)"
[ "$(repos)" = "[[\"api\",\"$WORK/one/api\"],[\"api-two\",\"$WORK/two/api\"]]" ] && ok "two dispatch records, each with its own path" || fail "dispatch records: $(repos)"
[ "$(profile api)" = "$BEFORE_PROFILE" ] && ok "the first's profile is untouched" || fail "first profile now: $(profile api)"
[ "$(profile api-two)" = "$WORK/two/api https://example.test/two/api.git" ] && ok "the alias profile carries the second's own path + remote" || fail "alias profile: $(profile api-two)"
onboard "$WORK/two/api" --name 'bad name'; rc=$?
[ "$rc" -ne 0 ] && ok "an unusable alias is refused" || fail "alias 'bad name' accepted"

echo "== 4: a moved clone (old checkout gone, same remote) is refused, never merged =="
mkdir -p "$WORK/a/web" "$WORK/b/web"
for d in a b; do
  ( cd "$WORK/$d/web" && git init -q -b main && printf '{"name":"web-%s","scripts":{"test":"node -e 0"}}\n' "$d" > package.json \
    && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
done
git -C "$WORK/a/web" remote add origin "git@github.com:acme/web.git"
git -C "$WORK/b/web" remote add origin "https://github.com/Acme/web"
# The profile stores the remote as git reports it. A host-wide url.<base>.insteadOf
# (cloud sandboxes rewrite git@github.com: to https://) changes that spelling, so
# the expected values are read back from git, not hardcoded.
A_WEB_REMOTE="$(git -C "$WORK/a/web" remote get-url origin)"
B_WEB_REMOTE="$(git -C "$WORK/b/web" remote get-url origin)"
onboard "$WORK/a/web"; rc=$?
[ "$rc" -eq 0 ] && ok "a/web onboards" || fail "a/web onboard exit $rc: $(tail -3 "$WORK/out" | tr '\n' '|')"
WEB_REPOS="$(repos)"; WEB_PROFILE="$(profile web)"
rm -rf "$WORK/a"
onboard "$WORK/b/web"; rc=$?
[ "$rc" -ne 0 ] && ok "b/web (same remote, a/web deleted) is refused (exit $rc)" || fail "the moved clone reported success"
OUT="$(cat "$WORK/out")"
case "$OUT" in *"$WORK/a/web, which no longer exists"*"wg repo hide web"*"--name <alias>"*) ok "the refusal says the old checkout is gone and gives the --name guidance" ;; *) fail "moved-clone message: $(printf '%s' "$OUT" | tail -3 | tr '\n' '|' | cut -c1-500)" ;; esac
[ "$(repos)" = "$WEB_REPOS" ] && ok "dispatch records unchanged (no silent relocation)" || fail "dispatch records changed: $(repos)"
[ "$(profile web)" = "$WEB_PROFILE" ] && [ "$WEB_PROFILE" = "$WORK/a/web $A_WEB_REMOTE" ] \
  && ok "stored profile unchanged: a/web's own path and remote, not a/web's path with b/web's remote" || fail "profile now: $(profile web) (was $WEB_PROFILE; expected $WORK/a/web $A_WEB_REMOTE)"
onboard "$WORK/b/web" --name web-b; rc=$?
[ "$rc" -eq 0 ] && [ "$(profile web-b)" = "$WORK/b/web $B_WEB_REMOTE" ] \
  && ok "the moved checkout onboards under an alias with its own path and remote" || fail "alias onboard exit $rc, profile $(profile web-b)"

echo "== 5: a path-less record is not adopted =="
mkdir -p "$WORK/docs"; ( cd "$WORK/docs" && git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )
wg repo add -n docs >/dev/null 2>&1
onboard "$WORK/docs"; rc=$?
OUT="$(cat "$WORK/out")"
[ "$rc" -ne 0 ] && case "$OUT" in *"registered with no local path"*"--name <alias>"*) true ;; *) false ;; esac \
  && ok "refused, saying the record has no local path" || fail "path-less: exit $rc $(printf '%s' "$OUT" | tail -3 | tr '\n' '|' | cut -c1-400)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "onboard-identity: ALL $PASS checks passed"; exit 0; fi
echo "onboard-identity: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
