#!/usr/bin/env bash
# =====================================================================
# P1b golden-fixture capture (docs/tick-sh-runtime-migration.md) — renders
# the REAL bash delivery context (prompt + MCP runtime config + the two
# context-primer blocks) and checks the results in as goldens for the TS
# renderer (packages/crew/src/runtime/context/) to byte-compare against.
# ---------------------------------------------------------------------
# REGENERATION (goldens are regenerated, never hand-edited):
#   bash runner/test/capture-context-golden.sh
# Writes into packages/crew/test/fixtures/tick-context/:
#   prompt.fresh.golden.txt         — the fresh delivery PROMPT
#   mcp-runtime.golden.json         — the rendered per-tick .mcp.json
#   file-cards-block.golden.txt     — gaffer_prime_context_block output
#   product-context-block.golden.txt— gaffer_product_context_block output
#   inputs.json                     — the exact renderer inputs the harness fed
#
# NORMALIZATIONS (the ONLY post-capture edits, documented for the byte-diff):
#   <temp GAFFER_DATA>   → __GAFFER_DATA__
#   <fixture repo root>  → __FIXTURE_REPO__
#   <live claim token>   → __CLAIM_TOKEN__
#
# Mechanism: seeds a throwaway dispatch DB + fixture repo, then runs ONE real
# `tick.sh` delivery with GAFFER_CONTEXT_DUMP_DIR + GAFFER_CONTEXT_DUMP_ONLY=1
# (render-only: the tick dumps the assembled context right after the MCP
# render and exits before the agent launch; the EXIT trap tears the fixture
# worktree/branch down). The memory CLI is pointed at a nonexistent path so
# the file-cards/product-context blocks are EMPTY in the main golden; the two
# block goldens are captured separately by driving the bash primer functions
# directly with a stubbed `lg` over checked-in packet fixtures.
# The capture runs TWICE (independent temp environments) and byte-compares
# the normalized outputs to prove the render is deterministic.
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
DISPATCH_CLI="$ROOT/packages/dispatch/dist/cli/index.js"
FIXTURES="$ROOT/packages/crew/test/fixtures/tick-context"
SKILLS_FIXTURE="$FIXTURES/skills"

# Fixed literal MCP bin paths: the MCP render is pure text (no existence check),
# so the goldens carry stable strings instead of machine-local paths.
FIX_DISPATCH_MCP_BIN="/opt/gaffer-fixture/dispatch-mcp/bin.js"
FIX_MEMORY_MCP_BIN="/opt/gaffer-fixture/memory-mcp/bin.js"
TICKET_TITLE="Add password reset flow"
TICKET_DESC="Users can request a password reset email and set a new password via a time-limited token."

