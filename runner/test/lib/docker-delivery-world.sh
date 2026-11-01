# shellcheck shell=bash
# Shared world for the docker-provider delivery tests:
#   sandbox-docker-delivery.test.sh       a real daemon: the agent and the DoD gates run
#                                         inside containers (and the opt-in live variant)
#   sandbox-docker-delivery-seam.test.sh  no daemon: a fake `docker` (lib/fake-docker.sh)
#                                         records every container and runs it on the host
# Both drive ONE ticket through the REAL tick.sh with SANDBOX_PROVIDER=docker,
# STRICT_MODE=1, GAFFER_STRICT_REQUIRE=1 and the MCP bridge on: the real worker seam,
# the real wrapper (lib/sandbox-docker.sh), the real host-side bridge, the real DoD
# gates under the validation profile, the real result-envelope parsing and the real
# submit. The agent is lib/docker-delivery-stub.mjs unless the live variant runs.
#
# Sourced AFTER the caller set HERE/RUNNER_DIR/ROOT and checked its prerequisites.
# Set DDW_NAME to name the temp dir; KEEP=1 keeps it for debugging.
. "$(dirname "${BASH_SOURCE[0]}")/tmpdir.sh"  # mktemp guard + safe temp removal
PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/${DDW_NAME:-docker-delivery}.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'ddw_cleanup' EXIT
ddw_cleanup() {
  # A real container runs as root, so on a Linux host what it wrote (git objects, the
  # worktree index) is root-owned; the real-daemon test defines ddw_pre_cleanup to hand
  # it back first. gaffer_test_rm_work refuses any path outside the temp root.
  if declare -F ddw_pre_cleanup >/dev/null 2>&1; then ddw_pre_cleanup; fi
  gaffer_test_rm_work "$WORK"
}
mkdir -p "$WORK/data" "$WORK/bin"

# ── What must stay OUT of every container ───────────────────────────────────────
# A fake host HOME (the HOME tick.sh runs with) holding a credentials file, and a
# canary file in a directory no mount covers. The probes inside try to read both and
# to write beside the canary; the host side checks nothing changed.
HOST_HOME="$WORK/host-home"; mkdir -p "$HOST_HOME/.aws"
printf '[default]\naws_secret_access_key = TOPSECRET_HOME_KEY\n' > "$HOST_HOME/.aws/credentials"
CANARY_DIR="$WORK/host-secret"; mkdir -p "$CANARY_DIR"
CANARY="$CANARY_DIR/canary.txt"; CANARY_TOKEN="TOPSECRET_CANARY_$$"
printf '%s\n' "$CANARY_TOKEN" > "$CANARY"
# The probe file the stub (and the gate probe) read: paths only, no secret values.
ddw_write_probe_json() {
  printf '{"hostHome":"%s","canary":"%s","canaryToken":"%s","gafferData":"%s"}\n' \
    "$HOST_HOME" "$CANARY" "$CANARY_TOKEN" "$WORK/data" > "$1"
}

# ── The target repo: a node project whose test command first runs the gate probe ──
# gate-probe.mjs is what the DoD tests gate runs before `node --test`. With --require
# (the real-daemon test) it FAILS the gate unless it runs inside a container that has
# no database, no bridge socket, no host HOME and no canary: so the ticket can only
# reach review if the gates really ran under the validation profile in a container.
R="$WORK/repo"; mkdir -p "$R/src" "$R/test"
( cd "$R" && git init -q -b main
  printf '{ "name": "r", "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node gate-probe.mjs && node --test", "lint": "node -e 0" } }\n' > package.json
  printf 'export function a() { return 1; }\n' > src/a.js
  printf 'import test from "node:test"; import assert from "node:assert/strict";\nimport { a } from "../src/a.js";\ntest("a", () => { assert.equal(a(), 1); });\n' > test/a.test.js
  cat > gate-probe.mjs <<'JS'
// DoD gate probe (sandbox-docker-delivery tests): where does this gate run?
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const require = process.argv.includes("--require");
let cfg = null;
try { cfg = JSON.parse(readFileSync("/etc/gaffer-e2e/probe.json", "utf8")); } catch { /* none */ }
const seen = [];
seen.push(existsSync("/.dockerenv") ? "GATE_IN_CONTAINER" : "GATE_ON_HOST");
if (cfg) {
  const dbs = ["dispatch.sqlite", "memory.sqlite"].map((f) => path.join(cfg.gafferData, f));
  seen.push(dbs.some((p) => existsSync(p)) ? "GATE_DB_VISIBLE" : "GATE_DB_ABSENT");
  let sock = false;
  try { sock = readdirSync("/tmp").some((d) => d.startsWith("gaffer-mcp.")); } catch { /* none */ }
  seen.push(sock ? "GATE_BRIDGE_VISIBLE" : "GATE_BRIDGE_ABSENT");
  seen.push(existsSync(cfg.hostHome) ? "GATE_HOME_VISIBLE" : "GATE_HOME_ABSENT");
  let c = ""; try { c = readFileSync(cfg.canary, "utf8"); } catch { /* none */ }
  seen.push(c.includes(cfg.canaryToken) ? "GATE_CANARY_LEAK" : "GATE_CANARY_UNREADABLE");
  seen.push(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN ? "GATE_CREDENTIAL_PRESENT" : "GATE_CREDENTIAL_ABSENT");
} else seen.push("GATE_NO_PROBE_FILE");
console.log("gate-probe: " + seen.join(" "));
const bad = ["GATE_ON_HOST", "GATE_DB_VISIBLE", "GATE_BRIDGE_VISIBLE", "GATE_HOME_VISIBLE", "GATE_CANARY_LEAK", "GATE_CREDENTIAL_PRESENT", "GATE_NO_PROBE_FILE"];
if (require && seen.some((s) => bad.includes(s))) { console.error("gate-probe: the DoD gate did not run in the validation sandbox"); process.exit(1); }
JS
  git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )

