# Gaffer Definition-of-Done (DoD) gate — audit I3 (sourced by factory.config.sh).
# shellcheck shell=bash
# The typed CLIs live in packages/crew; factory.config.sh exports CREW_DIR, and a lib
# sourced standalone (tests, the gate replay) resolves the workspace default itself.
[ -n "${CREW_DIR:-}" ] || CREW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packages/crew" 2>/dev/null && pwd)"
_GAFFER_JSON_TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/json-tool.mjs"
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
# Gates shipped (MVP): tests · typecheck · lint. tests/lint run the repo's dispatch
# test_command/lint_command; typecheck runs GAFFER_DOD_TYPECHECK_CMD, else the
# command auto-detected from the repo's package.json (gaffer_dod_typecheck_cmd). A
# gate whose command is empty is SKIPPED (logged), never FAILED. DEFERRED follow-ups (documented, not built):
# coverage-did-not-decrease (needs a stored baseline), SAST/SCA (needs I2),
# CI-green (H3), docs-updated.

# Max wall-clock seconds for ONE gate command. Falls back to the per-tick timeout,
# then a sane default, so a runaway test/lint command can never burn unbounded
# wall-clock (denial-of-wallet). Always positive.
: "${GAFFER_DOD_TIMEOUT:=${GAFFER_TICK_TIMEOUT:-900}}"
# How many trailing lines of a failing gate's output to keep as evidence. Bounded
# so a chatty failure can't bloat the evidence row / the dashboard.
: "${GAFFER_DOD_OUTPUT_TAIL:=40}"

# Max wall-clock seconds for the PRE-GATE dependency install (see
# gaffer_dod_install_deps). Inherits the per-gate timeout, then the sane default,
# so a pathological install can never burn unbounded wall-clock. Always positive.
: "${GAFFER_DOD_INSTALL_TIMEOUT:=${GAFFER_DOD_TIMEOUT:-900}}"

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

# True when the PRE-GATE dependency install (gaffer_dod_install_deps) is ON.
#   GAFFER_DOD_INSTALL=0  → OFF (byte-identical to today: no pre-gate install).
#   GAFFER_DOD_INSTALL=1  → ON.
#   unset                 → ON.
# Default ON is safe-soft: the install is a strict no-op whenever node_modules
# already exists (the common case, since the worktree gets a node_modules symlink
# at setup) and never crashes a tick nor passes the gate — a failed/timed-out
# install leaves the DoD gate to run and fail loudly exactly as today. The
# existing "I manage deps myself" switch (GAFFER_GREENFIELD_INSTALL=0) also
# disables it, so operators keep ONE mental model rather than two competing knobs.
gaffer_dod_install_enabled() {
  case "${GAFFER_DOD_INSTALL:-1}" in
    0|false|off|no) return 1 ;;
    *)
      # Honour the existing greenfield opt-out so a single switch governs both
      # the greenfield prime and this pre-gate worktree install.
      [ "${GAFFER_GREENFIELD_INSTALL:-1}" = "0" ] && return 1
      return 0 ;;
  esac
}

