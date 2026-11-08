# shellcheck shell=bash
# runner/config/12-identity.sh: identity: the dashboard-spawned command strings (DISPATCH_*_CMD) and the
# factory agent's name, id files and log.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# NOTE on the DISPATCH_*_CMD defaults below: these are plain command STRINGS that
# Dispatch's parseCommand whitespace-splits. The space-safe form is a JSON argv
# array (e.g. ["node","/abs path/x.mjs"]) which parseCommand also accepts — and
# `runner/gaffer dashboard` builds exactly that from $RUNNER_DIR when it exports
# these into the dashboard's env, so the supported launch path is space-safe. The
# string defaults here assume a $RUNNER_DIR with no spaces; if you launch the
# Dispatch API directly from a checkout path containing spaces, set these to JSON
# argv arrays yourself.

# The dashboard's "Suggest work" button (POST /product-owner/runs) spawns this
# command (detached, with DISPATCH_PRODUCT_OWNER_REPO in its env naming the repo to
# suggest work for). It runs the product-owner skill headlessly and files draft
# tickets into the backlog. `gaffer dashboard` exports this into the dashboard's env;
# set it here for a fresh setup. Absolute path so the detached child resolves it.
DISPATCH_PRODUCT_OWNER_CMD="${DISPATCH_PRODUCT_OWNER_CMD:-node $RUNNER_DIR/bin/product-owner-run.mjs}"

# The dashboard Memory view's "Onboard a repo" button (POST /repos/onboard) spawns
# this command (detached, with DISPATCH_ONBOARD_REPO in its env naming the repo —
# a registered name/id OR a local path — to onboard). The wrapper resolves the
# target to an on-disk path and runs crew's real `repo onboard <path>
# --standalone`, so the repo is scanned, registered in Dispatch, and its digest +
# feature inventory land in the memory store the Memory views read. `gaffer
# dashboard` exports this into the dashboard's env; set it here for a fresh setup.
# Absolute path so the detached child resolves it.
DISPATCH_ONBOARD_CMD="${DISPATCH_ONBOARD_CMD:-node $RUNNER_DIR/bin/onboard-run.mjs}"

# The BROWNFIELD epic → feature(`building`) hook. POST /epics spawns this (detached,
# no shell, request values as discrete argv) when every ticket of a just-created
# epic targets ONE existing registered repo: bin/epic-feature.mjs adds that feature
# to the memory ledger with status `building` and the epic ref as provenance.
# Best-effort and fire-and-forget — the epic is created either way. Unset/blank =
# no feature write. Absolute path so the detached child resolves it.
DISPATCH_EPIC_FEATURE_CMD="${DISPATCH_EPIC_FEATURE_CMD:-node $RUNNER_DIR/bin/epic-feature.mjs}"

# Factory identity + bookkeeping
_GAFFER_AGENT_NAME=gaffer-factory   # the factory agent's registered name (fixed)
GAFFER_AGENT_ID_FILE="${GAFFER_AGENT_ID_FILE:-$GAFFER_DATA/agent_id}"
# The runner's REVIEWER principal: a second, separately registered agent whose id the
# review pass presents on `review approve|reject --as agent`. Registered once (like the
# delivery agent) so the reviewer-not-author rule compares two REGISTERED actors, not a
# free string; dispatch refuses an agent approver that is not a registered agent.
GAFFER_REVIEWER_ID_FILE="${GAFFER_REVIEWER_ID_FILE:-$GAFFER_DATA/agent_reviewer_id}"
GAFFER_LOG="${GAFFER_LOG:-$GAFFER_DATA/factory.log}"

_GAFFER_CONFIG_PART=12-identity