# ── The factory: config, databases, the repo, one ready ticket ──────────────────
# CLAUDE_BIN is the stub on the HOST too: the worker seam reads the host binary's
# version before it swaps in the image's `claude`, and that must never be a real CLI.
STUB="$HERE/lib/docker-delivery-stub.mjs"
export GAFFER_DATA="$WORK/data" CLAUDE_BIN="$STUB" CLAUDE_FLAGS="" GAFFER_CLAUDE_VERSION="docker-delivery-stub" \
       HOME="$HOST_HOME" \
       GAFFER_MAX_TURNS=40 GAFFER_TICK_TIMEOUT=600 GAFFER_CARD_MODEL=stub GAFFER_PLAN_MODEL=stub GAFFER_IMPL_MODEL=stub \
       REVIEW_MODE=human DRY_RUN=0 GAFFER_MAINTENANCE=0 AUTO_MERGE=0 GAFFER_SECURITY_REVIEW=0 GAFFER_TESTING=0 \
       MAX_OPEN_AGENT_BRANCHES_PER_REPO=50 MAX_OPEN_AGENT_PRS_PER_REPO=50 \
       STRICT_MODE=1 SANDBOX_PROVIDER=docker GAFFER_STRICT_REQUIRE=1 GAFFER_MCP_BRIDGE=1 \
       GAFFER_DAILY_BUDGET_USD=5
unset GAFFER_MODE GAFFER_SANDBOX_DRY_RUN GAFFER_MCP_BRIDGE_SOCKET GAFFER_SANDBOX_DATA_PLANE GAFFER_SANDBOX_PROFILE
# The stub needs no credential: only the opt-in live variant (DDW_LIVE=1) keeps one.
[ "${DDW_LIVE:-0}" = 1 ] || unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN GAFFER_SANDBOX_CLAUDE_CREDENTIALS
# shellcheck source=../../factory.config.sh
source "$RUNNER_DIR/factory.config.sh" >/dev/null 2>&1
wg init >/dev/null 2>&1; lg init >/dev/null 2>&1
# A dashboard secret beside the databases: it must not be visible inside either.
printf '{"note":"TOPSECRET_SETTINGS"}\n' > "$GAFFER_DATA/settings.json"