die() { echo "FAIL: $1" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
node --input-type=commonjs -e "require('node:sqlite')" 2>/dev/null || { echo "SKIP: node:sqlite requires Node >= 22.5"; exit 0; }
[ -f "$DISPATCH_CLI" ] || { echo "SKIP: dispatch not built ($DISPATCH_CLI) — run pnpm -r build"; exit 0; }
[ -d "$SKILLS_FIXTURE" ] || die "fixture skills dir missing: $SKILLS_FIXTURE"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/capture-context.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# capture_once <subdir>: seed a FRESH env under $WORK/<subdir>, run one
# render-only tick, and write NORMALIZED prompt.txt + mcp-runtime.json into
# $WORK/<subdir>/out. Also records ticket number + skills/lenses strings.
capture_once() {
  local sub="$1" base="$WORK/$1"
  local repo="$base/fixture-app" data="$base/data" dump="$base/dump" out="$base/out"
  mkdir -p "$repo" "$data" "$out"

  # 1. Fixture repo: one commit, no package.json (keeps worktree setup inert).
  printf '# fixture-app\n' > "$repo/README.md"
  git -C "$repo" init -q -b main
  git -C "$repo" -c user.email=t@e -c user.name=t -c commit.gpgsign=false add -A
  git -C "$repo" -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -qm init

  # 2. Dispatch state: repo (stack typescript-react) + ONE ready ticket with a
  #    confirmed WRITE link and two ACs — the WG-002 partition path tick.sh takes.
  local db="$data/dispatch.sqlite"
  node "$DISPATCH_CLI" --db "$db" init >/dev/null || die "dispatch init"
  node "$DISPATCH_CLI" --db "$db" repo add -n fixture-app --path "$repo" --branch main \
    --stack typescript-react --test "true" >/dev/null || die "repo add"
  local tjson tid num
  tjson="$(node "$DISPATCH_CLI" --db "$db" ticket create -t "$TICKET_TITLE" -d "$TICKET_DESC" --risk low 2>/dev/null)"
  tid="$(printf '%s' "$tjson" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.parse(r).ticket.id)})')"
  num="$(printf '%s' "$tjson" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{process.stdout.write(String(JSON.parse(r).ticket.number))})')"
  [ -n "$tid" ] && [ -n "$num" ] || die "ticket create"
  # Deterministic repo id (it becomes the worktree leaf in the prompt's write
  # roots) + the confirmed/write link + ACs, exactly as the partition expects.
  DISPATCH_DB="$db" TID="$tid" node --input-type=commonjs -e '
    const {DatabaseSync} = require("node:sqlite");
    const db = new DatabaseSync(process.env.DISPATCH_DB);
    db.prepare("UPDATE repositories SET id = ?").run("fixture-repo-id");
    db.prepare("INSERT INTO ticket_repos(ticket_id,repo_id,role,access,relation,source) VALUES(?,?,?,?,?,?)")
      .run(process.env.TID, "fixture-repo-id", "primary", "write", "confirmed", "manual");
    db.prepare("INSERT INTO acceptance_criteria(id,ticket_id,text,sort_order) VALUES(?,?,?,0)")
      .run("ac-1", process.env.TID, "A reset email with a time-limited token is sent");
    db.prepare("INSERT INTO acceptance_criteria(id,ticket_id,text,sort_order) VALUES(?,?,?,1)")
      .run("ac-2", process.env.TID, "The token sets a new password exactly once");
  ' || die "seed link/ACs"
  node "$DISPATCH_CLI" --db "$db" ticket ready "$tid" >/dev/null 2>&1 || die "ticket ready"

  # 3. One render-only tick. MEMORY_CLI_BIN is nonexistent so every `lg` call
  #    fails soft → empty file-cards/product-context blocks (their goldens are
  #    captured separately below). MCP bins are fixed literals (pure text).
  env -i PATH="$PATH" HOME="$HOME" ${TMPDIR:+TMPDIR="$TMPDIR"} \
    DISPATCH_DB="$db" MEMORY_DB="$data/memory.sqlite" GAFFER_DATA="$data" \
    MEMORY_CLI_BIN="$base/nonexistent-memory-cli.js" \
    DISPATCH_MCP_BIN="$FIX_DISPATCH_MCP_BIN" MEMORY_MCP_BIN="$FIX_MEMORY_MCP_BIN" \
    SKILLS_DIR="$SKILLS_FIXTURE" \
    GAFFER_PLAN_MODEL=none GAFFER_IMPL_MODEL=none CLAUDE_BIN=/bin/false \
    DRY_RUN=0 GAFFER_CONTEXT_DUMP_DIR="$dump" GAFFER_CONTEXT_DUMP_ONLY=1 \
    bash "$RUNNER_DIR/tick.sh" > "$base/tick.log" 2>&1
  [ -s "$dump/prompt.txt" ] || { tail -30 "$base/tick.log" >&2; die "no prompt dumped ($sub)"; }
  [ -s "$dump/mcp-runtime.json" ] || die "no mcp-runtime dumped ($sub)"

  # 4. Normalize (the three documented rewrites) into $out.
  DUMP="$dump" OUT="$out" G_DATA="$data" G_REPO="$repo" node --input-type=commonjs -e '
    const fs = require("node:fs");
    const {DUMP, OUT, G_DATA, G_REPO} = process.env;
    const mcpRaw = fs.readFileSync(`${DUMP}/mcp-runtime.json`, "utf8");
    const token = JSON.parse(mcpRaw).mcpServers.dispatch.env.GAFFER_CLAIM_TOKEN;
    const norm = (s) => {
      let r = s.split(G_DATA).join("__GAFFER_DATA__").split(G_REPO).join("__FIXTURE_REPO__");
      if (token) r = r.split(token).join("__CLAIM_TOKEN__");
      return r;
    };
    fs.writeFileSync(`${OUT}/prompt.txt`, norm(fs.readFileSync(`${DUMP}/prompt.txt`, "utf8")));
    fs.writeFileSync(`${OUT}/mcp-runtime.json`, norm(mcpRaw));
  ' || die "normalize ($sub)"
  printf '%s' "$num" > "$out/ticket-number"
}

echo "== capture 1/2 (golden source) =="
capture_once run1
echo "== capture 2/2 (determinism check, independent env) =="
capture_once run2

cmp -s "$WORK/run1/out/prompt.txt" "$WORK/run2/out/prompt.txt" \
  || { diff "$WORK/run1/out/prompt.txt" "$WORK/run2/out/prompt.txt" | head -20 >&2; die "prompt capture is not deterministic"; }
cmp -s "$WORK/run1/out/mcp-runtime.json" "$WORK/run2/out/mcp-runtime.json" \
  || die "mcp-runtime capture is not deterministic"
echo "  ok   two independent captures are byte-identical (after normalization)"

NUM="$(cat "$WORK/run1/out/ticket-number")"

# ── Block goldens: drive the bash primer functions directly over the checked-in
# packet fixtures with a stubbed `lg` (the main capture's memory is empty).
# Captured via $(...) exactly as tick.sh consumes them (trailing newlines
# stripped), then written byte-exact. No paths → no normalization needed.
BLOCK_REPO="$WORK/run1/fixture-app"
( set -uo pipefail
  export GAFFER_DATA="$WORK/run1/data" DISPATCH_DB="$WORK/run1/data/dispatch.sqlite" MEMORY_DB="$WORK/run1/data/memory.sqlite"
  # shellcheck source=../factory.config.sh
  source "$RUNNER_DIR/factory.config.sh"
  # shellcheck source=../lib/context-primer.sh
  source "$RUNNER_DIR/lib/context-primer.sh"
  lg() {
    case "${1:-}" in
      repo-canonical)  printf 'example.com/fixture/fixture-app\n' ;;
      cards-for-scope) cat "$FIXTURES/cards-packet.json" ;;
      search)          cat "$FIXTURES/lore-rows.json" ;;
      *) return 1 ;;
    esac
  }
  FCB="$(gaffer_prime_context_block "$BLOCK_REPO" "fixture-app" "$TICKET_TITLE $TICKET_DESC")"
  [ -n "$FCB" ] || { echo "FAIL: empty file-cards block from fixture packet" >&2; exit 1; }
  printf '%s' "$FCB" > "$FIXTURES/file-cards-block.golden.txt"
  PCB="$(gaffer_product_context_block "fixture-app")"
  [ -n "$PCB" ] || { echo "FAIL: empty product-context block from fixture rows" >&2; exit 1; }
  printf '%s' "$PCB" > "$FIXTURES/product-context-block.golden.txt"
) || die "block-golden capture"
echo "  ok   primer block goldens captured"

