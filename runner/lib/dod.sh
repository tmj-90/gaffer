# Gaffer Definition-of-Done (DoD) gate — audit I3 (sourced by factory.config.sh).
# shellcheck shell=bash
#
# The single biggest "factory, not vibe" lever: a configurable, deterministically
# ENFORCED Definition of Done that every non-empty delivery must clear BEFORE the
# ticket may rest in the human review lane. The gates run in the RUNNER (never the
# trusted-to-the-agent path), in the delivery WORKTREE, each under gaffer_timeout.
#
#   ALL gates pass/skip  → the delivery proceeds (reaches in_review as today).
#   ANY gate FAILS       → the caller auto-rejects the delivery back to rework,
#                          recording the failing gate's name + an output tail as
#                          evidence. A human never spends time on a failed gate.
#
# This module is a PURE runner: it runs the configured commands and reports a
# structured verdict. It NEVER moves the ticket, records evidence, or mutates the
# board — that is tick.sh's policy (mirroring how hygiene.sh reports and tick.sh
# parks). Keeping it pure makes it testable in isolation against a real repo.
#
# Gates shipped (MVP): tests · typecheck · lint. A gate whose command is empty is
# SKIPPED (logged), never FAILED. DEFERRED follow-ups (documented, not built):
# coverage-did-not-decrease (needs a stored baseline), SAST/SCA (needs I2),
# CI-green (H3), docs-updated.

# Max wall-clock seconds for ONE gate command. Falls back to the per-tick timeout,
# then a sane default, so a runaway test/lint command can never burn unbounded
# wall-clock (denial-of-wallet). Always positive.
: "${GAFFER_DOD_TIMEOUT:=${GAFFER_TICK_TIMEOUT:-900}}"
# How many trailing lines of a failing gate's output to keep as evidence. Bounded
# so a chatty failure can't bloat the evidence row / the dashboard.
: "${GAFFER_DOD_OUTPUT_TAIL:=40}"

# True when DoD enforcement is ON for this run. GAFFER_DOD wins over config:
#   GAFFER_DOD=0  → OFF (today's behaviour: the gate never runs).
#   GAFFER_DOD=1  → ON.
#   unset         → ON (the runner enforces whenever commands are configured).
# A repo with no enabled gate that resolves to a command is a no-op regardless.
gaffer_dod_enabled() {
  case "${GAFFER_DOD:-1}" in
    0|false|off|no) return 1 ;;
    *) return 0 ;;
  esac
}

# Run ONE gate command in a worktree, bounded by gaffer_timeout. Writes the
# command's combined output to $2 (a file). Returns the command's exit status, or
# 124 on timeout, or 127 when the command could not even be spawned. NEVER throws
# under `set -e`/`set -u`: a gate that errors to spawn is a FAIL, not a crash.
#   gaffer_dod_run_one <worktree-dir> <output-file> <command-string>
gaffer_dod_run_one() {
  local wt="$1" outfile="$2" cmd="$3"
  : > "$outfile"
  # Run via `bash -c` (NOT a LOGIN shell) in a subshell pinned to the worktree so a
  # relative command (e.g. "pnpm test") resolves against the delivery, not the runner
  # cwd. stderr is folded into stdout so the evidence tail captures the real failure
  # message. FINDING B-M3: a LOGIN shell (`bash -lc`) sources the user's profile
  # (~/.bash_profile etc.), which re-admits nvm/rbenv PATH shims and profile-exported
  # credentials that gaffer_agent_env deliberately scrubbed — making the DoD gate
  # non-reproducible and re-leaking the ambient environment. `bash -c` runs the gate
  # in the scrubbed env the runner already established.
  ( cd "$wt" 2>/dev/null || exit 127
    gaffer_timeout "$GAFFER_DOD_TIMEOUT" bash -c "$cmd" ) >"$outfile" 2>&1
  return $?
}

