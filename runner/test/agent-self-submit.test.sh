#!/usr/bin/env bash
# =====================================================================
# FINDING-2 — a DISOBEDIENT agent self-submit cannot strand the ticket.
# ---------------------------------------------------------------------
# RUNNER-OWNED-BOOKKEEPING: the runner claims the ticket, injects the claim
# token into the agent's dispatch MCP server env (GAFFER_CLAIM_TOKEN), and the
# RUNNER submits after its gates pass. The agent is INSTRUCTED not to submit —
# but prompt text is not enforcement. If the agent-mounted MCP tool could fall
# back to the env token, an agent that ignores "do NOT submit" would submit
# successfully and COMPLETE the claim; the runner's empty-delivery gate would
# then runner-release with a now-VOID token (CLAIM_INVALID soft-warn), the
# branch would be dropped, and the ticket would strand in `in_review` with an
# empty diff — un-approvable forever (PR_OR_DIFF_REQUIRED can never pass).
#
# This restores the intent of the old R-6 "did the agent submit?" status probe
# (origin/main runner/test/empty-delivery-transition.test.sh) in the current
# architecture: instead of PROBING for a rogue submit after the fact, the agent
# mount must be UNABLE to submit at all. Against the REAL dispatch state machine
# (dist CLI + dist MCP handlers, temp DB — zero tokens spent) it proves:
#
#   PART A  the agent's mounted submit_ticket_for_review, called EXACTLY as the
#           factory mounts it (env token, no arg), is REFUSED — the ticket stays
#           `claimed` with its one active claim intact;
#   PART B  NO STRAND: the runner's empty-delivery park (`wg runner-release
#           --to refining --token …`) still succeeds with the STILL-VALID token —
#           the ticket lands in `refining`, never in_review-with-empty-diff;
#   PART C  the runner's own submit path (`wg submit --token`) keeps working
#           end-to-end (claimed → in_review, claim completed);
#   PART D  a caller that actually HOLDS the token (explicit claim_token arg —
#           the legitimate non-factory MCP use) can still submit.
#
# Requires the dispatch package built (dist CLI + dist MCP). SKIPs otherwise.
# Run: bash test/agent-self-submit.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CLI_JS="$ROOT/packages/dispatch/dist/cli/index.js"
CORE_JS="$ROOT/packages/dispatch/dist/core.js"
TOOLS_JS="$ROOT/packages/dispatch/dist/mcp/tools.js"

