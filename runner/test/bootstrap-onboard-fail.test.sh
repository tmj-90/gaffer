#!/usr/bin/env bash
# =====================================================================
# BOOTSTRAP ONBOARD FAILURE — a scaffold whose repo registration fails is PARKED,
# never submitted.
# ---------------------------------------------------------------------
# When `wg repo add` for the new repo failed, the bootstrap only attached a note and
# fell through to the submit: the ticket sat in in_review with no repo link, no
# branch_name and no per-repo delivery row, so the reviewer had nothing to diff and
# every dependent ticket stayed blocked behind "1 awaiting review".
# Drives the REAL tick.sh bootstrap path against a STUB dispatch CLI (records every
# call; `repo add` fails with a VALIDATION_ERROR) and a stub agent that commits a
# scaffold:
#   B1  the ticket is released → blocked with reason code bootstrap_failed, and the
#       reason carries the registration error + the scaffold location
#   B2  no submit (neither `wg submit` nor a move to in_review) was attempted
#   B3  the tick reports error and the scaffold dir + delivery branch are kept
# Run: bash runner/test/bootstrap-onboard-fail.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git  >/dev/null 2>&1 || { echo "SKIP: git required";  exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
[ -f "$ROOT/packages/crew/dist/runtime/context/renderPromptCli.js" ] \
  || { echo "SKIP: crew not built ($ROOT/packages/crew/dist) — run pnpm -r build"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-onboard-fail.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# ── STUB dispatch CLI: one ready BOOTSTRAP ticket (#7), a claim token, `repo add`
#    refused with a VALIDATION_ERROR, and a recorder of every call. ─────────────────
DISPATCH_DIR="$WORK/dispatch"; mkdir -p "$DISPATCH_DIR/dist/cli"
WG_CALLS="$WORK/wg-calls.log"; : > "$WG_CALLS"
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
  out({
    ticket: { number: 7, title: "Bootstrap newapp", status: "claimed", bootstrap: true, source: "newapp", risk_level: "low" },
    repositories: [],
  });
else if (has("claim-ticket")) out({ claimToken: "tok-7" });
else if (has("repo", "add")) {
  process.stdout.write(JSON.stringify({ ok: false, code: "VALIDATION_ERROR", message: "default branch is not a valid git ref" }));
  process.exit(1);
} else if (has("repo", "list")) out([]);
else if (has("runner-release")) out({ ok: true });
else out({});
JS

# ── STUB agent: writes + commits a minimal node scaffold in the new repo (its cwd). ──
STUB="$WORK/stub-claude.sh"
cat > "$STUB" <<'STUBSH'
#!/usr/bin/env bash
if [ -e .git ]; then
  printf '{ "name": "newapp", "version": "0.1.0", "private": true, "scripts": { "test": "node -e 0" } }\n' > package.json
  printf 'export const app = 1;\n' > index.js
  git -c user.email=s@s -c user.name=s add package.json index.js >/dev/null 2>&1
  git -c user.email=s@s -c user.name=s commit -qm "scaffold newapp" >/dev/null 2>&1
fi
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"scaffolded.\n\nSmallest-change note: scaffold.","total_cost_usd":0.01,"num_turns":1}'
STUBSH
chmod +x "$STUB"

GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
BOOT_ROOT="$WORK/git"; B_DIR="$BOOT_ROOT/newapp"
OUT="$(env WG_CALLS="$WG_CALLS" RUNNER_DIR="$RUNNER_DIR" GAFFER_DATA="$GAFFER_DATA" DISPATCH_DIR="$DISPATCH_DIR" \
      GAFFER_BOOTSTRAP_ROOT="$BOOT_ROOT" CLAUDE_BIN="$STUB" CLAUDE_FLAGS="" \
      DRY_RUN=0 REVIEW_MODE=human CLARIFY_DRAFTS_WHEN_IDLE=0 GAFFER_TESTING=0 GAFFER_MAINTENANCE=0 \
      STRICT_MODE=0 GAFFER_STRICT_REQUIRE=0 SANDBOX_PROVIDER=none GAFFER_TICK_TIMEOUT=120 GAFFER_GREENFIELD_INSTALL=0 \
      perl -e 'alarm shift; exec @ARGV' 300 bash "$TICK" 2>&1)"

grep -q '"repo","add"' "$WG_CALLS" && ok "fixture: the bootstrap reached repo registration (repo add was called)" \
  || fail "fixture: repo add never called — the bootstrap stopped earlier: $(printf '%s' "$OUT" | grep -E 'BOOTSTRAP|SAFETY|TICK_RESULT' | tail -4 | tr '\n' '|')"
REL="$(grep '"runner-release","7"' "$WG_CALLS" | tail -1)"
printf '%s' "$REL" | grep -q '"--to","blocked"' && printf '%s' "$REL" | grep -q '"--reason-code","bootstrap_failed"' \
  && ok "B1: released → blocked with reason code bootstrap_failed" || fail "B1: release call: ${REL:-none}"
printf '%s' "$REL" | grep -q 'repo registration' && printf '%s' "$REL" | grep -q 'not a valid git ref' && printf '%s' "$REL" | grep -qF "$B_DIR" \
  && ok "B1: the park reason names the registration error and where the scaffold is" || fail "B1: reason lacks the cause/location: $REL"
if grep -q '"submit","7"' "$WG_CALLS" || grep -q '"ticket","move","7","in_review"' "$WG_CALLS"; then
  fail "B2: the bootstrap was still submitted for review"
else
  ok "B2: no submit / in_review move was attempted"
fi
printf '%s\n' "$OUT" | grep -q '^TICK_RESULT=error$' && ok "B3: the tick reports error" || fail "B3: $(printf '%s\n' "$OUT" | grep TICK_RESULT=)"
[ -d "$B_DIR/.git" ] && git -C "$B_DIR" rev-parse --verify --quiet "refs/heads/gaffer/ticket-7-bootstrap-newapp" >/dev/null \
  && ok "B3: the scaffold dir and its delivery branch are kept for the human" || fail "B3: scaffold or branch missing ($(git -C "$B_DIR" branch 2>&1 | tr '\n' ' '))"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