# Run the enabled DoD gates across every write repo and emit a structured verdict.
#
# INPUT (stdin): one TAB-separated row per write repo —
#   label <TAB> worktree <TAB> tests_on <TAB> typecheck_on <TAB> lint_on \
#         <TAB> test_cmd <TAB> typecheck_cmd <TAB> lint_cmd
#   *_on is "1" (gate enabled) or "0" (gate disabled for this repo). A *_cmd field
#   that is empty OR the literal sentinel `-` means the gate is SKIPPED for that
#   repo (no command configured). The sentinel is REQUIRED for any empty command
#   field because TAB is IFS-whitespace: `read` collapses consecutive tabs, so an
#   empty middle field would silently shift the columns. Callers MUST pass `-`.
#
# ARGS:
#   $1 = a results file the caller reads back. Each gate writes ONE line:
#          GATE<TAB>name<TAB>repo<TAB>PASS|FAIL|SKIP<TAB>rc<TAB>note
#        and, for a FAIL, a captured output tail framed by:
#          ---DOD-OUTPUT name@repo---\n<tail>\n---END-DOD-OUTPUT---
#
# RETURNS: 0 when every gate passed or was skipped; 1 when ANY gate failed. Pure:
# moves/evidence/logging are the caller's job.
gaffer_run_dod_gates() {
  local results="$1"
  : > "$results"
  local any_fail=0
  local label wt tests_on tc_on lint_on test_cmd tc_cmd lint_cmd
  # Fail CLOSED if we can't even create a scratch file (e.g. disk full): record a
  # FAIL the caller will park on, rather than running gates against a bad outfile.
  local tmpout
  if ! tmpout="$(mktemp "${TMPDIR:-/tmp}/gaffer-dod.XXXXXX")"; then
    printf 'GATE\tconfig\t-\tFAIL\t1\tcould not create a temp file for gate output (mktemp failed)\n' >> "$results"
    return 1
  fi
  # Iterate gate definitions in a stable order so the evidence/board read the same
  # every run: tests, then typecheck, then lint.
  while IFS=$'\t' read -r label wt tests_on tc_on lint_on test_cmd tc_cmd lint_cmd; do
    [ -n "$wt" ] || continue
    local gate cmd on
    for gate in tests typecheck lint; do
      case "$gate" in
        tests)     on="$tests_on"; cmd="$test_cmd" ;;
        typecheck) on="$tc_on";    cmd="$tc_cmd" ;;
        lint)      on="$lint_on";  cmd="$lint_cmd" ;;
      esac
      # `-` is the explicit "no command" sentinel (see the INPUT contract).
      [ "$cmd" = "-" ] && cmd=""
      if [ "${on:-0}" != "1" ]; then
        # Gate disabled by config for this repo — record as skipped (disabled).
        printf 'GATE\t%s\t%s\tSKIP\t0\tgate disabled by config\n' "$gate" "$label" >> "$results"
        continue
      fi
      if [ -z "${cmd// /}" ]; then
        # Gate enabled but no command configured → SKIP (logged), never FAIL.
        printf 'GATE\t%s\t%s\tSKIP\t0\tno command configured\n' "$gate" "$label" >> "$results"
        continue
      fi
      gaffer_dod_run_one "$wt" "$tmpout" "$cmd"
      local rc=$?
      if [ "$rc" -eq 0 ]; then
        printf 'GATE\t%s\t%s\tPASS\t0\t%s\n' "$gate" "$label" "$cmd" >> "$results"
      else
        any_fail=1
        local note
        case "$rc" in
          124) note="timed out after ${GAFFER_DOD_TIMEOUT}s: $cmd" ;;
          127) note="command could not be run (spawn/exit 127): $cmd" ;;
          *)   note="exited $rc: $cmd" ;;
        esac
        printf 'GATE\t%s\t%s\tFAIL\t%s\t%s\n' "$gate" "$label" "$rc" "$note" >> "$results"
        # Capture the DISTILLED real failure (bounded) for the evidence row AND the
        # next attempt's feedback — the failing test name(s) + the assertion/error/
        # stack, NOT a blind tail of the whole log. Falls back to a plain tail when
        # the distiller finds no framework signal, so a failure is never lost.
        printf -- '---DOD-OUTPUT %s@%s---\n' "$gate" "$label" >> "$results"
        gaffer_dod_distill_output "$tmpout" "$GAFFER_DOD_OUTPUT_TAIL" >> "$results" 2>/dev/null \
          || tail -n "$GAFFER_DOD_OUTPUT_TAIL" "$tmpout" 2>/dev/null >> "$results" || true
        printf -- '\n---END-DOD-OUTPUT---\n' >> "$results"
      fi
    done
  done
  rm -f "$tmpout"
  [ "$any_fail" -eq 0 ]
}