# ── inputs.json: the EXACT renderer inputs this harness fed the bash path,
# post-normalization — what the TS golden tests replay. The skills/lenses
# strings are computed with the SAME commands tick.sh uses (tick.sh:1248–1257;
# stack typescript-react → area frontend per gaffer_area_for_stack). workBranch
# is deliberately ABSENT: the TS test derives it via workBranchName(number,
# title), so slug parity is proven through the prompt golden.
SKILLS_STR="$(node "$RUNNER_DIR/bin/select-skills.mjs" --stack "typescript-react" --area frontend --skills-dir "$SKILLS_FIXTURE")"
LENSES_STR="$(for _f in "$SKILLS_FIXTURE"/*/SKILL.md; do grep -qiE '^area:[[:space:]]*quality' "$_f" 2>/dev/null && basename "$(dirname "$_f")"; done | paste -sd, - 2>/dev/null)"
[ -n "$LENSES_STR" ] || LENSES_STR="minimalism"
WT_PATH="__GAFFER_DATA__/worktrees/ticket-$NUM/fixture-repo-id"
NUM="$NUM" TITLE="$TICKET_TITLE" SKILLS_STR="$SKILLS_STR" LENSES_STR="$LENSES_STR" WT_PATH="$WT_PATH" \
  DBIN="$FIX_DISPATCH_MCP_BIN" MBIN="$FIX_MEMORY_MCP_BIN" OUT="$FIXTURES/inputs.json" node --input-type=commonjs -e '
  const fs = require("node:fs");
  const e = process.env;
  fs.writeFileSync(e.OUT, JSON.stringify({
    _comment: "Captured by runner/test/capture-context-golden.sh — regenerate, never hand-edit.",
    ticketNumber: e.NUM,
    title: e.TITLE,
    resuming: false,
    skills: e.SKILLS_STR,
    lenses: e.LENSES_STR,
    reviewFeedbackReasons: [],
    fileCardsBlock: "",
    productContextBlock: "",
    writeRepos: [{ worktreePath: e.WT_PATH, name: "fixture-app" }],
    readRoots: [],
    primaryRepo: e.WT_PATH,
    mcp: {
      dispatchDb: "__GAFFER_DATA__/dispatch.sqlite",
      memoryDb: "__GAFFER_DATA__/memory.sqlite",
      dispatchMcpBin: e.DBIN,
      memoryMcpBin: e.MBIN,
      claimToken: "__CLAIM_TOKEN__",
      ticketRepos: "fixture-app",
    },
  }, null, 2) + "\n");
' || die "write inputs.json"

cp -f "$WORK/run1/out/prompt.txt" "$FIXTURES/prompt.fresh.golden.txt"
cp -f "$WORK/run1/out/mcp-runtime.json" "$FIXTURES/mcp-runtime.golden.json"
echo "PASS — goldens written to $FIXTURES"
