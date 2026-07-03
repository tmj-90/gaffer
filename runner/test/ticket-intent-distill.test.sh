#!/usr/bin/env bash
# =====================================================================
# Ticket → lore distillation at close (Track 1c, live-path backport).
# ---------------------------------------------------------------------
# Proves the LIVE runner harvests a closed ticket's product intent into a
# human-gated REQUIREMENT DRAFT — the crew `distillTicketIntent` seam, ported
# into tick.sh so it runs for the real agent, not only the crew mock loop.
#
#   A. WIRING (static): tick.sh defines a fail-soft gaffer_distill_ticket_intent
#      helper and CALLS it in the submit-success path (right after recall-feedback).
#   B. BEHAVIOURAL (live, needs memory built): driving the helper on a ticket that
#      HAS acceptance criteria lands exactly one REQUIREMENT lore record. By DEFAULT it
#      is auto-promoted ACTIVE (so it primes future agents on unattended runs — audit
#      fix 3109af6); GAFFER_MEMORY_AUTO_PROMOTE=0 keeps it a human-gated DRAFT.
#   C. BEHAVIOURAL: a ticket with NO acceptance criteria is a no-op (nothing durable).
#
# Run:  perl -e 'alarm 120; exec @ARGV' /bin/bash runner/test/ticket-intent-distill.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
GAFFER_HOME="$(cd "$RUNNER_DIR/.." && pwd)"
TICK="$RUNNER_DIR/tick.sh"
MEMORY_CLI="$GAFFER_HOME/packages/memory/dist/bin/memory.js"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

echo "== A. WIRING — helper defined + called in the submit-success path =="
if grep -q 'gaffer_distill_ticket_intent()' "$TICK"; then
  ok "gaffer_distill_ticket_intent helper defined"
else
  fail "gaffer_distill_ticket_intent helper missing"
fi
if grep -q 'lg suggest --title' "$TICK" && grep -q -- '--kind requirement' "$TICK"; then
  ok "helper drafts a requirement via the memory suggest boundary"
else
  fail "helper does not draft a requirement (lg suggest --kind requirement)"
fi
# Fail-soft: never fatal to a delivery that already submitted.
if grep -A80 'gaffer_distill_ticket_intent()' "$TICK" | grep -q 'non-fatal'; then
  ok "helper is fail-soft (non-fatal on error)"
else
  fail "helper is not documented/implemented as fail-soft"
fi
# Called at close, right after the clean/reworked recall-feedback fork.
if grep -A6 'gaffer_recall_feedback clean' "$TICK" | grep -q 'gaffer_distill_ticket_intent'; then
  ok "distiller is called in the submit-success path (after recall-feedback)"
else
  fail "distiller is not wired into the submit-success path"
fi