# PRE-GATE ENABLER (not a gate). A fresh delivery worktree has no node_modules, so
# the DoD test gate cannot run — the first greenfield deliveries fail "tests could
# not run" until deps are present. This installs the worktree's dependencies IN THE
# WORKTREE, bounded + fail-soft, BEFORE the gate. It mirrors gaffer_ensure_node_modules
# (greenfield.sh) but (a) operates on the delivery worktree (never the primary
# checkout — the sandbox-safer seam), and (b) is BOUNDED by gaffer_timeout exactly
# like gaffer_dod_run_one, so a hung install cannot hang the tick.
#
# Package-manager detection (identical to greenfield.sh): pnpm-lock.yaml → pnpm;
# yarn.lock → yarn; package-lock.json | npm-shrinkwrap.json → npm; else skip (no
# deterministic install). --ignore-scripts so a dependency's postinstall/prepare
# cannot execute during the factory's own install (parity + safety).
#
# ALWAYS returns 0 (never throws under set -e / set -u). Echoes:
#   <pm>                 → install succeeded (node_modules materialised)
#   FAILED:<pm>          → install ATTEMPTED but failed (diagnostic on stderr)
#   FAILED:timeout:<pm>  → install TIMED OUT (gaffer_timeout returned 124)
#   (empty)              → no-op (non-node repo, no lockfile, deps already present,
#                          or the pm binary is unavailable)
#   gaffer_dod_install_deps <worktree-dir>
gaffer_dod_install_deps() {
  local dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  [ -f "$dir/package.json" ] || return 0        # non-node repo → skip
  # Deps "present" = node_modules exists AND is non-empty (a dir, or a symlink to a
  # non-empty shared install). An EMPTY node_modules — the primary's install wiped by
  # an agent's `npm ci` through the worktree symlink — must install, or the gate fails
  # "cannot find package" for a reason that has nothing to do with the code.
  if [ -e "$dir/node_modules" ] && [ -n "$(ls -A "$dir/node_modules/" 2>/dev/null)" ]; then
    return 0                                     # deps already present → no-op
  fi

  local pm=""
  if [ -f "$dir/pnpm-lock.yaml" ]; then
    pm="pnpm"
  elif [ -f "$dir/yarn.lock" ]; then
    pm="yarn"
  elif [ -f "$dir/package-lock.json" ] || [ -f "$dir/npm-shrinkwrap.json" ]; then
    pm="npm"
  else
    return 0 # no lockfile → not a deterministic install; leave it for the gate
  fi
  command -v "$pm" >/dev/null 2>&1 || return 0   # pm binary unavailable → skip

  # The frozen/CI install (respects the lockfile) with a plain-install fallback for
  # a lockfile that is out of sync — the SAME commands greenfield.sh already uses.
  # Both arms live INSIDE one gaffer_timeout so the fallback stays bounded too.
  # gaffer_timeout CANNOT wrap a shell function (it exec's @ARGV), so the timeout
  # wraps the external pnpm/npm/yarn here, mirroring gaffer_dod_run_one's shape.
  local _script=""
  case "$pm" in
    pnpm) _script='pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts' ;;
    yarn) _script='yarn install --frozen-lockfile --ignore-scripts || yarn install --ignore-scripts' ;;
    npm)  _script='npm ci --ignore-scripts || npm install --ignore-scripts' ;;
  esac

  local _out _rc
  _out="$(mktemp "${TMPDIR:-/tmp}/gaffer-dod-install.XXXXXX")" || _out="/dev/null"
  # stdin from /dev/null: the caller loops over its worktree rows on stdin, and an
  # install that reads stdin would swallow the rows for the repos after this one.
  ( cd "$dir" 2>/dev/null || exit 127
    gaffer_timeout "$GAFFER_DOD_INSTALL_TIMEOUT" bash -c "$_script" ) </dev/null >"$_out" 2>&1
  _rc=$?

  # Fail-soft verdict. Success = node_modules materialised → echo the pm for the
  # caller's log. Otherwise the install was ATTEMPTED but failed: surface the
  # captured reason on stderr (never destroyed → not an opaque "cannot find module"
  # at the gate) and echo a FAILED sentinel so the caller logs an accurate,
  # ticket-scoped warning. gaffer_timeout returns 124 on timeout → distinct sentinel.
  if [ -e "$dir/node_modules" ]; then
    echo "$pm"
  else
    printf 'gaffer: dod-install: %s install did not prime deps in %s (non-fatal; the test gate will surface it):\n' \
      "$pm" "$dir" >&2
    tail -n "${GAFFER_DOD_OUTPUT_TAIL:-40}" "$_out" 2>/dev/null | sed 's/^/  /' >&2
    if [ "$_rc" -eq 124 ]; then
      echo "FAILED:timeout:$pm"
    else
      echo "FAILED:$pm"
    fi
  fi
  [ "$_out" = "/dev/null" ] || rm -f "$_out"
  return 0
}