# Render a one-line human summary of a results file (for the factory log).
#   gaffer_dod_summary_line <results-file>
gaffer_dod_summary_line() {
  local results="$1"
  awk -F'\t' '
    $1=="GATE" {
      total++
      if ($4=="PASS") pass++
      else if ($4=="FAIL") { fail++; failed = failed (failed?", ":"") $2 "@" $3 }
      else skip++
    }
    END {
      printf "%d gate(s): %d pass, %d skip, %d fail", total+0, pass+0, skip+0, fail+0
      if (fail>0) printf " (failed: %s)", failed
    }
  ' "$results" 2>/dev/null
}

# Count the gates that actually EXECUTED (PASS or FAIL) in a results file — i.e.
# the gates that produced a real signal, excluding SKIP rows. Prints an integer.
# Used to warn when a DoD run resolved to ALL-SKIP (zero executed gates): the run
# then "passes" vacuously, so a misconfigured repo (no test_command etc.) is not
# silently waved through (R1 LOW).
gaffer_dod_executed_count() {
  local results="$1"
  awk -F'\t' '$1=="GATE" && ($4=="PASS" || $4=="FAIL") { n++ } END { print n+0 }' \
    "$results" 2>/dev/null
}

# Build the compact evidence summary recorded on the ticket. First line is a
# machine-parseable JSON object the dashboard Review view parses into a checklist;
# the rest is a human-readable transcript (gate verdicts + any failing tails).
#   gaffer_dod_evidence_summary <results-file> <overall PASS|FAIL>
gaffer_dod_evidence_summary() {
  local results="$1" overall="$2"
  # JSON line: {"dod":"PASS|FAIL","gates":[{"gate","repo","status","rc","note"}...]}
  local out
  out="$(python3 - "$results" "$overall" <<'PY' 2>/dev/null
import sys, json
results, overall = sys.argv[1], sys.argv[2]
gates = []
lines = []
try:
    with open(results, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
except OSError:
    text = ""
for ln in text.splitlines():
    parts = ln.split("\t")
    if parts and parts[0] == "GATE" and len(parts) >= 6:
        _, gate, repo, status, rc, note = parts[:6]
        gates.append({"gate": gate, "repo": repo, "status": status, "rc": rc, "note": note})
        lines.append(f"  [{status}] {gate} ({repo}) — {note}")
# Keep the failing transcript blocks (bounded already by the writer) verbatim.
tail_blocks = []
keep = False
for ln in text.splitlines():
    if ln.startswith("---DOD-OUTPUT "):
        keep = True
        tail_blocks.append(ln)
    elif ln.startswith("---END-DOD-OUTPUT---"):
        tail_blocks.append(ln); keep = False
    elif keep:
        tail_blocks.append(ln)
payload = {"dod": overall, "gates": gates}
out = [f"DoD: {overall}", json.dumps(payload, separators=(",", ":"))]
out.append("")
out.extend(lines)
if tail_blocks:
    out.append("")
    out.extend(tail_blocks)
sys.stdout.write("\n".join(out))
PY
)"
  # Fallback if python3 is unavailable (or produced nothing): still emit the verdict
  # line + a built JSON object via awk + the raw results, so the evidence — and the
  # next attempt's feedback — is never totally lost. The dashboard parses the JSON
  # line either way.
  if [ -z "$out" ]; then
    local json
    json="$(awk -F'\t' -v OVERALL="$overall" '
      BEGIN { printf "{\"dod\":\"%s\",\"gates\":[", OVERALL }
      $1=="GATE" {
        if (n++) printf ","
        gsub(/\\/,"\\\\",$6); gsub(/"/,"\\\"",$6)
        printf "{\"gate\":\"%s\",\"repo\":\"%s\",\"status\":\"%s\",\"rc\":\"%s\",\"note\":\"%s\"}", $2,$3,$4,$5,$6
      }
      END { printf "]}" }
    ' "$results" 2>/dev/null)"
    out="$(printf 'DoD: %s\n%s\n\n%s' "$overall" "$json" "$(cat "$results" 2>/dev/null)")"
  fi
  printf '%s' "$out"
}

