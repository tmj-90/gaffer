#!/usr/bin/env bash
# Stub `claude` for the browser harnesses (scripts/ui-regression/run.sh and
# run-suites.sh). Stands in for the real worker so every factory seam runs without
# a model key. The work is done by stub-worker.mjs (setup.sh installs it beside this
# file as $OUT/bin/stub-worker.mjs); this wrapper only hands it the argv.
#
# What it answers, by the prompt it is given:
#   • delivery (cwd is a git worktree with a package.json): appends ONE unique helper +
#     test per ticket, commits, and returns the JSON result envelope with a
#     smallest-change note — so DoD (npm test), the AC check, hygiene and minimalism all
#     see a real, passing change;
#   • reviewer (prompt asks for the machine-read verdict): {"verdict":"APPROVE"};
#   • tester (prompt asks for "black-box tests for #N"): see the tester_* modes
#     (default: tester_pass);
#   • intake clarify ("You are an INTAKE agent"): a bare "ok" unless mode clarify;
#   • conflict resolver ("resolve a merge conflict on the delivery branch", bin/
#     merge-ticket.mjs): merges the default branch into the branch for real and resolves
#     each conflict block (the default branch's lines, then the branch's own lines it
#     lacks, minus the branch's rewrite of addTask), commits ON the branch;
#   • greenfield bootstrap (cwd is the fresh repo the runner made: a git repo with no
#     package.json): scaffolds package.json + src/tasks.js + one passing test, commits;
#   • everything else (onboard analysis, product owner, judge): a bare "ok" envelope —
#     the product-owner run therefore ends "failed: filed 0 drafts", which is the honest
#     classification and is asserted as "run recorded", not "drafts filed".
#
# MODES. The runner starts the agent under `env -i` with an allowlist, so a STUB_*
# variable never reaches this process; GAFFER_DATA and GAFFER_TICKET do. A mode is
# therefore read from $GAFFER_DATA/stub-mode.json, keyed by ticket NUMBER (a "*" key
# is the fallback; no file or no key = ok). A value is a mode name or an object
# {"mode": "<name>", ...options}:
#   ok                 the default behaviour above.
#   fail_first         delivery attempt 1 adds a test that FAILS (stubFailFirst<N>) and
#                      commits; every later delivery call fixes that assertion and
#                      commits — so the DoD tests gate rejects attempt 1 and the runner's
#                      in-tick rework loop re-invokes the agent with the real failure.
#   fail_always        like fail_first, but no later call fixes it: every attempt fails
#                      the tests gate (a delivery that exhausts its attempts and parks).
#   changes_verdict    the FIRST reviewer call for the ticket says RECOMMEND CHANGES and
#                      ends {"verdict":"CHANGES"}; later reviewer calls APPROVE.
#   tester_pass        the tester commits test/tester-<N>.test.js (a passing black-box
#                      test) and ends {"verdict":"PASS"}.
#   tester_fail        the tester ends "FAIL: …" + {"verdict":"FAIL"} (no commit).
#   tester_no_verdict  the tester ends without a token, so the runner HOLDS in_testing.
#   clarify            on an intake prompt: files one acceptance criterion and a
#                      human_required decision through the REAL dispatch MCP server the
#                      runner mounted (--mcp-config). On the FIRST delivery call: files a
#                      blocking decision the same way and commits nothing; later delivery
#                      calls deliver normally.
#   slow_claim         the delivery sleeps {"secs": N} seconds (default 25) first, so a
#                      live claim / a working robot is on screen long enough to act on.
#   pause_first        delivery attempt 1 commits its work and reports a turn-cap stop
#                      (subtype error_max_turns, num_turns 999), so GAFFER_PAUSE_ON_CAP
#                      pauses the ticket; the resumed call (after Continue) finishes.
#   conflict           the delivery rewrites line 1 of src/tasks.js (addTask) with a
#                      ticket-specific body, so two such tickets conflict on merge.
#                      {"mode":"conflict","resolver":"markers"}: the resolver commits the
#                      conflicted files with the markers still in (a bad resolution).
# Every call is RECORDED as one JSON line in $GAFFER_DATA/stub-calls.jsonl:
#   {ts, kind, ticket, mode, call, cwd, argv (prompt elided), env (GAFFER_* names and
#    values the agent saw), prompt}
# so a suite can prove a setting reached the next tick (env / --max-turns) and that a
# human's words reached the agent (prompt).
_w="$(dirname "$0")/stub-worker.mjs"
if [ ! -f "$_w" ]; then
  echo "stub-claude: $_w is missing — install stub-worker.mjs beside this wrapper (setup.sh does; a test that copies only the wrapper must copy both)" >&2
  exit 70
fi
exec node "$_w" "$@"