# The typecheck gate's command for ONE write repo: GAFFER_DOD_TYPECHECK_CMD when set
# (an operator override applied to every repo), else the command AUTO-DETECTED from
# the repo's package.json (a typecheck / type-check / check-types / types:check
# script, or a bare `tsc --noEmit` script; json-tool dod-typecheck-detect), read
# from the BASE branch first so a delivery cannot drop the gate by deleting the
# script. Echoes "" when there is neither (the gate is then SKIPPED, as before).
#   gaffer_dod_typecheck_cmd <worktree> [base-ref]
gaffer_dod_typecheck_cmd() {
  local wt="$1" base="${2:-}"
  if [ -n "${GAFFER_DOD_TYPECHECK_CMD:-}" ] && [ -n "${GAFFER_DOD_TYPECHECK_CMD// /}" ]; then
    printf '%s\n' "$GAFFER_DOD_TYPECHECK_CMD"; return 0
  fi
  node "$_GAFFER_JSON_TOOL" dod-typecheck-detect "$wt" "$base" 2>/dev/null || true
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
  # VALIDATION ISOLATION: GAFFER_DOD_WRAP (exported by tick.sh when an OS sandbox
  # provider wraps the agent — `sandbox-exec -f <profile>` or the docker wrapper
  # prefix) runs the gate command inside the SAME containment the agent had, with the
  # same write roots. The gate executes agent-modified code (test files, imports,
  # config); before this it ran bare with the runner's privileges. The verdict is still
  # read and recorded HERE, outside the gate process. Empty ⇒ the pre-existing bare
  # invocation, byte-for-byte. Word-split deliberately: the wrap is a command prefix.
  # Under the docker provider the image's own PATH/HOME must apply (the host's do not
  # exist inside) — mirrors lib/worker.sh's substitution for the agent spawn.
  local _wrap="${GAFFER_DOD_WRAP:-}" _env=() _profile=()
  if [ -n "$_wrap" ]; then
    # VALIDATION PROFILE (explicit, independent of the agent bridge's lifetime): the
    # wrapper mounts NO data plane (no databases, no ledgers, no bridge socket — the
    # agent's bridge is gone by now and must not be inferred) and forwards NO model
    # credential. A gate never needs either. Set as env for the wrapper process itself.
    _profile=( env GAFFER_SANDBOX_PROFILE=validation GAFFER_MCP_BRIDGE_SOCKET= GAFFER_SANDBOX_DATA_PLANE=none )
  fi
  if [ -n "$_wrap" ] && [ "${SANDBOX_PROVIDER:-sandbox-exec}" = "docker" ]; then
    _env=( env "HOME=${GAFFER_SANDBOX_HOME:-/root}"
               "PATH=${GAFFER_SANDBOX_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" )
  fi
  # STDIN FROM /dev/null: both callers (gaffer_run_dod_gates, gaffer_run_ac_checks)
  # read their gate rows from stdin. A gate that reads stdin (a Django test-DB prompt,
  # `docker run -i`, ssh, a script using `read`) used to inherit it and swallow the
  # remaining rows, so later repos' gates and later ACs never ran and the gate PASSED.
  # shellcheck disable=SC2086  # $_wrap is a command prefix, split on purpose
  ( cd "$wt" 2>/dev/null || exit 127
    gaffer_timeout "$GAFFER_DOD_TIMEOUT" ${_profile[@]+"${_profile[@]}"} $_wrap ${_env[@]+"${_env[@]}"} bash -c "$cmd" ) </dev/null >"$outfile" 2>&1
  return $?
}