command -v node    >/dev/null 2>&1 || { echo "SKIP: node required";    exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
[ -f "$CLI_JS" ]   || { echo "SKIP: dispatch CLI not built ($CLI_JS) — run pnpm -C packages/dispatch build"; exit 0; }
[ -f "$TOOLS_JS" ] || { echo "SKIP: dispatch MCP not built ($TOOLS_JS) — run pnpm -C packages/dispatch build"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-self-submit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/dispatch.sqlite"

wg()   { node "$CLI_JS" --db "$DB" "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
status_of() { wg ticket show "$1" 2>/dev/null | jget "d['ticket']['status']" 2>/dev/null || echo ''; }
active_claims() {
  python3 - "$DB" "$1" <<'PY'
import sqlite3,sys
db,num=sys.argv[1],int(sys.argv[2]); c=sqlite3.connect(db)
print(c.execute("SELECT count(*) FROM ticket_claims tc JOIN tickets t ON t.id=tc.ticket_id "
                "WHERE t.number=? AND tc.status='active'",(num,)).fetchone()[0])
PY
}

# The disobedient agent's exact call surface: the REAL dist MCP handlers, an
# `agent` actor, the runner-held token ONLY in the server env (never an arg) —
# byte-for-byte how tick.sh mounts the dispatch MCP for the delivery agent.
# ESM import specifiers must be literals, so render the probe with the dist
# paths baked in. Prints one JSON line: {"isError":bool,"code":…,"status":…}.
MCP_PROBE="$WORK/mcp-probe.mjs"
# NOTE: quoted heredoc + dynamic import(process.env.*) — the dist paths arrive via
# env, not baked in, so this stays bash-3.2 safe (macOS /bin/bash has no ${var@Q}).
cat > "$MCP_PROBE" <<'PROBE'
import { pathToFileURL } from "node:url";
const { Dispatch } = await import(pathToFileURL(process.env.CORE_JS).href);
const { makeHandlers } = await import(pathToFileURL(process.env.TOOLS_JS).href);
const wg = Dispatch.open(process.env.DB);
const h = makeHandlers(wg, { type: "agent", id: "mcp-agent" });
const args = { ticket_id: process.env.TICKET_ID };
if (process.env.EXPLICIT_TOKEN) args.claim_token = process.env.EXPLICIT_TOKEN;
const res = h.submit_ticket_for_review(args);
const sc = res.structuredContent ?? {};
console.log(JSON.stringify({
  isError: res.isError === true,
  code: sc.error?.code ?? null,
  status: sc.status ?? null,
}));
PROBE
agent_mcp_submit() { # $1 = ticket id, env: GAFFER_CLAIM_TOKEN / EXPLICIT_TOKEN
  DB="$DB" TICKET_ID="$1" CORE_JS="$CORE_JS" TOOLS_JS="$TOOLS_JS" node "$MCP_PROBE" 2>/dev/null
}

# Seed one ready ticket + a runner claim; echoes "NUM<TAB>TID<TAB>TOKEN".
seed_claimed() {
  local title="$1" num tid token
  num="$(wg ticket create -t "$title" --description "finding-2 probe" --policy solo_loose --risk low 2>/dev/null | jget "d['ticket']['number']")"
  wg ac add "$num" -t "probe AC" >/dev/null 2>&1
  wg ticket ready "$num" >/dev/null 2>&1
  tid="$(wg ticket show "$num" 2>/dev/null | jget "d['ticket']['id']")"
  token="$(wg claim-ticket "$num" --agent "$AGENT" --ttl 900 2>/dev/null | jget "d['claimToken']")"
  printf '%s\t%s\t%s\n' "$num" "$tid" "$token"
}

echo "== SETUP: temp dispatch DB + registered factory agent =="
wg init >/dev/null 2>&1
AGENT="$(wg agent register -n gaffer-factory --max-risk high 2>/dev/null | jget "d['agent']['id']")"
[ -n "$AGENT" ] && ok "registered runner agent" || fail "setup: could not register agent"

seed_claimed "Disobedient delivery" > "$WORK/seed1"; IFS=$'\t' read -r NUM TID CLAIM_TOKEN < "$WORK/seed1"
{ [ -n "$NUM" ] && [ -n "$TID" ] && [ -n "$CLAIM_TOKEN" ]; } \
  && ok "seeded #$NUM: ready → runner-claimed (token held by the RUNNER)" \
  || fail "setup: could not seed a claimed ticket (num='$NUM' tid='$TID' token='${CLAIM_TOKEN:+set}')"

echo "== PART A: the agent-mounted submit (env token, no arg) is REFUSED =="
A_OUT="$(GAFFER_CLAIM_TOKEN="$CLAIM_TOKEN" agent_mcp_submit "$TID")"
A_ERR="$(printf '%s' "$A_OUT" | jget "d['isError']" 2>/dev/null || echo '')"
A_CODE="$(printf '%s' "$A_OUT" | jget "d['code']" 2>/dev/null || echo '')"
if [ "$A_ERR" = "True" ]; then
  ok "agent self-submit REFUSED (code=$A_CODE) — the env token is not a submit credential"
else
  fail "agent self-submit SUCCEEDED via the env-token fallback (got: $A_OUT) — the claim is completed and the strand sequence is live"
fi
[ "$(status_of "$NUM")" = "claimed" ] \
  && ok "#$NUM stays claimed after the refused self-submit" \
  || fail "#$NUM left 'claimed' after the agent's submit attempt (got '$(status_of "$NUM")')"
[ "$(active_claims "$NUM")" = "1" ] \
  && ok "the runner's claim is still ACTIVE (not completed by the agent)" \
  || fail "active claim count changed after the agent's submit attempt (active=$(active_claims "$NUM"))"

echo "== PART B: NO STRAND — the runner's empty-delivery park still works =="
# tick.sh's empty-delivery gate: gaffer_release_delivery refining … → wg runner-release.
if wg runner-release "$NUM" --to refining --token "$CLAIM_TOKEN" \
     --reason "empty delivery: agent produced no change — needs clarification/refinement" >/dev/null 2>&1; then
  ok "runner-release succeeded with the STILL-VALID runner-held token (no CLAIM_INVALID)"
else
  fail "runner-release FAILED — the runner's token was voided (the strand: branch dropped + ticket adrift)"
fi
FINAL="$(status_of "$NUM")"
[ "$FINAL" = "refining" ] \
  && ok "#$NUM parked to refining — never stranded in in_review with an empty diff" \
  || fail "#$NUM did not land in refining (got '$FINAL')"
[ "$FINAL" != "in_review" ] \
  && ok "strand signature absent: #$NUM is NOT in_review after the disobedient tick" \
  || fail "#$NUM is in_review with no delivered diff — the un-approvable strand"

echo "== PART C: the runner's OWN submit path keeps working (wg submit --token) =="
seed_claimed "Legit runner delivery" > "$WORK/seed2"; IFS=$'\t' read -r NUM2 TID2 TOKEN2 < "$WORK/seed2"
if wg submit "$NUM2" --token "$TOKEN2" --reason "gates passed" >/dev/null 2>&1 \
   && [ "$(status_of "$NUM2")" = "in_review" ]; then
  ok "runner submit: #$NUM2 claimed → in_review with the runner-held token"
else
  fail "runner submit path broken: #$NUM2 status '$(status_of "$NUM2")' after wg submit --token"
fi
[ "$(active_claims "$NUM2")" = "0" ] \
  && ok "runner submit COMPLETED the claim (zero active claims)" \
  || fail "claim not completed by the runner submit (active=$(active_claims "$NUM2"))"

echo "== PART D: an EXPLICIT claim_token still submits via MCP (legitimate holder) =="
seed_claimed "Explicit-token delivery" > "$WORK/seed3"; IFS=$'\t' read -r NUM3 TID3 TOKEN3 < "$WORK/seed3"
D_OUT="$(EXPLICIT_TOKEN="$TOKEN3" agent_mcp_submit "$TID3")"
D_ERR="$(printf '%s' "$D_OUT" | jget "d['isError']" 2>/dev/null || echo '')"
if [ "$D_ERR" = "False" ] && [ "$(status_of "$NUM3")" = "in_review" ]; then
  ok "explicit-token MCP submit still works (#$NUM3 → in_review)"
else
  fail "explicit-token MCP submit broken (out=$D_OUT status='$(status_of "$NUM3")')"
fi

echo
echo "── agent-self-submit results ─────────────────────────────"
echo "  PASS: $PASS"
if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo "  FAILURES: ${#FAILURES[@]}"
  for f in "${FAILURES[@]}"; do echo "    ✗ $f"; done
  exit 1
fi
echo "  all assertions passed"
exit 0
