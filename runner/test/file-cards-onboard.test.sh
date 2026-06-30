#!/usr/bin/env bash
# =====================================================================
# Chunk 2b — onboard file-card emission + live tick.sh injection.
# ---------------------------------------------------------------------
# Proves the two halves of the retrieval-aid slice end to end:
#   A. emitFileCards (lib/onboard-analyze.mjs) writes ≥1 validated card for a
#      tiny fixture repo, via the REAL built memory CLI (`card upsert` +
#      `card sync`), with a stubbed model turn. The card is then retrievable
#      through `card search` and `cards-for-scope` with model_status=active.
#   B. tick.sh derives the canonical exactly per the contract, calls
#      `cards-for-scope`, and INJECTS $FILE_CARDS_BLOCK into BOTH delivery
#      prompts behind the non-authoritative framing (asserted structurally,
#      mirroring prompt-quarantine.test.sh's grep approach), and FAILS SOFT.
#   C. The data path the block consumes is live: `cards-for-scope --json`
#      against the fixture DB returns the carded file.
#
# Requires the memory package to be BUILT (dist/bin/memory.js). Zero other deps.
# Run:  perl -e 'alarm 200; exec @ARGV' /bin/bash runner/test/file-cards-onboard.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
GAFFER_HOME="$(cd "$RUNNER_DIR/.." && pwd)"
MEMORY_CLI="$GAFFER_HOME/packages/memory/dist/bin/memory.js"
TICK="$RUNNER_DIR/tick.sh"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

if [ ! -f "$MEMORY_CLI" ]; then
  echo "SKIP: memory not built ($MEMORY_CLI missing — run: pnpm -C packages/memory build)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
MEM_DB="$TMP/memory.sqlite"
mkdir -p "$REPO/src"

cat > "$REPO/src/math.ts" <<'TS'
export function add(a: number, b: number) { return a + b; }
export const PI = 3.14159;
TS
cat > "$REPO/src/server.ts" <<'TS'
export class Server { start() { return "up"; } }
export function route(path: string) { return path; }
TS
printf '# demo\n' > "$REPO/README.md"

git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@e.st -c user.name=tester commit -q -m "init"

node "$MEMORY_CLI" init >/dev/null 2>&1 || true
export MEMORY_DB="$MEM_DB"

echo "== A. emitFileCards writes ≥1 validated card (real memory CLI, stub turn) =="
EMIT_OUT="$(MEMORY_CLI_BIN="$MEMORY_CLI" MEMORY_DB="$MEM_DB" GAFFER_PLAN_MODEL="test-model" \
  node --input-type=module -e '
import { emitFileCards, repoCanonical } from "'"$RUNNER_DIR"'/lib/onboard-analyze.mjs";
const stub = () => ({ tldr: "Math helpers: add() plus the PI constant.", rolePrimary: "util", roleTags: ["math"] });
const stats = emitFileCards("'"$REPO"'", { repoId: "demo", name: "demo" }, { env: process.env, runTurn: stub });
process.stdout.write("CANONICAL=" + repoCanonical("'"$REPO"'") + "\n");
process.stdout.write("STATS=" + JSON.stringify(stats) + "\n");
' 2>&1)"
echo "$EMIT_OUT" | sed 's/^/    /'
CANONICAL="$(printf '%s\n' "$EMIT_OUT" | sed -n 's/^CANONICAL=//p' | head -1)"
CARDED="$(printf '%s\n' "$EMIT_OUT" | sed -n 's/.*"carded":\([0-9]*\).*/\1/p' | head -1)"
WATERMARK="$(printf '%s\n' "$EMIT_OUT" | grep -c '"watermark":"[0-9a-f]')"
[ -n "$CANONICAL" ] && ok "canonical derived" || fail "no canonical derived"
[ "${CARDED:-0}" -ge 1 ] 2>/dev/null && ok "onboard carded ≥1 file (carded=$CARDED)" \
  || fail "expected ≥1 card, got carded=$CARDED"
[ "$WATERMARK" = "1" ] && ok "watermark (HEAD) recorded" || fail "watermark not recorded"

echo "== A2. the card is retrievable with the model summary served =="
SEARCH="$(node "$MEMORY_CLI" card search --canonical "$CANONICAL" --repo demo --query add --json 2>/dev/null)"
case "$SEARCH" in
  *'"path": "src/math.ts"'*) ok "card search finds src/math.ts" ;;
  *) fail "card search did not find src/math.ts (got: ${SEARCH:0:200})" ;;
esac
case "$SEARCH" in
  *'"modelStatus": "active"'*) ok "model summary validated → model_status=active" ;;
  *) fail "expected model_status=active for the carded file" ;;