# Run the enabled DoD gates across every write repo and emit a structured verdict.
#
# INPUT (stdin): one TAB-separated row per write repo —
#   label <TAB> worktree <TAB> tests_on <TAB> typecheck_on <TAB> lint_on \
#         <TAB> test_cmd <TAB> typecheck_cmd <TAB> lint_cmd [<TAB> base_ref <TAB> allow]
#   *_on is "1" (gate enabled) or "0" (gate disabled for this repo). A *_cmd field
#   that is empty OR the literal sentinel `-` means the gate is SKIPPED for that
#   repo (no command configured). The sentinel is REQUIRED for any empty command
#   field because TAB is IFS-whitespace: `read` collapses consecutive tabs, so an
#   empty middle field would silently shift the columns. Callers MUST pass `-`.
#   GATE INTEGRITY (optional trailing fields; absent ⇒ today's behaviour exactly):
#   base_ref is the COMMIT the delivery was cut from (a full SHA, recorded by tick.sh
#   when it created the worktree — see gaffer_delivery_base_sha), or for older callers
#   a branch name, whose merge-base with HEAD is used (`-` = none); allow is "1"
#   when a human set allow_test_changes on the ticket. With a base_ref, each gate's
#   package.json script is read from the BASE commit (gaffer_dod_resolve_cmd), and an
#   `integrity` row is appended per repo (gaffer_dod_integrity_row): PASS or FLAG,
#   never FAIL.
#
# ARGS:
#   $1 = a results file the caller reads back. Each gate writes ONE line:
#          GATE<TAB>name<TAB>repo<TAB>PASS|FAIL|SKIP|FLAG<TAB>rc<TAB>note[<TAB>source]
#        (source: where the command's behaviour was read from — see
#        gaffer_dod_resolve_cmd; FLAG only on the integrity row) and, for a FAIL, a
#        captured output tail framed by:
#          ---DOD-OUTPUT name@repo---\n<tail>\n---END-DOD-OUTPUT---
#
# RETURNS: 0 when every gate passed or was skipped; 1 when ANY gate failed. Pure:
# moves/evidence/logging are the caller's job.
gaffer_run_dod_gates() {
  local results="$1"
  : > "$results"
  local any_fail=0
  local label wt tests_on tc_on lint_on test_cmd tc_cmd lint_cmd base allow
  # Fail CLOSED if we can't even create a scratch file (e.g. disk full): record a
  # FAIL the caller will park on, rather than running gates against a bad outfile.
  local tmpout
  if ! tmpout="$(mktemp "${TMPDIR:-/tmp}/gaffer-dod.XXXXXX")"; then
    printf 'GATE\tconfig\t-\tFAIL\t1\tcould not create a temp file for gate output (mktemp failed)\n' >> "$results"
    return 1
  fi
  # Iterate gate definitions in a stable order so the evidence/board read the same
  # every run: tests, then typecheck, then lint.
  while IFS=$'\t' read -r label wt tests_on tc_on lint_on test_cmd tc_cmd lint_cmd base allow; do
    [ -n "$wt" ] || continue
    local gate cmd on run_cmd src _mb=""
    [ "$base" = "-" ] && base=""
    # GATE INTEGRITY: the commit the delivery branched from. Empty when there is no
    # base ref (callers that predate the check) or it cannot be resolved — then the
    # commands run as registered and the integrity row FLAGs the unresolved base.
    # A recorded SHA is used AS IS: a branch name can be moved by the agent from inside
    # its worktree (`git branch -f main HEAD`), and a merge-base taken from the moved
    # branch would hide every commit made before the move.
    if [ -n "$base" ]; then
      if [[ "$base" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
        git -C "$wt" cat-file -e "$base^{commit}" 2>/dev/null && _mb="$base"
      else
        _mb="$(git -C "$wt" merge-base "$base" HEAD 2>/dev/null)" || _mb=""
      fi
    fi
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
      # Read the command's package.json script from the BASE commit (never the
      # worktree's head) when a base is known, so a delivery that rewrites
      # `scripts.test` cannot redirect its own gate. Without a base: today's command.
      run_cmd="$cmd"; src=""
      if [ -n "$base" ]; then
        gaffer_dod_resolve_cmd "$wt" "$_mb" "$cmd"
        run_cmd="$_GAFFER_DOD_RUN_CMD"; src="$_GAFFER_DOD_SOURCE"
      fi
      gaffer_dod_run_one "$wt" "$tmpout" "$run_cmd"
      local rc=$?
      if [ "$rc" -eq 0 ]; then
        printf 'GATE\t%s\t%s\tPASS\t0\t%s%s\n' "$gate" "$label" "$cmd" "${src:+$'\t'$src}" >> "$results"
      else
        any_fail=1
        local note
        case "$rc" in
          124) note="timed out after ${GAFFER_DOD_TIMEOUT}s: $cmd" ;;
          127) note="command could not be run (spawn/exit 127): $cmd" ;;
          *)   note="exited $rc: $cmd" ;;
        esac
        printf 'GATE\t%s\t%s\tFAIL\t%s\t%s%s\n' "$gate" "$label" "$rc" "$note" "${src:+$'\t'$src}" >> "$results"
        # Capture the DISTILLED real failure (bounded) for the evidence row AND the
        # next attempt's feedback — the failing test name(s) + the assertion/error/
        # stack, NOT a blind tail of the whole log. Falls back to a plain tail when
        # the distiller cannot run, errors or prints nothing, so a failure is never lost.
        printf -- '---DOD-OUTPUT %s@%s---\n' "$gate" "$label" >> "$results"
        gaffer_dod_distill_output "$tmpout" "$GAFFER_DOD_OUTPUT_TAIL" >> "$results" 2>/dev/null \
          || tail -n "$GAFFER_DOD_OUTPUT_TAIL" "$tmpout" 2>/dev/null >> "$results" || true
        printf -- '\n---END-DOD-OUTPUT---\n' >> "$results"
      fi
    done
    # GATE INTEGRITY row for this repo (PASS / FLAG — never FAIL, never any_fail).
    if [ -n "$base" ]; then
      gaffer_dod_integrity_row "$wt" "$_mb" "$label" "${allow:-0}" "$test_cmd" "$tc_cmd" "$lint_cmd" >> "$results"
    fi
  done
  rm -f "$tmpout"
  [ "$any_fail" -eq 0 ]
}