# How many lines of distilled failure to keep per gate. Bounded so a chatty stack
# can't bloat the evidence row / the feedback fed back to the next attempt.
: "${GAFFER_DOD_FEEDBACK_LINES:=${GAFFER_DOD_OUTPUT_TAIL:-40}}"

# gaffer_dod_distill_output <infile> [maxlines]
# Distil the ACTUAL failure from a gate command's raw output: the failing test
# name(s) + the assertion/error/stack lines — NOT a blind tail or the summary
# count line. Best-effort heuristics across vitest/jest, mvn/gradle, pytest and
# go test; when NO framework signal matches it falls back to the last non-blank
# lines so a failure is never lost. Prints at most <maxlines> lines (default
# GAFFER_DOD_FEEDBACK_LINES). Pure text-in/text-out — trivially testable.
gaffer_dod_distill_output() {
  local infile="$1" max="${2:-$GAFFER_DOD_FEEDBACK_LINES}"
  [ -f "$infile" ] || return 0
  awk -v MAX="${max:-40}" '
    # A line that carries real failure signal across the common stacks. Kept
    # deliberately broad (best-effort): a false positive just keeps one extra
    # line; a false negative is covered by the tail fallback below.
    function is_signal(s) {
      return (s ~ /--- FAIL:/ ||                              # go test
              s ~ /(^|[ \t])FAILED([ \t]|:|$)/ ||             # pytest / gradle
              s ~ /(^|[ \t])FAIL([ \t]|:|$)/ ||               # vitest / jest / go
              s ~ /[✕✗×]/ ||                                  # vitest / jest marks
              s ~ /(^|[ \t])● / ||                            # jest failing block
              s ~ /AssertionError|Assertion/ ||
              s ~ /[Ee]xpected|[Rr]eceived|but was|but got|actual:/ ||
              s ~ /[A-Za-z_.]*(Error|Exception)(:| |$)/ ||    # FooError: / Exception
              s ~ /panic:/ ||                                 # go
              s ~ /Traceback|(^|[ \t])E[ \t]/ ||              # pytest error lines
              s ~ /\[ERROR\]|<<< (FAILURE|ERROR)/ ||          # maven surefire
              s ~ /(^|[ \t])assert/ ||
              s ~ /:[0-9]+:[0-9]+|:[0-9]+\)/)                 # file:line stack refs
    }
    { line[NR]=$0; if (is_signal($0) && $0 !~ /^[ \t]*$/) { sig[NR]=1; nsig++ } }
    END {
      c=0
      if (nsig>0) {
        for (i=1;i<=NR && c<MAX;i++) if (sig[i]) { print line[i]; c++ }
      } else {
        start=NR-MAX+1; if (start<1) start=1
        for (i=start;i<=NR;i++) if (line[i] !~ /^[ \t]*$/) print line[i]
      }
    }
  ' "$infile" 2>/dev/null
}

# gaffer_dod_extract_failure <results-file>
# Pull the DISTILLED real-failure text back out of a results file's framed
# `---DOD-OUTPUT gate@repo--- … ---END-DOD-OUTPUT---` block(s) for feeding the
# NEXT rework attempt (the REVIEW FEEDBACK block). Each block is prefixed with the
# gate it came from. Prints nothing when the results carried no failing block.
gaffer_dod_extract_failure() {
  local results="$1"
  [ -f "$results" ] || return 0
  awk '
    /^---DOD-OUTPUT / { h=$0; sub(/^---DOD-OUTPUT /,"",h); sub(/---[ \t]*$/,"",h);
                        print "failing gate: " h; keep=1; next }
    /^---END-DOD-OUTPUT---/ { keep=0; next }
    keep && $0 !~ /^[ \t]*$/ { print "  " $0 }
  ' "$results" 2>/dev/null
}
