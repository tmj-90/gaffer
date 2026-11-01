#!/usr/bin/env bash
# =====================================================================
# A greenfield BOOTSTRAP under a required-but-missing OS sandbox parks before it
# creates anything, with the fix on the card.
# ---------------------------------------------------------------------
# Hands-off delivery (GAFFER_MODE=autonomous and every autonomy flag) defaults
# GAFFER_STRICT_REQUIRE=1: no agent runs without an OS sandbox. A normal delivery
# checked that before its spawn and parked `strict_require_unavailable`. The
# bootstrap path did not: it git-init'd the new repo under GAFFER_BOOTSTRAP_ROOT, the
# worker seam then refused the spawn (rc 75), and the ticket parked as a generic
# `bootstrap failed (rc=75)` with a half-made repo left behind and no word on what to
# do. Whether to run hands-off is the person's call; the product's job is to say so at
# the moment it matters. Now the bootstrap asks the sandbox provider first and parks
# `strict_require_unavailable` with the provider-specific fix in the reason, which is
# what the Team sheet shows on the blocked row.
#   1. SANDBOX_PROVIDER=none + strict-require → blocked, strict_require_unavailable,
#      no repo dir, no agent spawned, the fix named (a provider to set)
#   2. SANDBOX_PROVIDER=docker with no daemon → the fix names the daemon and the
#      one-time image build
#   3. the fix always offers the supervised alternative and the trusted-VM opt-out
#   4. control: strict-require off → the bootstrap goes ahead (agent spawned)
# Run: bash runner/test/bootstrap-sandbox-required.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT_DIR="$(cd "$RUNNER_DIR/.." && pwd)"
PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
# shellcheck source=lib/skip.sh
. "$HERE/lib/skip.sh"

command -v node >/dev/null 2>&1 || gaffer_skip "node required"
command -v git  >/dev/null 2>&1 || gaffer_skip "git required"
[ -f "$ROOT_DIR/packages/crew/dist/runtime/context/renderPromptCli.js" ] \
  || gaffer_skip "crew not built (pnpm -C packages/crew build)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-sbx.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
mkdir -p "$WORK/bin"
# npm answers the registry probe (not under test here); docker has no daemon.
printf '#!/usr/bin/env bash\necho "npm notice PONG 1ms"\n' > "$WORK/bin/npm"
printf '#!/usr/bin/env bash\n[ "${1:-}" = info ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }\nexit 1\n' > "$WORK/bin/docker"
chmod +x "$WORK/bin/npm" "$WORK/bin/docker"

# Stub dispatch CLI: one ready bootstrap ticket #7; every call is recorded.
DISPATCH_DIR="$WORK/dispatch"; mkdir -p "$DISPATCH_DIR/dist/cli"
WG_CALLS="$WORK/wg-calls.log"
cat > "$DISPATCH_DIR/dist/cli/index.js" <<'JS'
const fs = require("node:fs");
let a = process.argv.slice(2);
if (a[0] === "--db") a = a.slice(2);
fs.appendFileSync(process.env.WG_CALLS, JSON.stringify(a) + "\n");
const has = (...t) => t.every((x) => a.includes(x));
const out = (o) => process.stdout.write(JSON.stringify(o));
if (has("agent", "register")) out({ agent: { id: "stub-agent" } });
else if (has("ticket", "resume-requested")) out([]);
else if (has("ticket", "list", "-s", "ready")) out([{ number: 7, title: "Bootstrap newapp" }]);
else if (has("ticket", "list")) out([]);
else if (has("ticket", "show", "7"))
  out({ ticket: { number: 7, title: "Bootstrap newapp", status: "ready", bootstrap: true, source: "newapp", risk_level: "low" }, repositories: [] });
else if (has("claim-ticket")) out({ claimToken: "tok-7" });
else if (has("runner-release")) out({ ok: true });
else out({});
JS
MARKER="$WORK/agent-spawned.marker"; STUB_CLAUDE="$WORK/stub-claude.sh"
printf '#!/usr/bin/env bash\n: > "%s"\nprintf "%%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"scaffolded\"}"\n' "$MARKER" > "$STUB_CLAUDE"
chmod +x "$STUB_CLAUDE"
if command -v perl >/dev/null 2>&1; then BOUND=(perl -e 'alarm shift; exec @ARGV' 300); else BOUND=(); fi