# GATE INTEGRITY: the commit a delivery branch was cut from — what the DoD rows pass as
# base_ref and what tick.sh records on the repo delivery (`--base-sha`) for dispatch's
# server-side scan. Computed by the RUNNER before the agent runs, so the agent cannot
# choose it by moving the base branch:
#   created=1 (this tick cut the branch with `worktree add -B` off the base): the
#     branch's start point, i.e. its tip right after creation;
#   otherwise (a kept/resumed branch): the SHA recorded when it was first cut, when it
#     is still a commit in the repo; else the merge-base of base and branch now.
# Prints a full SHA, or nothing (then the integrity row FLAGs an unresolved base).
#   gaffer_delivery_base_sha <repo> <base-branch> <work-branch> <created:0|1> [stored-sha]
gaffer_delivery_base_sha() {
  local repo="$1" base="$2" work="$3" created="$4" stored="${5:-}" sha=""
  if [ "$created" = "1" ]; then
    sha="$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$work^{commit}" 2>/dev/null)" || sha=""
  elif [[ "$stored" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] \
       && git -C "$repo" cat-file -e "$stored^{commit}" 2>/dev/null; then
    sha="$stored"
  else
    sha="$(git -C "$repo" merge-base "$base" "refs/heads/$work" 2>/dev/null)" || sha=""
  fi
  [[ "$sha" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] && printf '%s\n' "$sha"
  return 0
}

# The typed gate-integrity seam (packages/crew runtime/dod/gateIntegrityCli.js), which
# runs dispatch's one classifier — the same one behind the server-side `test-modified`
# risk annotation.
_gaffer_gate_integrity_cli() { printf '%s' "${CREW_DIR:-}/dist/runtime/dod/gateIntegrityCli.js"; }

# GATE INTEGRITY, part 1: resolve a gate command against the BASE commit's package.json.
# Sets two globals (a subshell would lose them):
#   _GAFFER_DOD_RUN_CMD  the command to execute — the registered one, or, when the
#                        delivery changed/removed the script it names, the base
#                        commit's script body (so editing package.json cannot
#                        redirect the gate)
#   _GAFFER_DOD_SOURCE   "<source>: <note>" for the evidence — registered | base |
#                        base-pinned | head | unresolved
# Never fails: with no base commit or no crew dist the registered command runs
# (today's behaviour) and the source says why; the integrity row flags the same.
#   gaffer_dod_resolve_cmd <worktree> <base-commit> <command>
gaffer_dod_resolve_cmd() {
  local wt="$1" mb="$2" cmd="$3" cli _line _src _note _run
  _GAFFER_DOD_RUN_CMD="$cmd"
  cli="$(_gaffer_gate_integrity_cli)"
  if [ -z "$mb" ]; then
    _GAFFER_DOD_SOURCE="unresolved: no base commit found; ran the registered command against the delivery's scripts"
    return 0
  fi
  if [ ! -f "$cli" ]; then
    _GAFFER_DOD_SOURCE="unresolved: gate-integrity resolver unavailable (crew dist missing); ran the registered command"
    return 0
  fi
  _line="$(node "$cli" resolve --worktree "$wt" --base "$mb" --cmd "$cmd" 2>/dev/null </dev/null | head -n 1)"
  IFS=$'\t' read -r _src _note _run <<< "$_line"
  if [ -z "$_src" ] || [ -z "${_run// /}" ]; then
    _GAFFER_DOD_SOURCE="unresolved: gate-integrity resolver gave no answer; ran the registered command"
    return 0
  fi
  _GAFFER_DOD_RUN_CMD="$_run"
  _GAFFER_DOD_SOURCE="$_src: $_note"
  return 0
}

# GATE INTEGRITY, part 2: print ONE results row for a repo:
#   GATE<TAB>integrity<TAB>repo<TAB>PASS|FLAG<TAB>0<TAB>reason<TAB>source
# FLAG when base..worktree deleted or renamed a test file, added a skip/only marker,
# changed or removed a gate script, or touched test-runner config — or when the scan
# could not run (no base, no crew dist): it fails toward a human, never toward a pass.
# allow=1 (a human set allow_test_changes) turns a FLAG into PASS with a note. This
# row never FAILs a delivery in this slice; dispatch's `test-modified` risk annotation
# (same classifier, computed server-side) is what holds an auto-approve.
#   gaffer_dod_integrity_row <worktree> <base-commit> <label> <allow> <cmd>...
gaffer_dod_integrity_row() {
  local wt="$1" mb="$2" label="$3" allow="$4" cli _row c
  shift 4
  local _args=()
  for c in "$@"; do
    [ -n "$c" ] && [ "$c" != "-" ] && _args+=(--cmd "$c")
  done
  cli="$(_gaffer_gate_integrity_cli)"
  if [ -z "$mb" ]; then
    printf 'GATE\tintegrity\t%s\tFLAG\t0\tcould not resolve the base commit, so test changes could not be checked\tunresolved\n' "$label"
    return 0
  fi
  if [ ! -f "$cli" ]; then
    printf 'GATE\tintegrity\t%s\tFLAG\t0\tthe integrity scan could not run (crew dist missing)\tunresolved\n' "$label"
    return 0
  fi
  _row="$(node "$cli" scan --worktree "$wt" --base "$mb" --label "$label" --allow "$allow" \
    ${_args[@]+"${_args[@]}"} 2>/dev/null </dev/null | head -n 1)"
  case "$_row" in
    "GATE	integrity	"*) printf '%s\n' "$_row" ;;
    *) printf 'GATE\tintegrity\t%s\tFLAG\t0\tthe integrity scan gave no answer\tunresolved\n' "$label" ;;
  esac
  return 0
}

