#!/usr/bin/env bash
# =====================================================================
# gaffer config show [--all] [--json]: the fourteen settings, their values and where
# each came from; every derived value and what decided it; no secret ever printed.
# ---------------------------------------------------------------------
# With a clean environment and the real runner/gaffer, this pins:
#   1. the fourteen, each with its value and origin (default, settings.json, environment);
#   2. --all: every derived value with what decided it (the setting and its value, the
#      environment, or an old settings.json key that is stricter);
#   3. --json: the same as JSON, with the migration list of old keys;
#   4. no secret is printed: notify URLs, an old webhook key, the principal token, API keys;
#   5. it is read-only (the data dir is unchanged) and refuses a bad argument (exit 2).
# Run: bash runner/test/config-show.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir config-show)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
mkdir -p "$WORK/home" "$WORK/data"

show() {  # show [VAR=value ...] -- <args...>
  local -a vars=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" ${vars[@]+"${vars[@]}"} \
    bash "$RUNNER_DIR/gaffer" config "$@" 2>"$WORK/err"
}
line() { grep -E "^ +$1 " <<<"$OUT" | head -1; }

printf '{"GAFFER_EFFORT":"large","GAFFER_NOTIFY":"https://hooks.slack.com/services/T1/B1/slacksecret desktop","GAFFER_NOTIFY_WEBHOOK_URL":"https://hooks.invalid/webhooksecret","MAX_TICKS_PER_DAY":"9","GAFFER_TICK_TIMEOUT":"99999"}\n' > "$WORK/data/settings.json"
(cd "$WORK/data" && find . -type f | sort | xargs cksum) > "$WORK/before"

echo "== 1: the fourteen, with values and origins =="
OUT="$(show GAFFER_MODE=lite GAFFER_PRINCIPAL_TOKEN=gfp_principalsecret ANTHROPIC_API_KEY=sk-apisecret -- show)"; RC=$?
[ "$RC" = 0 ] && ok "exit 0" || fail "exit $RC: $(cat "$WORK/err")"
[ "$(grep -cE '^  (GAFFER_|DISPATCH_API_PORT).*\[(default|settings\.json|environment)\]$' <<<"$OUT")" = 14 ] && ok "fourteen setting lines" || fail "setting lines: $OUT"
[[ "$(line GAFFER_MODE)" == *"lite"*"[environment]"* ]] && ok "GAFFER_MODE=lite [environment]" || fail "mode: $(line GAFFER_MODE)"
[[ "$(line GAFFER_EFFORT)" == *"large"*"[settings.json]"* ]] && ok "GAFFER_EFFORT=large [settings.json]" || fail "effort: $(line GAFFER_EFFORT)"
[[ "$(line GAFFER_GATES)" == *"standard"*"[default]"* ]] && ok "GAFFER_GATES=standard [default]" || fail "gates: $(line GAFFER_GATES)"
[[ "$(line GAFFER_NOTIFY)" == *"a Slack URL (hidden), desktop"*"[settings.json]"* ]] && ok "GAFFER_NOTIFY shows its channels, not its URL" || fail "notify: $(line GAFFER_NOTIFY)"
grep -q 'REVIEW_MODE' <<<"$OUT" && fail "show without --all printed a derived value" || ok "without --all: only the fourteen (and the old keys)"
grep -q 'MAX_TICKS_PER_DAY -> GAFFER_CONCURRENCY' <<<"$OUT" && ok "old settings.json keys are listed with the setting that decides them" || fail "no migration list: $OUT"

echo "== 2: --all: every derived value and what decided it =="
OUT="$(show GAFFER_DOD_TIMEOUT=5 -- show --all)"
[[ "$(line GAFFER_MAX_TURNS)" == *"300"*"[GAFFER_EFFORT=large]"* ]] && ok "a derived value names the setting and its value" || fail "turns: $(line GAFFER_MAX_TURNS)"
[[ "$(line GAFFER_DOD_TIMEOUT)" == *" 5 "*"[environment]"* ]] && ok "an environment override is marked as such" || fail "env override: $(line GAFFER_DOD_TIMEOUT)"
[[ "$(line MAX_TICKS_PER_DAY)" == *" 9 "*"[settings.json (an old key"* ]] && ok "a stricter old key that still applies is marked as settings.json" || fail "kept old key: $(line MAX_TICKS_PER_DAY)"
[[ "$(line GAFFER_TICK_TIMEOUT)" == *"3600"*"[GAFFER_EFFORT=large]"* ]] && ok "a costlier old key is not applied (the setting decides)" || fail "costlier old key: $(line GAFFER_TICK_TIMEOUT)"
[[ "$(line GAFFER_DOD_INSTALL)" == *" 1 "*"read with this default in runner/lib/dod.sh"* ]] && ok "a value read where it is used shows that default and where" || fail "read-site: $(line GAFFER_DOD_INSTALL)"
N="$(node -e 'let n=0;for(const s of require(process.argv[1]).settings) n+=s.derives.length; console.log(n)' "$RUNNER_DIR/config/settings-schema.json")"
[ "$(grep -cE '^    [A-Z_]+ ' <<<"$OUT")" = "$N" ] && ok "every derived value is listed ($N)" || fail "derived lines: $(grep -cE '^    [A-Z_]+ ' <<<"$OUT") of $N"