run_tick() {  # $1 = label (fresh data + root), rest = extra env → OUT, BOOT_ROOT
  local label="$1"; shift
  : > "$WG_CALLS"; rm -f "$MARKER"
  local gdata="$WORK/data-$label"; mkdir -p "$gdata"
  BOOT_ROOT="$WORK/git-$label"
  OUT="$(env PATH="$WORK/bin:$PATH" WG_CALLS="$WG_CALLS" RUNNER_DIR="$RUNNER_DIR" GAFFER_DATA="$gdata" \
        DISPATCH_DIR="$DISPATCH_DIR" GAFFER_BOOTSTRAP_ROOT="$BOOT_ROOT" CLAUDE_BIN="$STUB_CLAUDE" CLAUDE_FLAGS="" \
        DRY_RUN=0 REVIEW_MODE=human CLARIFY_DRAFTS_WHEN_IDLE=0 GAFFER_TESTING=0 GAFFER_MAINTENANCE=0 \
        GAFFER_DAILY_BUDGET_USD=5 GAFFER_TICK_TIMEOUT=120 STRICT_MODE=0 "$@" \
        ${BOUND[@]+"${BOUND[@]}"} bash "$RUNNER_DIR/tick.sh" 2>&1)"
}
release_line() { grep '"runner-release"' "$WG_CALLS" | tail -1; }

echo "== 1: no provider + strict-require → parked before anything is created =="
run_tick none GAFFER_STRICT_REQUIRE=1 SANDBOX_PROVIDER=none
REL="$(release_line)"
case "$REL" in *'"blocked"'*strict_require_unavailable*) ok "released to blocked with reason code strict_require_unavailable" ;;
  *) fail "release: '${REL:-<none>}' (log: $(printf '%s' "$OUT" | grep -E 'BOOTSTRAP|STRICT|released' | tail -3 | tr '\n' ' ' | cut -c1-500))" ;; esac
[ ! -e "$BOOT_ROOT/newapp" ] && ok "no repo dir created under GAFFER_BOOTSTRAP_ROOT" || fail "the new repo was git-init'd before the sandbox check"
[ ! -e "$MARKER" ] && ok "no agent spawned" || fail "the agent ran with no sandbox"
case "$REL" in *SANDBOX_PROVIDER=docker*) ok "the reason names a provider to set (SANDBOX_PROVIDER=docker)" ;;
  *) fail "the reason names no fix: $REL" ;; esac
case "$REL" in *"rc=75"*) fail "still the generic rc=75 park" ;; *) ok "not the generic 'bootstrap failed (rc=75)' park" ;; esac

echo "== 2: docker provider with no daemon → the daemon and the one-time image build =="
run_tick docker GAFFER_STRICT_REQUIRE=1 SANDBOX_PROVIDER=docker
REL="$(release_line)"
case "$REL" in *strict_require_unavailable*) ok "docker without a daemon parks strict_require_unavailable" ;; *) fail "docker release: '${REL:-<none>}'" ;; esac
case "$REL" in *"docker daemon"*"docker compose --profile sandbox build sandbox-image egress-proxy"*) ok "the reason says start the daemon and build the images once" ;;
  *) fail "docker fix missing: $REL" ;; esac
[ ! -e "$BOOT_ROOT/newapp" ] && ok "no repo dir created" || fail "repo dir created"

echo "== 3: the choice stays the person's =="
case "$REL" in *"run supervised"*GAFFER_STRICT_REQUIRE=0*) ok "the reason offers running supervised, or GAFFER_STRICT_REQUIRE=0 inside a trusted VM" ;;
  *) fail "alternatives missing: $REL" ;; esac

echo "== 4: control — strict-require off, the bootstrap goes ahead =="
run_tick off GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none
grep -q strict_require_unavailable "$WG_CALLS" && fail "parked strict_require_unavailable with strict-require off" || ok "no sandbox park with strict-require off"
[ -e "$MARKER" ] && ok "the bootstrap agent was spawned" || fail "the agent never ran: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ' | cut -c1-400)"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "bootstrap-sandbox-required: ALL $PASS checks passed"; exit 0; fi
echo "bootstrap-sandbox-required: ${#FAILURES[@]} FAILURE(S):"; for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1
