#!/usr/bin/env bash
# =====================================================================
# MEMORY FRESHNESS — gaffer_refresh_cards (lib/card-refresh.sh).
# ---------------------------------------------------------------------
# File cards are generated once at onboard; without write-through they go stale as the
# factory edits code. On a merge, gaffer_refresh_cards refreshes the cards for exactly the
# files the delivery changed. Proves, against the REAL memory CLI + a REAL git repo:
#   • a MODIFIED file's card is refreshed (content_hash changes) and KEEPS its model summary;
#   • a NEW file gets a card (with mechanical symbols);
#   • a DELETED file's card is removed;
#   • the repo_sync watermark advances to the delivered commit;
#   • it reads the DELIVERY BRANCH's tree (via a throwaway worktree), not the checkout.
# Run: bash test/card-refresh.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
MEM="$ROOT/packages/memory/dist/bin/memory.js"
[ -f "$MEM" ] || { echo "SKIP: memory CLI not built ($MEM)"; exit 0; }
# Read-only DB probes: the sqlite3 CLI when present, else the memory package's own
# better-sqlite3 binding (always built alongside the CLI) — so the test runs on hosts
# without the sqlite3 binary instead of skipping.
if command -v sqlite3 >/dev/null 2>&1; then
  q(){ sqlite3 -readonly "$MEMORY_DB" "$1" 2>/dev/null; }
else
  q(){ (cd "$ROOT/packages/memory" && node -e '
    const D=require("better-sqlite3"); const db=new D(process.argv[1],{readonly:true});
    const rows=db.prepare(process.argv[2]).raw().all();
    for (const r of rows) console.log(r.map(v=>v===null?"":String(v)).join("|"));
    db.close();' "$MEMORY_DB" "$1" 2>/dev/null); }
fi

export MEMORY_DB="$(mktemp -u).sqlite"
lg() { MEMORY_DB="$MEMORY_DB" node "$MEM" "$@"; }
log() { :; }   # the runner provides log(); stub it here
# shellcheck source=../lib/card-refresh.sh
source "$RUNNER_DIR/lib/card-refresh.sh"

P=0; F=0
ok(){ P=$((P + 1)); printf '  ok   %s\n' "$1"; }
no(){ F=$((F + 1)); printf '  FAIL %s\n' "$1"; }
gc(){ git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }

D="$(mktemp -d)"
git -C "$D" init -q -b main
printf 'export const foo=1\n' > "$D/foo.ts"
printf 'export const old=1\n' > "$D/old.ts"
git -C "$D" add -A; gc "$D" commit -q -m base
CANON="$(lg repo-canonical --repo-root "$D" 2>/dev/null)"
# foo.ts carries a MODEL summary (the onboard shape); the refresh must not erase it.
lg card upsert --canonical "$CANON" --repo testrepo --repo-root "$D" --path foo.ts --source onboard \
  --tldr "Exports the foo constant" --role-primary config >/dev/null 2>&1
lg card upsert --canonical "$CANON" --repo testrepo --repo-root "$D" --path old.ts --source onboard >/dev/null 2>&1
OLD_HASH="$(q "SELECT content_hash FROM file_card WHERE path='foo.ts'")"
OLD_TLDR="$(q "SELECT tldr FROM file_card WHERE path='foo.ts'")"
OLD_MSTAT="$(q "SELECT model_status FROM file_card WHERE path='foo.ts'")"
[ -n "$OLD_TLDR" ] || no "test setup: onboard upsert did not store a tldr"

# A delivery branch: MODIFY foo.ts, ADD new.ts, DELETE old.ts.
git -C "$D" checkout -q -b tkt
printf 'export const foo=1\nexport const bar=2\n' > "$D/foo.ts"
printf 'export function newFn(){}\n' > "$D/new.ts"
rm "$D/old.ts"
git -C "$D" add -A; gc "$D" commit -q -m delivery
BASE="$(git -C "$D" merge-base tkt main)"; HEAD="$(git -C "$D" rev-parse tkt)"

gaffer_refresh_cards "$D" testrepo "$BASE" tkt "$HEAD"

NEW_HASH="$(q "SELECT content_hash FROM file_card WHERE path='foo.ts'")"
{ [ -n "$NEW_HASH" ] && [ "$NEW_HASH" != "$OLD_HASH" ]; } && ok "MODIFIED foo.ts card refreshed (content_hash changed)" || no "foo.ts not refreshed"
NEW_TLDR="$(q "SELECT tldr FROM file_card WHERE path='foo.ts'")"
NEW_MSTAT="$(q "SELECT model_status FROM file_card WHERE path='foo.ts'")"
{ [ "$NEW_TLDR" = "$OLD_TLDR" ] && [ "$NEW_MSTAT" = "$OLD_MSTAT" ]; } \
  && ok "MODIFIED foo.ts keeps its model summary (tldr + model_status carried forward; --keep-model)" \
  || no "refresh wiped the model half (tldr '$OLD_TLDR' → '$NEW_TLDR', model_status '$OLD_MSTAT' → '$NEW_MSTAT')"
[ -n "$(q "SELECT 1 FROM file_card WHERE path='new.ts'")" ] && ok "NEW new.ts card added" || no "new.ts card missing"
[ -z "$(q "SELECT 1 FROM file_card WHERE path='old.ts'")" ] && ok "DELETED old.ts card removed" || no "old.ts card still present"
[ "$(q "SELECT synced_commit FROM repo_sync LIMIT 1")" = "$HEAD" ] && ok "watermark advanced to delivered commit" || no "watermark not advanced"
[ "$(q "SELECT length(symbols) FROM file_card WHERE path='new.ts'")" -gt 2 ] 2>/dev/null && ok "new.ts has mechanical symbols extracted" || no "no symbols on new.ts"
# no leftover worktree
[ -z "$(git -C "$D" worktree list 2>/dev/null | grep gaffer-cards)" ] && ok "throwaway worktree cleaned up" || no "worktree leaked"

rm -rf "$D"; rm -f "$MEMORY_DB"
echo
echo "card-refresh: $P passed, $F failed"
[ "$F" = 0 ]