# ddw_add_repo <test command>
ddw_add_repo() {
  wg repo add -n repo --path "$R" --branch main --stack node --test "$1" --lint "node -e 0" >/dev/null 2>&1
}
# ddw_new_ready <title> → the ticket number
ddw_new_ready() {
  local n
  n="$(wg ticket create -t "$1" -d "Add a helper function that returns 2, with a test for it, in src/a.js and test/a.test.js." --risk low 2>/dev/null | jget 'd.ticket.number')"
  wg ac add "$n" -t "a helper that returns 2 is exported from src/a.js and covered by a test" >/dev/null 2>&1
  wg ticket repo-access set "$n" repo --access write --relation confirmed >/dev/null 2>&1
  wg ticket ready "$n" >/dev/null 2>&1
  printf '%s' "$n"
}
ddw_run_tick() { ( cd "$RUNNER_DIR" && bash ./tick.sh 2>>"$GAFFER_DATA/tick.stderr.log" ) | grep '^TICK_RESULT=' ; }
ddw_status() { wg ticket show "$1" 2>/dev/null | jget 'd.ticket.status'; }
# The agent's evidence summaries on the ticket (one per line).
ddw_evidence() {
  wg ticket show "$1" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const e of JSON.parse(s).evidence||[])console.log(String(e.summary||"").replace(/\n/g," "))}catch{}})'
}
# "yes" when every acceptance criterion of the ticket is satisfied, else "no:<statuses>".
ddw_acs_satisfied() {
  wg ticket show "$1" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s).acceptanceCriteria||[];process.stdout.write(a.length&&a.every(x=>x.status==="satisfied")?"yes":"no:"+a.map(x=>x.status).join(","))}catch{process.stdout.write("no:unreadable")}})'
}
# ddw_gate <ticket> <gate> → "<status> <command>" from the DoD checklist evidence (its
# JSON rides on the summary line after "DoD: <verdict>").
ddw_gate() {
  wg ticket show "$1" 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let out="";
      const parse=(t)=>{try{return JSON.parse(t)}catch{return null}};
      try{for(const e of JSON.parse(s).evidence||[]){
        const p=parse(e.payload_json||"null")||parse(String(e.summary||"").split("\n").find((l)=>l.startsWith("{"))||"null");
        for(const g of (p&&p.gates)||[]) if(g.gate===process.argv[1]) out=g.status+" "+g.note;}}catch{}
      process.stdout.write(out)})' "$2"
}
ddw_branch() { git -C "$R" branch --list "gaffer/ticket-$1-*" | tr -d ' *+' | head -1; }

# ddw_common_asserts <ticket>: what both variants must show after the tick.
ddw_common_asserts() {
  local n="$1" br log
  [ "$(ddw_status "$n")" = "in_review" ] \
    && ok "#$n delivered through the docker provider and reached in_review" \
    || fail "#$n is '$(ddw_status "$n")', expected in_review (tick: $(tail -5 "$GAFFER_DATA/factory.log" 2>/dev/null | tr '\n' ' ' | cut -c1-600))"
  br="$(ddw_branch "$n")"
  if [ -n "$br" ] && [ "$(git -C "$R" rev-list --count "main..$br" 2>/dev/null || echo 0)" -ge 1 ]; then
    ok "the agent's commit is on $br in the host repo (worktree written, commit round-tripped)"
  else
    fail "no agent commit on the ticket branch (branch='$br')"
  fi
  log="$GAFFER_DATA/factory.log"
  grep -q "wrapping live agent via provider 'docker'" "$log" 2>/dev/null \
    && ok "tick.sh wrapped the agent through the docker provider" \
    || fail "no docker wrap logged in factory.log"
  grep -q 'DoD gates + AC checks will run under the same OS sandbox' "$log" 2>/dev/null \
    && ok "tick.sh handed the same wrap to the DoD gates" \
    || fail "the DoD gates were not given the docker wrap"
  case "$(ddw_evidence "$n")" in
    *"# tests 2 # pass 2 # fail 0"*) ok "the DoD tests gate ran the delivered test (tally: 2 tests, 2 pass, 0 fail)" ;;
    *) fail "no DoD tally with the delivered test passing on #$n" ;;
  esac
  grep -F "$CANARY_TOKEN" "$CANARY" >/dev/null 2>&1 && [ "$(wc -l < "$CANARY" | tr -d ' ')" = 1 ] \
    && ok "the host canary is unchanged" || fail "the host canary changed"
}

# ddw_ledger_cost <ticket> → "<rows> <cost>": the measured delivery rows the usage ledger
# booked for the ticket (parsed from the agent's result envelope) and their summed cost
ddw_ledger_cost() {
  node -e '
    const fs=require("fs"),p=require("path");const dir=process.argv[1],t=process.argv[2];let total=0,rows=0;
    for(const f of ["usage-ledger.jsonl"]){ if(!fs.existsSync(p.join(dir,f))) continue;
      for(const l of fs.readFileSync(p.join(dir,f),"utf8").split("\n")){ if(!l.trim()) continue;
        try{const r=JSON.parse(l); if(String(r.ticket)===t && r.kind==="delivery" && r.measured){rows++; total+=Number(r.total_cost_usd||0);} }catch{} } }
    process.stdout.write(rows+" "+total.toFixed(4));' "$GAFFER_DATA" "$1" 2>/dev/null
}