# Render a one-line human summary of a results file (for the factory log).
#   gaffer_dod_summary_line <results-file>
gaffer_dod_summary_line() {
  local results="$1"
  # Typed (packages/crew dodDistillCli.js summarizeGates); pinned by dod-distill-golden.
  # A log line, never a gate: without the crew dist it prints nothing and returns 0.
  [ -f "${CREW_DIR:-}/dist/runtime/dod/dodDistillCli.js" ] || return 0
  node "${CREW_DIR}/dist/runtime/dod/dodDistillCli.js" summary --in "$results" 2>/dev/null || return 0
  return 0
}

# Count the gates that actually EXECUTED (PASS or FAIL) in a results file — i.e.
# the gates that produced a real signal, excluding SKIP rows. Prints an integer.
# Used to warn when a DoD run resolved to ALL-SKIP (zero executed gates): the run
# then "passes" vacuously, so a misconfigured repo (no test_command etc.) is not
# silently waved through (R1 LOW).
gaffer_dod_executed_count() {
  local results="$1"
  # Typed (packages/crew dodDistillCli.js executedCount); pinned by dod-distill-golden.
  # FAIL CLOSED: when the CLI cannot run the count is 0 — tick.sh then refuses the
  # delivery as "zero gates executed" (unless GAFFER_ALLOW_NO_DOD=1), so a missing
  # crew dist can only make the DoD stricter, never wave a delivery through.
  [ -f "${CREW_DIR:-}/dist/runtime/dod/dodDistillCli.js" ] || { echo 0; return 0; }
  node "${CREW_DIR}/dist/runtime/dod/dodDistillCli.js" executed-count --in "$results" 2>/dev/null || echo 0
  return 0
}