echo "== B/C. LIVE — a closed ticket with AC distils exactly one requirement DRAFT =="
if [ ! -f "$MEMORY_CLI" ]; then
  echo "  SKIP: memory not built ($MEMORY_CLI missing — run: pnpm --filter memory-mcp build)"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  export MEMORY_DB="$TMP/memory.sqlite"

  # Minimal live deps the helper closes over (mirrors factory.config.sh).
  lg()   { MEMORY_DB="$MEMORY_DB" node "$MEMORY_CLI" "$@"; }
  jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
  log()  { :; }
  export -f lg jget log 2>/dev/null || true

  # Extract the helper straight from tick.sh and source it — genuinely drives
  # the SHIPPING function, not a copy.
  FN="$TMP/distill.fn.sh"
  awk '/^gaffer_distill_ticket_intent\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$TICK" > "$FN"
  if ! grep -q 'gaffer_distill_ticket_intent()' "$FN"; then
    fail "could not extract gaffer_distill_ticket_intent from tick.sh"
  else
    # shellcheck disable=SC1090
    source "$FN"

    # ── B: ticket WITH acceptance criteria ────────────────────────────────
    DRY_RUN=0
    NUM=42
    TITLE="Add password rotation"
    RECALL_REPO_NAME="app"
    SHOW='{"ticket":{"title":"Add password rotation"},"acceptanceCriteria":[{"text":"Passwords rotate every 90 days","status":"pending"},{"text":"Rotation is auditable","status":"pending"}]}'
    gaffer_distill_ticket_intent

    # Default (GAFFER_MEMORY_AUTO_PROMOTE=1): the distilled requirement is auto-promoted
    # ACTIVE so it primes future agents on UNATTENDED runs (audit tier-2 fix 3109af6) —
    # otherwise the priming block stays permanently empty when no human ever reviews it.
    ACTIVE="$(lg search --repo app --kind requirement --json 2>/dev/null || echo '[]')"
    AN="$(printf '%s' "$ACTIVE" | jget 'len(d)' 2>/dev/null || echo 0)"
    if [ "$AN" = "1" ]; then ok "distilled requirement is auto-promoted ACTIVE (primes future agents)"; else fail "expected 1 active requirement (auto-promoted), got $AN"; fi
    AT="$(printf '%s' "$ACTIVE" | jget "d[0]['title'] if d else ''" 2>/dev/null || echo '')"
    case "$AT" in
      "Requirement from #42:"*) ok "record title carries the ticket provenance ($AT)" ;;
      *) fail "record title not derived from ticket (got: $AT)" ;;
    esac

    # The human-gate is still honoured: GAFFER_MEMORY_AUTO_PROMOTE=0 keeps a distilled
    # requirement a DRAFT (invisible to a normal active-only search) for review-first workflows.
    NUM=52; TITLE="Add rate limiting"
    SHOW='{"ticket":{"title":"Add rate limiting"},"acceptanceCriteria":[{"text":"429 on burst","status":"pending"}]}'
    GAFFER_MEMORY_AUTO_PROMOTE=0 gaffer_distill_ticket_intent
    G_ACTIVE="$(lg search --repo app --kind requirement --json 2>/dev/null | jget "len([r for r in d if 'Requirement from #52' in r['title']])" 2>/dev/null || echo 0)"
    G_DRAFT="$(lg search --repo app --kind requirement --include-drafts --json 2>/dev/null | jget "len([r for r in d if 'Requirement from #52' in r['title']])" 2>/dev/null || echo 0)"
    if [ "$G_ACTIVE" = "0" ] && [ "$G_DRAFT" = "1" ]; then ok "GAFFER_MEMORY_AUTO_PROMOTE=0 keeps the distilled requirement a human-gated DRAFT"; else fail "gate env should draft not promote (active=$G_ACTIVE draft=$G_DRAFT)"; fi

    # ── C: ticket with NO acceptance criteria is a no-op ──────────────────
    NUM=43
    TITLE="Trivial tweak"
    SHOW='{"ticket":{"title":"Trivial tweak"},"acceptanceCriteria":[]}'
    gaffer_distill_ticket_intent
    D43="$(lg search --repo app --kind requirement --include-drafts --json 2>/dev/null | jget "len([r for r in d if 'Requirement from #43' in r['title']])" 2>/dev/null || echo 0)"
    if [ "$D43" = "0" ]; then ok "no-AC ticket harvests nothing (conservative no-op)"; else fail "no-AC ticket wrongly drafted lore"; fi

    # ── Fail-soft: DRY_RUN short-circuits (no draft) ──────────────────────
    DRY_RUN=1; NUM=44; TITLE="Dry"; SHOW='{"acceptanceCriteria":[{"text":"x","status":"pending"}]}'
    gaffer_distill_ticket_intent
    D44="$(lg search --repo app --kind requirement --include-drafts --json 2>/dev/null | jget "len([r for r in d if 'Requirement from #44' in r['title']])" 2>/dev/null || echo 0)"
    if [ "$D44" = "0" ]; then ok "DRY_RUN is a no-op (fail-soft)"; else fail "DRY_RUN wrongly drafted lore"; fi
  fi
fi

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS ($PASS checks)"
  exit 0
else
  echo "FAILED (${#FAILURES[@]} of $((PASS + ${#FAILURES[@]})) checks):"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