echo "== 3: --json =="
J="$(show -- show --all --json)"
V="$(node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const s = Object.fromEntries(j.settings.map((x) => [x.name, x]));
  const d = Object.fromEntries(j.derived.map((x) => [x.name, x]));
  const m = Object.fromEntries(j.migration.map((x) => [x.key, x]));
  process.stdout.write([j.settings.length, s.GAFFER_EFFORT.value, s.GAFFER_EFFORT.origin,
    d.GAFFER_MAX_TURNS.value, d.GAFFER_MAX_TURNS.decidedBy, m.GAFFER_TICK_TIMEOUT.decision,
    m.GAFFER_TICK_TIMEOUT.differs, m.MAX_TICKS_PER_DAY.decision, m.GAFFER_TICK_TIMEOUT.setting].join("|"));
' <<<"$J")"
[ "$V" = "14|large|settings.json|300|GAFFER_EFFORT=large|stricter-derived|true|kept|GAFFER_EFFORT" ] \
  && ok "the JSON carries settings, derived values and the migration map (decision, whether it differs)" || fail "json: $V"
J2="$(show -- show --json)"
node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(j.derived === undefined && j.settings.length === 14 ? 0 : 1)' <<<"$J2" \
  && ok "--json without --all: the fourteen and the migration only" || fail "json without --all: $J2"

echo "== 4: no secret is printed =="
ALL="$(show GAFFER_PRINCIPAL_TOKEN=gfp_principalsecret ANTHROPIC_API_KEY=sk-apisecret CLAUDE_CODE_OAUTH_TOKEN=oauthsecret -- show --all)$(show GAFFER_PRINCIPAL_TOKEN=gfp_principalsecret -- show --all --json)"
for sec in slacksecret webhooksecret principalsecret apisecret oauthsecret; do
  grep -q "$sec" <<<"$ALL$(cat "$WORK/err")" && fail "printed a secret ($sec)" || ok "never prints $sec"
done
[[ "$(line GAFFER_NOTIFY_WEBHOOK_URL <<<"$ALL")" == *"(set, hidden)"* || "$ALL" == *'GAFFER_NOTIFY_WEBHOOK_URL         (set, hidden)'* ]] \
  && ok "a webhook URL shows that it is set" || fail "webhook line: $(grep NOTIFY_WEBHOOK <<<"$ALL" | head -2)"

echo "== 5: read-only; bad arguments =="
(cd "$WORK/data" && find . -type f | sort | xargs cksum) > "$WORK/after"
cmp -s "$WORK/before" "$WORK/after" && ok "the data dir is unchanged (nothing written)" || fail "data dir changed: $(diff "$WORK/before" "$WORK/after")"
show -- >/dev/null; RC=$?
[ "$RC" = 2 ] && grep -q 'config takes one subcommand: show' "$WORK/err" && ok "gaffer config with no subcommand: exit 2, says why" || fail "no subcommand: rc=$RC $(cat "$WORK/err")"
show -- show --everything >/dev/null; RC=$?
[ "$RC" = 2 ] && ok "an unknown option: exit 2" || fail "unknown option: rc=$RC"
OUT="$(show -- --help)"
[[ "$OUT" == "usage: gaffer config show"* ]] && ok "--help prints the usage line" || fail "help: $OUT"
printf '{"GAFFER_EFFORT":"huge"}\n' > "$WORK/data/settings.json"
show -- show >/dev/null; RC=$?
[ "$RC" != 0 ] && grep -q 'GAFFER_EFFORT=' "$WORK/err" && ok "an unknown setting value stops show too, with the same message" || fail "bad value: rc=$RC $(cat "$WORK/err")"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "config-show: ALL $PASS checks passed"
  exit 0
fi
echo "config-show: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
