#!/usr/bin/env bash
# =====================================================================
# lib/acceptance.sh — the runner's half of the ACCEPTANCE GATE.
#
# Dispatch creates one build-level ACCEPTANCE ticket per epic (tickets.acceptance = 1):
# dependent on every implementation ticket, testable, routed through the independent
# tester on approval whatever GAFFER_TESTING says. "Implementation merged" and "build
# accepted" are different states (`wg stats` → acceptance). Why: a live run merged
# 13/13 reviewed, judged tickets and the finished application still failed a
# brief-level check (20 concurrent writes → 8 × HTTP 500) that no ticket criterion
# covered.
#
# This file supplies (1) the prompt block the delivery agent gets when the ticket it
# claimed IS the acceptance ticket — write the brief-level suite, fix what it finds,
# never weaken a test — and (2) nothing else: the tester lane (lib/tester.sh) runs
# for acceptance tickets even when the lane is off, and status.sh / loop.sh count an
# unaccepted build as human attention. Sourced by factory.config.sh.
# =====================================================================

# gaffer_acceptance_prompt_block → the block prepended to the product-context section
# of the delivery prompt for an acceptance ticket. Plain instructions, no ticket text
# (the ticket's own description and criteria arrive through the normal, quarantined
# channels).
gaffer_acceptance_prompt_block() {
  cat <<'BLOCK'
## THIS IS THE EPIC'S ACCEPTANCE TICKET (build-level, runs last)
Every implementation ticket of this epic has merged; you are working on the integrated
default branch. Your job is NOT a feature. It is:
1. Write a brief-level ACCEPTANCE test suite under the repository's normal test command
   that exercises the whole build end to end through its real entry points (CLI, HTTP,
   files, UI as they exist), covering the acceptance criteria — including the
   cross-cutting ones: persistence across a restart, concurrent writers (across
   processes where more than one can write), failure behaviour, runtime support.
2. Run it. Fix every defect it finds with the smallest change that makes the suite
   pass. Never weaken, skip or delete an existing test to get green.
3. Leave the suite in the repo. The INDEPENDENT tester then verifies the build from the
   contract and criteria only; the build is accepted when that verdict is recorded.
A criterion that does not apply to this build (e.g. it stores no data) is satisfied
by a test that documents why, not by silence.
BLOCK
}
