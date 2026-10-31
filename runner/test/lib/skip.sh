#!/usr/bin/env bash
# runner/test/lib/skip.sh — the one shared SKIP convention for runner tests.
#
#   gaffer_skip "<reason>"        the WHOLE test cannot run here: prints
#                                 "SKIP: <reason>" and exits 77 (the automake /
#                                 TAP "skipped" code), so a harness can tell a
#                                 skip from a pass. Never use it for a runtime
#                                 failure of the code under test (a CLI call that
#                                 errors or returns the wrong shape is a FAIL).
#   gaffer_skip_part "<reason>"   one SECTION cannot run here; the test goes on.
#                                 Prints "SKIP: <reason>" and bumps GAFFER_SKIPS —
#                                 never count a skipped check as an ok.
#   gaffer_skip_allowed "<reason>"  0 when the reason is a genuine platform /
#                                 infrastructure prerequisite. runner/test/run.sh
#                                 uses it under GAFFER_TEST_STRICT=1 (set in CI)
#                                 to fail every OTHER skip: CI builds every
#                                 package and has node, python3, perl and git, so
#                                 "not built" / "node required" there means the
#                                 job — or the code — is broken.
#
# Older tests still `echo "SKIP: …"; exit 0`; run.sh recognises that line too
# (any output line starting "SKIP" or "ok SKIP"), so both shapes are counted and
# held to the same allowlist.

# Extended regex, matched case-insensitively against the reason text. Keep it to
# things a CI runner can legitimately lack; every entry needs a reason here.
#   docker / RUN_SANDBOX_DOCKER_TEST  the containment gate has its own CI job
#   sandbox-exec / macOS-only         Seatbelt exists only on macOS
#   setpriv / running as root         root reads 0400 files; Linux-only drop tool
#   flock                             not shipped on macOS
#   the shellcheck binary             installed only on the Linux CI jobs (ci.yml),
#                                     which run every test that needs it
#   GAFFER_LIVE_ / real model calls   an opt-in live test (live-skill-use) that spends
#                                     real credits; CI never sets the opt-in
GAFFER_SKIP_ALLOWLIST_RE='docker|sandbox-exec|macos-only|setpriv|running as root|flock|shellcheck|GAFFER_LIVE_|real model calls'

gaffer_skip_allowed() {
  # A here-string, not a pipe: under a caller's pipefail an early-exiting grep can
  # SIGPIPE its producer and turn a match into a miss.
  grep -iqE -- "$GAFFER_SKIP_ALLOWLIST_RE" <<<"$1"
}

gaffer_skip() {
  echo "SKIP: $*"
  exit 77
}

GAFFER_SKIPS="${GAFFER_SKIPS:-0}"
gaffer_skip_part() {
  GAFFER_SKIPS=$((GAFFER_SKIPS + 1))
  echo "SKIP: $*"
}
