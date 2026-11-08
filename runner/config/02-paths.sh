# shellcheck shell=bash
# runner/config/02-paths.sh: paths: the product locations under GAFFER_HOME, the shared databases and
# data files under GAFFER_DATA, the code index switch, the ledger reader module.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# Product locations (mono layout: packages/* under the repo root)
DISPATCH_DIR="${DISPATCH_DIR:-$GAFFER_HOME/packages/dispatch}"
CREW_DIR="${CREW_DIR:-$GAFFER_HOME/packages/crew}"
MEMORY_DIR="${MEMORY_DIR:-$GAFFER_HOME/packages/memory}"   # memory-mcp, vendored into the mono

# Shared databases (the two MCP servers read these)
DISPATCH_DB="${DISPATCH_DB:-$GAFFER_DATA/dispatch.sqlite}"
MEMORY_DB="${MEMORY_DB:-$GAFFER_DATA/memory.sqlite}"
CREW_CONFIG="${CREW_CONFIG:-$GAFFER_DATA/crew.yaml}"
# memory's MCP/CLI audit trail. memory-mcp's own default is per-user
# ($HOME/.memory/audit.jsonl), which every factory on a machine would share, which
# survives deleting .gaffer, and which in the container sits outside the /data
# volume. Pin it into this factory's data dir. Not `audit.jsonl`: dispatch already
# writes that name beside dispatch.sqlite here. Exported (and kept by
# gaffer_agent_env) so lg, doctor and the agent's memory-mcp all write the same file.
MEMORY_AUDIT_LOG="${MEMORY_AUDIT_LOG:-$GAFFER_DATA/memory-audit.jsonl}"
export MEMORY_AUDIT_LOG
# CODE INDEX: memory's files -> symbols -> imports -> tests map of each repo (TS, JS,
# Python; by import text, no model). Built at onboard and refreshed after each merge; the
# Review's Behavioural surface reads it for the callers of changed symbols and the
# delivery's file cards for the callers and tests of what a ticket names. 0 turns off the
# runner's builds and the file-card lines (an index already built is then left as it is).
: "${GAFFER_CODE_INDEX:=1}"   # 1 builds the code index at onboard / merge and primes callers into file cards; 0 off
export GAFFER_CODE_INDEX

# Shared usage-ledger READER (lib/estimate.mjs parseLedger). Every inline-node
# consumer of the JSONL ledger imports this ONE parser instead of hand-rolling a
# per-call-site parse loop. Exported because gaffer_ticket_rework_spend is
# `export -f`'d and must resolve the module in child shells where RUNNER_DIR
# (deliberately unexported) is absent.
_GAFFER_ESTIMATE_LIB="$RUNNER_DIR/lib/estimate.mjs"   # internal: a runner file, not a knob
export _GAFFER_ESTIMATE_LIB
_GAFFER_EVAL_LEDGER="$GAFFER_DATA/eval-ledger.jsonl"   # internal: the eval judge's ledger, the file the dashboard reads

_GAFFER_CONFIG_PART=02-paths