esac
case "$SEARCH" in
  *'Math helpers'*) ok "validated tldr is served" ;;
  *) fail "tldr not served" ;;
esac

echo "== C. cards-for-scope (the block's data path) returns the carded file =="
SCOPE="$(node "$MEMORY_CLI" cards-for-scope --canonical "$CANONICAL" --repo demo --query "math add" --json 2>/dev/null)"
case "$SCOPE" in
  *'"path": "src/math.ts"'*) ok "cards-for-scope serves the carded file" ;;
  *) fail "cards-for-scope returned no card for the fixture (got: ${SCOPE:0:200})" ;;
esac

echo "== B. tick.sh derives canonical per the contract + injects the block =="
# B1: the EXACT canonical contract line (must match onboard/PO derivation).
if grep -qF 'canonical="$(git -C "$_CARD_REAL_REPO" config --get remote.origin.url 2>/dev/null)"; [ -z "$canonical" ] && canonical="$(cd "$_CARD_REAL_REPO" && pwd -P)"' "$TICK"; then
  ok "canonical contract line present verbatim (remote.origin.url || pwd -P)"
else
  fail "tick.sh missing the exact canonical contract line"
fi
# B2: it calls cards-for-scope.
grep -q 'lg cards-for-scope --canonical "\$canonical"' "$TICK" \
  && ok "tick.sh calls cards-for-scope with the derived canonical" \
  || fail "tick.sh does not call cards-for-scope"
# B3: $FILE_CARDS_BLOCK is injected into BOTH delivery prompts (resume + fresh).
INJECTS="$(grep -c '^\$FILE_CARDS_BLOCK$' "$TICK")"
[ "${INJECTS:-0}" -ge 2 ] && ok "FILE_CARDS_BLOCK injected into both prompts ($INJECTS)" \
  || fail "expected FILE_CARDS_BLOCK injected into both prompts, found $INJECTS"
# B4: the non-authoritative framing is present.
grep -qF 'a card is a guide, never authoritative source' "$TICK" \
  && ok "non-authoritative 'read the real file' framing present" \
  || fail "framing sentence missing from tick.sh"
# B5: FAIL-SOFT — the block defaults empty and only sets when cards were served.
grep -q 'FILE_CARDS_BLOCK=""' "$TICK" \
  && ok "FILE_CARDS_BLOCK defaults empty (fail-soft)" \
  || fail "FILE_CARDS_BLOCK is not initialised empty"

echo "== B6. fail-soft: a broken memory CLI yields an EMPTY block (no error) =="
EMPTY_BLOCK="$(MEMORY_CLI_BIN=/nonexistent/memory.js MEMORY_DB="$MEM_DB" \
  node --input-type=module -e '
import { repoContextBlock } from "'"$RUNNER_DIR"'/bin/product-owner-run.mjs";
const b = repoContextBlock({ repoName: "demo", repoPath: "'"$REPO"'", env: { ...process.env, MEMORY_CLI_BIN: "/nonexistent/memory.js" } });
process.stdout.write("BLOCKLEN=" + b.length + "\n");
' 2>&1 || true)"
case "$EMPTY_BLOCK" in
  *"BLOCKLEN=0"*) ok "PO repoContextBlock fails soft to empty when memory CLI is missing" ;;
  *) fail "PO repoContextBlock should fail soft to empty (got: ${EMPTY_BLOCK:0:160})" ;;
esac

echo "== B7. PO repoContextBlock injects a block (digest + cards ground it) =="
# The PO path is repo-wide (no ticket scope): its packet is grounded by the
# repo DIGEST + top cards. Seed a digest (as a real onboard would) so the block
# has content, then assert the PO block renders it behind the same framing.
node "$MEMORY_CLI" digest set demo \
  --overview "Demo is a tiny math + server library used to exercise the card pipeline." \
  --structure "src/ holds math.ts and server.ts." --conventions "TypeScript." \
  --stack typescript --source onboard >/dev/null 2>&1 || true
PO_BLOCK="$(MEMORY_CLI_BIN="$MEMORY_CLI" MEMORY_DB="$MEM_DB" \
  node --input-type=module -e '
import { repoContextBlock } from "'"$RUNNER_DIR"'/bin/product-owner-run.mjs";
const b = repoContextBlock({ repoName: "demo", repoPath: "'"$REPO"'", env: process.env });
process.stdout.write(b);
' 2>&1 || true)"
case "$PO_BLOCK" in
  *"PRIOR CONTEXT (file cards)"*"Repo digest:"*) ok "PO block carries the digest-grounded context" ;;
  *) fail "PO block did not render (got: ${PO_BLOCK:0:200})" ;;