# Build the compact evidence summary recorded on the ticket. First line is a
# machine-parseable JSON object the dashboard Review view parses into a checklist;
# the rest is a human-readable transcript (gate verdicts + any failing tails).
#   gaffer_dod_evidence_summary <results-file> <overall PASS|FAIL>
gaffer_dod_evidence_summary() {
  local results="$1" overall="$2"
  # JSON line: {"dod":"PASS|FAIL","gates":[{"gate","repo","status","rc","note"}...]}
  local out
  out="$(node "$_GAFFER_JSON_TOOL" dod-evidence-summary "$results" "$overall" 2>/dev/null)"
  # Fallback if the node render produced nothing: still emit the verdict
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
# Returns 1 (printing NOTHING) when the distiller cannot run, errors or prints
# nothing, so the callers' `|| tail …` fallback runs and a failure is never lost.
gaffer_dod_distill_output() {
  local infile="$1" max="${2:-$GAFFER_DOD_FEEDBACK_LINES}"
  [ -f "$infile" ] || return 1
  # Typed (packages/crew dodDistillCli.js distillOutput): the failing test name(s) +
  # assertion/error/stack, not a blind tail. Pinned by dod-distill-golden. Captured
  # BEFORE printing so a crash halfway through never leaves half-distilled text
  # followed by the caller's tail.
  [ -f "${CREW_DIR:-}/dist/runtime/dod/dodDistillCli.js" ] || return 1
  local _o
  _o="$(node "${CREW_DIR}/dist/runtime/dod/dodDistillCli.js" distill \
    --in "$infile" --max "${max:-40}" 2>/dev/null)" || return 1
  [ -n "$_o" ] || return 1
  printf '%s\n' "$_o"
}

# gaffer_dod_extract_failure <results-file>
# Pull the DISTILLED real-failure text back out of a results file's framed
# `---DOD-OUTPUT gate@repo--- … ---END-DOD-OUTPUT---` block(s) for feeding the
# NEXT rework attempt (the REVIEW FEEDBACK block). Each block is prefixed with the
# gate it came from. Prints nothing when the results carried no failing block.
gaffer_dod_extract_failure() {
  local results="$1"
  [ -f "$results" ] || return 0
  # Typed (packages/crew dodDistillCli.js extractFailure); pinned by dod-distill-golden.
  # Feedback only, but feedback the next attempt depends on: when the crew dist is
  # missing or the CLI errors, the awk below emits the same shape ("failing gate:
  # g@r" + two-space-indented body lines) so the rework prompt never goes out empty.
  local _o
  if [ -f "${CREW_DIR:-}/dist/runtime/dod/dodDistillCli.js" ] \
     && _o="$(node "${CREW_DIR}/dist/runtime/dod/dodDistillCli.js" extract --in "$results" 2>/dev/null)"; then
    [ -n "$_o" ] && printf '%s\n' "$_o"
    return 0
  fi
  awk '
    /^---DOD-OUTPUT / { h = $0; sub(/^---DOD-OUTPUT /, "", h); sub(/---[ \t]*$/, "", h); print "failing gate: " h; keep = 1; next }
    /^---END-DOD-OUTPUT---/ { keep = 0; next }
    keep && !/^[ \t]*$/ { print "  " $0 }
  ' "$results" 2>/dev/null
  return 0
}

# GATE INTEGRITY: log each integrity row of a results file — a FLAG as a WARNING the
# operator sees in the factory log (the evidence row and the Review banner carry it
# too). Uses tick.sh's `log` when defined, else stderr. Never fails.
#   gaffer_dod_log_integrity <results-file>
gaffer_dod_log_integrity() {
  local results="$1" _g _name _repo _st _rc _note _src _msg
  [ -f "$results" ] || return 0
  while IFS=$'\t' read -r _g _name _repo _st _rc _note _src; do
    [ "$_g" = "GATE" ] && [ "$_name" = "integrity" ] || continue
    case "$_st" in
      FLAG) _msg="DoD: integrity FLAG for ${NUM:+#$NUM }($_repo) — $_note; a human must look before this ships (dispatch holds auto-approve; \`wg ticket allow-test-changes\` if intended)" ;;
      *)    _msg="DoD: integrity $_st for ${NUM:+#$NUM }($_repo) — $_note" ;;
    esac
    if declare -F log >/dev/null 2>&1; then log "$_msg"; else printf '%s\n' "$_msg" >&2; fi
  done < "$results"
  return 0
}