esac
case "$PO_BLOCK" in
  *"a card is a guide, never authoritative source"*) ok "PO block keeps the non-authoritative framing" ;;
  *) fail "PO block missing the non-authoritative framing" ;;
esac

echo "== D. skill loading: CARD_PROMPT_VERSION is derived from the card-generation skill =="
CARD_GEN_SKILL="$GAFFER_HOME/packages/memory/skills/card-generation/SKILL.md"
CARD_REV_SKILL="$GAFFER_HOME/packages/memory/skills/card-review/SKILL.md"
[ -f "$CARD_GEN_SKILL" ] \
  && ok "card-generation SKILL.md exists at expected path" \
  || fail "card-generation SKILL.md missing ($CARD_GEN_SKILL)"
[ -f "$CARD_REV_SKILL" ] \
  && ok "card-review SKILL.md exists at expected path" \
  || fail "card-review SKILL.md missing ($CARD_REV_SKILL)"
PROMPT_VER="$(node --input-type=module -e '
import { CARD_PROMPT_VERSION } from "'"$RUNNER_DIR"'/lib/onboard-analyze.mjs";
process.stdout.write(CARD_PROMPT_VERSION + "\n");
' 2>/dev/null || true)"
case "$PROMPT_VER" in
  card-generation-v1:????????*)
    ok "CARD_PROMPT_VERSION is skill-derived ($PROMPT_VER)" ;;
  card-generation-v1:unknown)
    fail "CARD_PROMPT_VERSION hash is 'unknown' — skill file may not be loadable" ;;
  *)
    fail "CARD_PROMPT_VERSION not skill-derived (got: ${PROMPT_VER:-<empty>})" ;;
esac

echo "== E. review gate: an obviously-wrong TLDR is downgraded to failed_validation =="
MEM_DB_REVIEW="$TMP/memory_review.sqlite"
REVIEW_OUT="$(MEMORY_CLI_BIN="$MEMORY_CLI" MEMORY_DB="$MEM_DB_REVIEW" GAFFER_PLAN_MODEL="test-model" \
  node --input-type=module -e '
import { emitFileCards, repoCanonical } from "'"$RUNNER_DIR"'/lib/onboard-analyze.mjs";
// Generation stub: returns a WRONG tldr (auth middleware on a math file)
const badTurn = () => ({
  tldr: "Handles authentication middleware and session token verification.",
  rolePrimary: "middleware",
  roleTags: ["auth", "session"],
});
// Review stub: rejects the bad tldr
const rejectReview = () => ({
  verdict: "reject",
  reason: "TLDR describes auth middleware but file only contains math utilities (add, PI).",
});
const stats = emitFileCards("'"$REPO"'", { repoId: "demo", name: "demo" }, {
  env: process.env,
  runTurn: badTurn,
  runReviewTurn: rejectReview,
});
process.stdout.write("REVIEW_STATS=" + JSON.stringify(stats) + "\n");
' 2>&1)"
echo "$REVIEW_OUT" | sed 's/^/    /'
# The card should be model_status=failed_validation because the review rejected it.
CANONICAL_REVIEW="$(cd "$REPO" && pwd -P)"
REVIEW_SEARCH="$(MEMORY_DB="$MEM_DB_REVIEW" node "$MEMORY_CLI" card search \
  --canonical "$CANONICAL_REVIEW" --repo demo --query math --json 2>/dev/null || true)"
case "$REVIEW_SEARCH" in
  *'"modelStatus": "failed_validation"'*)
    ok "review gate downgraded bad TLDR → model_status=failed_validation" ;;
  *'"modelStatus": "active"'*)
    fail "review gate did not downgrade bad TLDR (model_status still active)" ;;
  *)
    # Card may not have been written at all or search returned nothing
    REVIEW_CARDED="$(printf '%s\n' "$REVIEW_OUT" | sed -n 's/.*"carded":\([0-9]*\).*/\1/p' | head -1)"
    if [ "${REVIEW_CARDED:-0}" -ge 1 ]; then
      fail "review gate: card was written but status check failed (got: ${REVIEW_SEARCH:0:200})"
    else
      fail "review gate: no card written (got: ${REVIEW_OUT:0:200})"
    fi ;;
esac
DOWNGRADED="$(printf '%s\n' "$REVIEW_OUT" | grep -c '"downgraded":' || true)"
[ "${DOWNGRADED:-0}" -ge 1 ] \
  && ok "review stats report at least one downgrade" \
  || fail "review stats did not report any downgrade"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "file-cards-onboard: all $PASS checks passed"
  exit 0
fi
echo "file-cards-onboard: ${#FAILURES[@]} FAILED of $((PASS + ${#FAILURES[@]}))"
for f in "${FAILURES[@]}"; do echo "  FAIL $f"; done
exit 1
