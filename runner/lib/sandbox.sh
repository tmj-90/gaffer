# Gaffer strict-execution-mode provider seam (sourced by factory.config.sh).
# shellcheck shell=bash
#
# WHAT THIS IS — and IS NOT
# -------------------------
# This is best-effort OS-level containment, REQUIRED by default for every agent
# launch (GAFFER_STRICT_REQUIRE=0 in the environment opts out), layered ON TOP OF the
# existing two safety pillars (throwaway git worktree isolation + the
# deterministic PreToolUse safety hook). It is NOT a security sandbox and NOT a
# guarantee. Its single job: catch writes the agent makes OUTSIDE the worktree
# that the in-process safety hook cannot see (e.g. a dynamically-constructed
# path inside a `python3 -c …` the hook allowed, an exec'd child process, a
# library that writes via a syscall path the hook never inspected). The OS, not
# our shell, refuses those writes.
#
# PROVIDER ABSTRACTION (the load-bearing design constraint)
# ---------------------------------------------------------
# The system is built around a PROVIDER SEAM, NOT around `sandbox-exec`.
# `sandbox-exec` is ONE provider (the one a spike proved on macOS today). Docker,
# Lima, and full VMs are future providers with stronger (and different)
# guarantees — notably true per-subprocess network isolation, which `sandbox-exec`
# wrapping the WHOLE `claude -p` process fundamentally cannot offer (see the
# network caveat in factory.config.sh). To add a provider you add ONE `case`
# branch below and nothing else changes: tick.sh, the config, and the profile
# generator all dispatch through `sandbox_wrap_cmd`.
#
# CONTRACT
# --------
#   sandbox_wrap_cmd <write-roots> <read-roots>
#     • write-roots / read-roots: newline-separated absolute paths (the SAME
#       lists tick.sh already computes for the safety hook). read-roots are
#       accepted for symmetry / future providers; the sandbox-exec provider
#       reads broadly, so it needs no per-read rule.
#     • ECHOES a command PREFIX to stdout (possibly empty) that the caller
#       prepends to the `claude -p …` invocation. Empty prefix == no wrapping.
#     • Diagnostics go to STDERR so they never pollute the echoed prefix.
#     • Returns NON-ZERO when the host cannot supply the provider and the sandbox is
#       required, which is the default: the caller then does not launch (fail
#       closed). Only under the operator's GAFFER_STRICT_REQUIRE=0 opt-out does an
#       unsupported provider return 0 and degrade to "no extra containment, the
#       worktree isolation + safety hook still apply".

# Resolve a path to its canonical (symlink-free) form. macOS aliases /tmp and
# /var to /private/*, so the literal path the agent uses and the path the kernel
# enforces can differ; sandbox-exec matches on the canonical path. We canonicalise
# every subpath we emit so an allow-rule actually covers what the agent writes.
# A directory resolves in this shell (`cd && pwd -P`). A path that does not exist yet (a
# worktree created after this runs, the replay variant's HOME secrets, most of which a
# host does not have) resolves through its nearest existing parent with the rest
# appended. Only a symlinked FILE needs node's realpath: a node start per path cost the
# replay profile (16 such paths) seconds on a loaded macOS runner, every replay.
_sandbox_realpath() {
  local p="$1" head rest="" d
  if [ -d "$p" ]; then
    ( cd "$p" 2>/dev/null && pwd -P ) && return 0
  elif [ -L "$p" ]; then
    node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$p" 2>/dev/null && return 0
    printf '%s' "$p"; return 0
  fi
  case "$p" in /*) ;; *) printf '%s' "$p"; return 0 ;; esac
  head="${p%/}"
  while [ -n "$head" ] && [ ! -d "$head" ]; do
    rest="/${head##*/}$rest"; head="${head%/*}"
  done
  d="$( cd "${head:-/}" 2>/dev/null && pwd -P )" || { printf '%s' "$p"; return 0; }
  [ "$d" = / ] && d=""
  printf '%s' "$d$rest"
}

# Emit a single SBPL `(subpath "…")` line for a path, canonicalised + escaped.
# Skips empties. Escapes backslash and double-quote for SBPL string literals.
_sandbox_subpath_rule() {
  local p="$1"
  [ -n "$(printf '%s' "$p" | tr -d '[:space:]')" ] || return 0
  local real esc
  real="$(_sandbox_realpath "$p")"
  [ -n "$real" ] || return 0
  esc="$(printf '%s' "$real" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  printf '  (subpath "%s")\n' "$esc"
}

# Emit a single SBPL `(literal "...")` line for a path, canonicalised + escaped.
_sandbox_literal_rule() {
  local p="$1"
  [ -n "$(printf '%s' "$p" | tr -d '[:space:]')" ] || return 0
  local real esc
  real="$(_sandbox_realpath "$p")"
  [ -n "$real" ] || return 0
  esc="$(printf '%s' "$real" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  printf '  (literal "%s")\n' "$esc"
}

# A canonical path made safe as the start of an SBPL regex: every regex metacharacter
# escaped. A path holding a double quote or a line break cannot be written into a
# #"..." literal faithfully: the caller must refuse the profile (fail closed).
#   _sandbox_regex_prefix <path> → the escaped canonical path, or rc 1
_sandbox_regex_prefix() {
  local real
  real="$(_sandbox_realpath "$1")"
  [ -n "$real" ] || return 1
  case "$real" in *'"'* | *$'\n'*) return 1 ;; esac
  printf '%s' "$real" | sed -e 's/[][\\.*^$+?(){}|]/\\&/g'
}

# An escaped regex fragment made case-insensitive: each ASCII letter becomes a two-letter
# bracket ([cC]); an escape (a backslash and the character after it) is kept as it is.
# WHY: macOS volumes are case-insensitive by default, and a path the kernel checks for a
# file being CREATED is the path as typed (no vnode exists yet). A case-sensitive deny
# for ~/.claude/CLAUDE.md does not match ~/.claude/CLAUDE.MD, the grant on ~/.claude
# allows it, and the CLI later opens CLAUDE.md and finds the planted file. Letters the
# volume folds from non-ASCII characters (U+017F for s, U+212A for k, ligatures) are
# handled by a separate non-ASCII deny (_sandbox_exec_agent_config_rules).
#   _sandbox_regex_ci <escaped fragment>  → the case-insensitive fragment
_sandbox_regex_ci() {
  local in="$1" lc uc out="" i=0 n c l u
  lc="$(printf '%s' "$in" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')"
  uc="$(printf '%s' "$in" | tr 'abcdefghijklmnopqrstuvwxyz' 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')"
  n=${#in}
  while [ "$i" -lt "$n" ]; do
    c="${in:$i:1}"
    if [ "$c" = "\\" ]; then
      out="$out$c${in:$((i + 1)):1}"
      i=$((i + 2))
      continue
    fi
    l="${lc:$i:1}"; u="${uc:$i:1}"
    if [ "$l" != "$u" ]; then out="${out}[${l}${u}]"; else out="$out$c"; fi
    i=$((i + 1))
  done
  printf '%s' "$out"
}

# Literal rules for every ancestor of a path (canonical), "/" excluded. A literal rule
# matches the directory itself only, never what is inside it: denying writes to the
# ancestors stops a rename (or removal) of a parent that would swap in a whole new
# directory under a denied path, while files can still be created inside them.
_sandbox_ancestor_rules() {
  local real head
  real="$(_sandbox_realpath "$1")"
  case "$real" in /?*) ;; *) return 0 ;; esac
  head="${real%/*}"
  while [ -n "$head" ]; do
    _sandbox_literal_rule "$head"
    head="${head%/*}"
  done
}

# ── sandbox-exec provider: generate an SBPL profile ──────────────────────────
# SBPL is LAST-MATCH-WINS, so the order is deliberate:
#   1. (allow default)        → reads (and everything) broadly permitted
#   2. (deny file-write*)     → revoke ALL writes
#   3. (allow file-write* …)  → re-grant writes to the write roots (worktrees), the temp
#                               dirs, each $STRICT_ALLOW_HOME entry (the agent variant
#                               only) and the std streams
#   4. $GAFFER_DATA           → every write under it denied again (a temp-dir or HOME grant
#                               that contains it included), its ancestors too (no rename of
#                               a parent swaps the directory), then re-granted: the write
#                               roots that live under it and, for the agent variant only,
#                               the files the in-sandbox MCP servers and the safety hook
#                               write (gaffer_sandbox_data_writers: the dispatch and memory
#                               databases with their -wal/-shm/-journal files, the crew
#                               events log, the hook's two ledgers). The same keep list as
#                               the docker provider's legacy layout (lib/sandbox-docker.sh),
#                               pinned by runner/test/sandbox-exec-data-plane.test.sh.
#   5. control-file denies    → settings.json and its temp siblings, the usage pause and
#                               ledgers, the runner's state files and dirs, the generated
#                               profiles and MCP configs, the agent ids (defence in depth
#                               for a write root that contains $GAFFER_DATA)
#   6. agent CLI config       → ~/.claude settings*.json, CLAUDE.md, hooks/, agents/, ... and
#                               ~/.claude.json: a planted user setting or hook would run in
#                               every later agent and in the operator's own CLI
#   7. factory key, REST token and acceptance signing key (read and write)
# process-exec + network are allowed (network gated on $STRICT_ALLOW_NETWORK). READ-roots
# need no rule: reads are broadly allowed by (allow default).
# Who writes what under $GAFFER_DATA, and who trusts it: the table in docs/sandbox.md.
#
# THREE VARIANTS (GAFFER_SANDBOX_PROFILE):
#   (unset/other) the AGENT profile above.
#   validation    the gates (DoD tests/typecheck/lint, acceptance checks, the merge gate,
#                 the pre-gate install): agent-modified code with no hook. No $GAFFER_DATA
#                 grant beyond the write roots (no database, no ledger) and no HOME grant.
#   replay        the tester lane's clean replay of the tester's own test files
#                 (bin/tester-run.mjs): the validation profile plus
#     • READS of file contents under $GAFFER_DATA are denied (the databases, settings, the
#       dashboard token, other worktrees, the factory log), then allowed again for the write
#       roots and the read roots (the dependency links and the repo's git directory);
#     • HOME's secret folders and files (_SANDBOX_REPLAY_HOME_SECRETS: .ssh, .aws, the gh
#       and gcloud configs, .claude, .npmrc, .netrc, .git-credentials, cargo's credentials,
#       .gnupg, ...) cannot be read or written at all.
#     Only file-read-data is denied under $GAFFER_DATA (metadata stays readable, so
#     resolving the checkout's own path through it still works).
# Returns non-zero (the profile file emptied) when a path cannot be written into the
# profile faithfully: the caller then refuses the launch (fail closed).
#   _sandbox_exec_profile <write-roots> <profile-path> [read-roots]
_sandbox_exec_profile() {
  local write_roots="$1"
  local profile_path="$2"
  local read_roots="${3:-}"
  local variant=agent
  case "${GAFFER_SANDBOX_PROFILE:-}" in
    replay) variant=replay ;;
    validation) variant=validation ;;
  esac
  # Every path a regex rule is built on must be representable; refuse before writing.
  local data_rx="" home_rx="" cfg
  if [ -n "${GAFFER_DATA:-}" ]; then
    data_rx="$(_sandbox_regex_prefix "$GAFFER_DATA")" || {
      printf 'strict-mode: GAFFER_DATA=%s cannot be written into a sandbox-exec profile (a quote or a line break in the path); refusing (fail closed)\n' "$GAFFER_DATA" >&2
      : > "$profile_path"; return 1; }
  fi
  if [ -n "${HOME:-}" ]; then
    home_rx="$(_sandbox_regex_prefix "$HOME")" || {
      printf 'strict-mode: HOME=%s cannot be written into a sandbox-exec profile (a quote or a line break in the path); refusing (fail closed)\n' "$HOME" >&2
      : > "$profile_path"; return 1; }
  fi
  while IFS= read -r cfg; do
    [ -n "$cfg" ] || continue
    _sandbox_regex_prefix "$cfg" >/dev/null || {
      printf 'strict-mode: the agent CLI config dir %s cannot be written into a sandbox-exec profile; refusing (fail closed)\n' "$cfg" >&2
      : > "$profile_path"; return 1; }
  done <<CFGDIRS
$(_sandbox_agent_config_dirs)
CFGDIRS
  {
    printf '(version 1)\n'
    printf ';; Gaffer strict-mode profile, generated, do not edit. Best-effort only.\n'
    printf ';; variant: %s\n' "$variant"
    printf '(allow default)\n'
    printf '(allow process-exec*)\n'
    printf '(allow process-fork)\n'
    if [ "${STRICT_ALLOW_NETWORK:-1}" = "1" ]; then
      printf '(allow network*)\n'
    else
      # NOTE: denying network here breaks Claude's OWN API calls because we wrap
      # the whole `claude -p` process. Left in as the explicit, honest knob;
      # true per-subprocess network isolation is a future-provider capability.
      printf '(deny network*)\n'
    fi
    printf '(deny file-write*)\n'
    # Re-grant writes ONLY to the explicit subpaths, as a SINGLE allow form (all the
    # (subpath ...)/(literal ...) clauses must be children of one `(allow file-write* ...)`:
    # bare (subpath ...) expressions grant nothing in SBPL).
    printf '(allow file-write*\n'
    # Each write-root (the worktree(s)).
    while IFS= read -r root; do
      _sandbox_subpath_rule "$root"
    done <<ROOTS
$write_roots
ROOTS
    # Temp dirs: many tools (python tempfile, pytest, build caches) write here.
    _sandbox_subpath_rule "${TMPDIR:-/tmp}"
    _sandbox_subpath_rule "/private/var/folders"
    _sandbox_subpath_rule "/tmp"
    # Operator-allowed HOME paths (the agent CLI's state and cache dirs), for the agent
    # only. A gate or a replay runs with a scratch HOME and never writes the runner's.
    local home_entry
    if [ "$variant" = agent ]; then
      for home_entry in ${STRICT_ALLOW_HOME:-}; do
        _sandbox_subpath_rule "$home_entry"
      done
    fi
    # Std streams + the null sink.
    printf '  (literal "/dev/null")\n'
    printf '  (literal "/dev/stdout")\n'
    printf '  (literal "/dev/stderr"))\n'
    if [ -n "${GAFFER_DATA:-}" ]; then _sandbox_exec_data_rules "$variant" "$write_roots"; fi
    if [ "$variant" = replay ]; then _sandbox_exec_replay_rules "$write_roots" "$read_roots"; fi
    if [ -n "${GAFFER_DATA:-}" ]; then _sandbox_exec_control_file_rules "$data_rx"; fi
    _sandbox_exec_agent_config_rules "$home_rx"
    # THE FACTORY KEY (signed gate events), LAST so it wins over every grant above: no
    # read, no write, no listing of the keys directory, in every profile.
    _sandbox_exec_factory_key_rules
    # THE OPERATOR'S REST TOKEN, also last: an agent that read it could approve as the
    # operator over the host's REST server, which then SEALS that approval.
    _sandbox_exec_operator_token_rules
  } > "$profile_path"
}

# The files under $GAFFER_DATA the in-sandbox writers need (the agent variant only): the
# dispatch and memory databases (when they live under it) with their SQLite siblings, the
# crew events log the MCP servers append to, and the safety hook's two ledgers. One path
# per line, not canonicalised. lib/sandbox-docker.sh's legacy layout keeps the same set.
gaffer_sandbox_data_writers() {
  local d="${GAFFER_DATA:-}" db
  [ -n "$d" ] || return 0
  for db in "${DISPATCH_DB:-$d/dispatch.sqlite}" "${MEMORY_DB:-$d/memory.sqlite}"; do
    case "$db" in
      "$d"/?*) printf '%s\n%s-wal\n%s-shm\n%s-journal\n' "$db" "$db" "$db" "$db" ;;
    esac
  done
  case "${GAFFER_CREW_EVENTS:-}" in "$d"/?*) printf '%s\n' "$GAFFER_CREW_EVENTS" ;; esac
  printf '%s\n%s\n' "$d/safety-blocks.jsonl" "$d/tool-metrics.jsonl"
}

# Step 4 above: $GAFFER_DATA denied, its ancestors denied, then the write roots (and, for
# the agent variant, the in-sandbox writers' files) re-granted.
#   _sandbox_exec_data_rules <variant> <write-roots>
_sandbox_exec_data_rules() {
  local variant="$1" write_roots="$2" root f
  printf '(deny file-write*\n'
  _sandbox_subpath_rule "$GAFFER_DATA"
  _sandbox_ancestor_rules "$GAFFER_DATA"
  # $GAFFER_DATA spelled in any letter case (a case-insensitive volume): where a temp or
  # HOME grant contains it, /private/tmp/GDATA/settings.json must not slip past the
  # subpath above. The re-grants below are exact, so a variant spelling stays denied.
  if [ -n "${data_rx:-}" ]; then printf '  (regex #"^%s(/|$)")\n' "$(_sandbox_regex_ci "$data_rx")"; fi
  printf ')\n'
  printf '(allow file-write*\n'
  while IFS= read -r root; do _sandbox_subpath_rule "$root"; done <<ROOTS
$write_roots
ROOTS
  if [ "$variant" = agent ]; then
    while IFS= read -r f; do [ -n "$f" ] && _sandbox_literal_rule "$f"; done <<WRITERS
$(gaffer_sandbox_data_writers)
WRITERS
  fi
  printf '  (literal "/dev/null"))\n'
}

# Step 5 above: the host-trusted files under $GAFFER_DATA, denied by name even where a
# write root would cover them. Who writes each and who trusts it: docs/sandbox.md.
#   _sandbox_exec_control_file_rules <escaped $GAFFER_DATA regex prefix>
_sandbox_exec_control_file_rules() {
  local rx="$1" d="${GAFFER_DATA:-}" n
  [ -n "$rx" ] && [ -n "$d" ] || return 0
  printf '(deny file-write*\n'
  # settings.json and its temp / rename siblings (.settings.<pid>.<hex>.tmp, backups).
  printf '  (regex #"^%s/\\.?settings[^/]*$")\n' "$rx"
  # Every dot entry: the per-ticket marker files (.failed-tickets, .reviewed-tickets,
  # .tester-held, .merge-held-tickets, .daily-ticks, ...), .route/, .workers/, the locks
  # (.usage-pause.lock, .ledger.lock), .usage-<n>.json, .dod-serial/.
  printf '  (regex #"^%s/\\.")\n' "$rx"
  # Every ledger (usage-ledger.jsonl, usage-ledger.held.jsonl, eval-ledger.jsonl, ...).
  printf '  (regex #"^%s/[^/]*ledger[^/]*$")\n' "$rx"
  # Top-level config, keys, pids, logs, profiles and anything runnable: usage-pause.json,
  # crew.yaml, acceptance-signing.key, dashboard.pid, factory.log, strict-profile.sb, ...
  printf '  (regex #"^%s/[^/]*\\.(json|yaml|yml|key|pid|log|sb|mjs|cjs|js|sh|sock|md|txt)$")\n' "$rx"
  # The generated per-call files the host reads back (profiles, roots, prompts, MCP configs).
  printf '  (regex #"^%s/(strict-profile|sandbox-write-roots|sandbox-read-roots|worker-prompt|mcp-)[^/]*$")\n' "$rx"
  # The principal / agent id files the host trusts.
  printf '  (regex #"^%s/agent_[^/]*$")\n' "$rx"
  for n in dashboard-token dashboard-url delivery-metrics.jsonl context-selection.jsonl \
           skills-telemetry.jsonl memory-audit.jsonl audit.jsonl command-worker.jsonl factory.jsonl; do
    _sandbox_literal_rule "$d/$n"
  done
  # Host-owned directories: skills an agent would load, the docker git dirs, run state,
  # and the tick's helper-server pipes (a request written there is a dispatch command
  # run with the tick's authority; the per-tick key is the first guard, this the second).
  for n in skills-mounts sandbox-git locks run-state runs manifests scout experiments wg-serve; do
    _sandbox_subpath_rule "$d/$n"
  done
  # A usage ledger the operator moved out of $GAFFER_DATA.
  if [ -n "${GAFFER_USAGE_LEDGER:-}" ]; then _sandbox_literal_rule "$GAFFER_USAGE_LEDGER"; fi
  printf ')\n'
}

# The agent CLI's user configuration directories: ~/.claude, and CLAUDE_CONFIG_DIR when
# set (the CLI reads its settings, memory, hooks, agents, commands and skills there).
_sandbox_agent_config_dirs() {
  if [ -n "${HOME:-}" ]; then printf '%s\n' "$HOME/.claude"; fi
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ "${CLAUDE_CONFIG_DIR%/}" != "${HOME:-}/.claude" ]; then
    printf '%s\n' "${CLAUDE_CONFIG_DIR%/}"
  fi
  return 0
}

# Step 6 above: the agent CLI's configuration surface is never writable, whatever
# STRICT_ALLOW_HOME or a temp grant covers. What the CLI writes at runtime (projects/,
# todos/, statsig/, shell-snapshots/, session state, history.jsonl) stays writable under
# the ~/.claude grant. Denied: the directory itself and its ancestors (no rename swaps it),
# every top-level *.json (settings.json, settings.local.json, keybindings.json, a
# CLAUDE_CONFIG_DIR's .claude.json) and *.md (CLAUDE.md), and the hooks, agents, commands,
# skills, plugins, output-styles, rules, local (the CLI's own local install) and bin
# directories; ~/.claude.json and its siblings (backups, locks) at the HOME level.
#   _sandbox_exec_agent_config_rules <escaped $HOME regex prefix>
_sandbox_exec_agent_config_rules() {
  local home_rx="$1" cfg rx sub cx alt
  printf '(deny file-write*\n'
  while IFS= read -r cfg; do
    [ -n "$cfg" ] || continue
    rx="$(_sandbox_regex_prefix "$cfg")" || continue   # refused earlier, before any output
    _sandbox_literal_rule "$cfg"
    _sandbox_ancestor_rules "$cfg"
    printf '  (regex #"^%s/[^/]*\\.(json|md)$")\n' "$rx"
    for sub in hooks agents commands skills plugins output-styles rules local bin; do
      _sandbox_subpath_rule "$cfg/$sub"
    done
    # The same surface in any letter case (a case-insensitive volume opens CLAUDE.MD for
    # CLAUDE.md, Skills/ for skills/), the directory itself in any case, and any name under
    # it holding a non-ASCII byte (the volume folds U+017F to s, U+212A to k, ...; the
    # CLI's own runtime names are ASCII). Also the per-project auto-memory directory,
    # which the CLI loads into every later session in that project.
    cx="$(_sandbox_regex_ci "$rx")"
    printf '  (regex #"^%s$")\n' "$cx"
    printf '  (regex #"^%s/[^/]*\\.(%s|%s)$")\n' "$cx" "$(_sandbox_regex_ci json)" "$(_sandbox_regex_ci md)"
    alt=""
    for sub in hooks agents commands skills plugins output-styles rules local bin; do
      alt="$alt${alt:+|}$(_sandbox_regex_ci "$sub")"
    done
    printf '  (regex #"^%s/(%s)(/|$)")\n' "$cx" "$alt"
    printf '  (regex #"^%s/%s/[^/]+/%s(/|$)")\n' "$cx" "$(_sandbox_regex_ci projects)" "$(_sandbox_regex_ci memory)"
    printf '  (regex #"^%s/.*[^ -~]")\n' "$cx"
  done <<CFGDIRS
$(_sandbox_agent_config_dirs)
CFGDIRS
  if [ -n "$home_rx" ]; then
    printf '  (regex #"^%s/\\.claude\\.json")\n' "$home_rx"
    printf '  (regex #"^%s/\\.%s\\.%s")\n' "$(_sandbox_regex_ci "$home_rx")" "$(_sandbox_regex_ci claude)" "$(_sandbox_regex_ci json)"
  fi
  printf ')\n'
}

# The factory signing key's directory (packages/dispatch/src/events/gateSeal.ts
# factoryKeysDir): ${XDG_CONFIG_HOME:-$HOME/.config}/gaffer/keys. Nothing relocates it.
gaffer_factory_keys_dir() {
  local base="${XDG_CONFIG_HOME:-}"
  case "$base" in /*) ;; *) base="${HOME:-}/.config" ;; esac
  printf '%s/gaffer/keys' "$base"
}

# Deny every file operation under the factory keys directory (and the HOME-default one
# when XDG_CONFIG_HOME moved it), printed after every allow rule (SBPL is last-match-wins).
_sandbox_exec_factory_key_rules() {
  local kd home_kd
  kd="$(gaffer_factory_keys_dir)"
  home_kd="${HOME:-}/.config/gaffer/keys"
  printf '(deny file-read* file-write*\n'
  _sandbox_subpath_rule "$kd"
  [ -n "${HOME:-}" ] && [ "$home_kd" != "$kd" ] && _sandbox_subpath_rule "$home_kd"
  printf ')\n'
}

# The operator's REST bearer token (packages/dispatch/src/api/auth.ts
# resolveDashboardTokenPath): $GAFFER_DATA/dashboard-token, or ~/.gaffer/dashboard-token
# when GAFFER_DATA is unset. The delivery profile grants reads everywhere and writes under
# $GAFFER_DATA, and the network is allowed: with the token an agent past the hook could
# call the host's REST server on localhost and approve as the operator, and the host
# process would seal that approval with the factory key. Nothing inside the sandbox needs
# it (the MCP servers and the dispatch CLI use the sqlite files, never REST), so both
# profiles deny reading and writing it, after every grant.
_sandbox_exec_operator_token_rules() {
  printf '(deny file-read* file-write*\n'
  [ -n "${GAFFER_DATA:-}" ] && _sandbox_subpath_rule "${GAFFER_DATA}/dashboard-token"
  [ -n "${HOME:-}" ] && _sandbox_subpath_rule "${HOME}/.gaffer/dashboard-token"
  # The runner's acceptance signing key (lib/acceptance-profiles.mjs): with it a row typed
  # in by an agent would carry the runner's signature. Nothing inside a sandbox needs it.
  [ -n "${GAFFER_DATA:-}" ] && _sandbox_subpath_rule "${GAFFER_DATA}/acceptance-signing.key"
  printf ')\n'
}

# HOME's folders and files the replay variant can neither read nor write (credentials and
# the agent's own configuration). Paths relative to $HOME, space separated.
_SANDBOX_REPLAY_HOME_SECRETS=".ssh .aws .config/gh .config/gcloud .azure .kube .docker .claude .npmrc .netrc .pypirc .git-credentials .cargo/credentials .cargo/credentials.toml .gnupg"
# The replay variant's extra rules (see above), printed after the write grant.
#   _sandbox_exec_replay_rules <write-roots> <read-roots>
_sandbox_exec_replay_rules() {
  local write_roots="$1" read_roots="$2" data_rule root secret
  data_rule="$(_sandbox_subpath_rule "${GAFFER_DATA:-}")"
  if [ -n "$data_rule" ]; then
    printf '(deny file-read-data\n%s)\n' "$data_rule"
    printf '(allow file-read-data\n'
    while IFS= read -r root; do _sandbox_subpath_rule "$root"; done <<ROOTS
$write_roots
$read_roots
ROOTS
    printf '  (literal "/dev/null"))\n'
  fi
  if [ -n "${HOME:-}" ]; then
    printf '(deny file-read* file-write*\n'
    for secret in $_SANDBOX_REPLAY_HOME_SECRETS; do
      _sandbox_subpath_rule "$HOME/$secret"
    done
    printf ')\n'
  fi
  return 0
}

# ── The provider seam ────────────────────────────────────────────────────────
# Dispatch on $SANDBOX_PROVIDER. A new provider == a new case; nothing else
# changes. Echoes the wrapping command prefix to stdout; diagnostics to stderr.
# STRICT-REQUIRE (C4), THE DEFAULT. The provider paths below that cannot supply an OS
# sandbox FAIL CLOSED unless the operator opted out with an explicit
# GAFFER_STRICT_REQUIRE=0 (or false/no/off) in the environment: OS isolation is the
# normal path for every agent launch, so unset, empty or any other value means
# "required". Only under the opt-out do those paths warn and DEGRADE (return 0 → run
# with worktree isolation + the safety hook, no OS sandbox). Helper: true when strict
# containment is required.
_sandbox_strict_required() {
  case "$(printf '%s' "${GAFFER_STRICT_REQUIRE:-1}" | tr '[:upper:]' '[:lower:]')" in
    0 | false | no | off) return 1 ;;
  esac
  return 0
}

# The provider when SANDBOX_PROVIDER is unset: the same auto-detection as
# runner/config/16-sandbox.sh (sandbox-exec where the binary exists, else docker where
# the docker CLI exists, else sandbox-exec so the refusal names the macOS-only tool).
# Repeated here because the Node launchers the dashboard starts reach this file without
# the config (lib/worker.mjs sandboxWrapArgv), so nothing else has set it for them.
gaffer_sandbox_default_provider() {
  if command -v sandbox-exec >/dev/null 2>&1; then printf 'sandbox-exec'
  elif command -v docker >/dev/null 2>&1; then printf 'docker'
  else printf 'sandbox-exec'; fi
}
_sandbox_provider() { printf '%s' "${SANDBOX_PROVIDER:-$(gaffer_sandbox_default_provider)}"; }

# THE ISOLATION PROBE: can this host supply the configured OS sandbox right now? No
# write roots and no side effects: it asks what sandbox_wrap_cmd asks (the binary, the
# docker CLI and daemon) and, for docker, whether the sandbox image is built (a launch
# without it fails inside the wrapper). Sets, for the caller:
#   GAFFER_SBX_PROVIDER   the provider in force (SANDBOX_PROVIDER or the detected one)
#   GAFFER_SBX_AVAILABLE  1 when it can wrap an agent, 0 when not
#   GAFFER_SBX_MISSING    what this host lacks, in words ("" when available)
#   GAFFER_SBX_FIX        the fix for it ("" when available)
# Always returns 0. The image name is GAFFER_SANDBOX_IMAGE, as in sandbox-docker.sh.
_SBX_BUILD_CMD='docker compose --profile sandbox build sandbox-image egress-proxy'
gaffer_sandbox_probe() {
  GAFFER_SBX_PROVIDER="$(_sandbox_provider)"
  GAFFER_SBX_AVAILABLE=0; GAFFER_SBX_MISSING=""; GAFFER_SBX_FIX=""
  local os; os="$(uname -s 2>/dev/null || echo unknown)"
  case "$GAFFER_SBX_PROVIDER" in
    sandbox-exec)
      if command -v sandbox-exec >/dev/null 2>&1; then GAFFER_SBX_AVAILABLE=1; return 0; fi
      if [ "$os" = Darwin ]; then
        GAFFER_SBX_MISSING="sandbox-exec is not on PATH"
        GAFFER_SBX_FIX="put /usr/bin (where macOS keeps sandbox-exec) back on PATH"
      elif command -v docker >/dev/null 2>&1; then
        GAFFER_SBX_MISSING="SANDBOX_PROVIDER=sandbox-exec, which exists only on macOS, and this is $os"
        GAFFER_SBX_FIX="unset SANDBOX_PROVIDER (or set it to docker) to use the Docker you have, and build its images once with \`$_SBX_BUILD_CMD\` (gaffer setup does this)"
      else
        GAFFER_SBX_MISSING="this is $os, where sandbox-exec does not exist, and Docker is not installed"
        GAFFER_SBX_FIX="install Docker, then run \`gaffer setup\` again (it builds the sandbox images with \`$_SBX_BUILD_CMD\`)"
      fi ;;
    docker)
      if ! command -v docker >/dev/null 2>&1; then
        GAFFER_SBX_MISSING="SANDBOX_PROVIDER=docker but the docker CLI is not installed"
        GAFFER_SBX_FIX="install Docker, then run \`gaffer setup\` again (it builds the sandbox images with \`$_SBX_BUILD_CMD\`)"
      elif ! docker info >/dev/null 2>&1; then
        GAFFER_SBX_MISSING="Docker is installed but its daemon is not reachable"
        GAFFER_SBX_FIX="start the docker daemon (or give this user access to it), then build the images once with \`$_SBX_BUILD_CMD\` (gaffer setup does this)"
      elif ! docker image inspect "${GAFFER_SANDBOX_IMAGE:-gaffer-sandbox:latest}" >/dev/null 2>&1; then
        GAFFER_SBX_MISSING="the docker sandbox image ${GAFFER_SANDBOX_IMAGE:-gaffer-sandbox:latest} is not built"
        GAFFER_SBX_FIX="build it once with \`$_SBX_BUILD_CMD\` in ${GAFFER_HOME:-the gaffer checkout} (gaffer setup does this)"
      else
        GAFFER_SBX_AVAILABLE=1
      fi ;;
    none)
      GAFFER_SBX_MISSING="SANDBOX_PROVIDER=none turns the OS sandbox off"
      GAFFER_SBX_FIX="unset SANDBOX_PROVIDER to auto-detect one (sandbox-exec on macOS, docker on Linux)" ;;
    *)
      GAFFER_SBX_MISSING="SANDBOX_PROVIDER=$GAFFER_SBX_PROVIDER is not a provider"
      GAFFER_SBX_FIX="set SANDBOX_PROVIDER to docker (any host with Docker) or sandbox-exec (macOS), or unset it to auto-detect" ;;
  esac
  return 0
}

# THE ONE MESSAGE a person can act on when an agent launch is refused because this host
# has no OS sandbox: the host's situation, the fix for it, then the opt-out (the
# environment only: settings.json cannot loosen it). Shown by `gaffer run`, the loop,
# a refused tick (the setup error the dashboard shows), the parked ticket's reason on
# the Team sheet (with "ticket", which adds the last step) and the Node launchers.
#   gaffer_sandbox_unavailable_hint [ticket] → the line (never empty)
gaffer_sandbox_unavailable_hint() {
  gaffer_sandbox_probe
  local why="$GAFFER_SBX_MISSING" fix="$GAFFER_SBX_FIX"
  if [ -z "$why" ]; then
    # Available to the probe but a wrap still failed (the daemon went away, a profile
    # file could not be written): name the provider and send the person to the log.
    why="the $GAFFER_SBX_PROVIDER sandbox could not be set up for this launch"
    fix="see \$GAFFER_DATA/factory.log for the provider's message"
  fi
  printf '%s' "agents run inside an OS sandbox and this host cannot supply one: $why. Fix: $fix. Or set GAFFER_STRICT_REQUIRE=0 in the environment (settings.json cannot) to run agents without one, only when the runner already runs inside a VM or container you trust."
  [ "${1:-}" = ticket ] && printf '%s' " Then move the ticket back to ready."
  return 0
}

# THE LAUNCH GATE, asked once before anything is claimed or spawned (`gaffer run`, the
# loop, the dashboard's Poll for work, every live tick). Returns 0 when an agent may
# launch: a dry run (DRY_RUN=1 never launches one), the sandbox is available, or the
# operator opted out in the environment (said loudly, once per process tree). Returns 1
# when it may not; the caller prints gaffer_sandbox_unavailable_hint in its own voice.
# The worker seams (lib/worker.sh, lib/worker.mjs) refuse each spawn on their own too.
gaffer_isolation_gate() {
  [ "${DRY_RUN:-0}" = 1 ] && return 0
  if ! _sandbox_strict_required; then
    gaffer_isolation_optout_notice
    return 0
  fi
  gaffer_sandbox_probe
  [ "$GAFFER_SBX_AVAILABLE" = 1 ]
}

# The opt-out, said once per process tree (the config is re-sourced by every child).
gaffer_isolation_optout_notice() {
  [ "${_GAFFER_STRICT_OPTOUT_WARNED:-}" = 1 ] && return 0
  printf 'WARNING: GAFFER_STRICT_REQUIRE=%s in the environment: agents run without the required OS sandbox. Only the worktree and the safety hook contain them, so this is safe only when the runner already runs inside a VM or container you trust.\n' "${GAFFER_STRICT_REQUIRE-}" >&2
  _GAFFER_STRICT_OPTOUT_WARNED=1; export _GAFFER_STRICT_OPTOUT_WARNED
  return 0
}

# AGENTS WRAPPED: true when an agent launch is wrapped in the OS sandbox now, read after
# gaffer_sandbox_probe: the provider is available and the launch asks for it (required, or
# STRICT_MODE=1; lib/tick-launch.sh). When false, nothing but the safety hook stands
# between an agent and a person's act (a tester waiver included): `gaffer preflight` and
# `gaffer status` say so (package H1).
_gaffer_agents_wrapped_probed() {
  [ "$GAFFER_SBX_AVAILABLE" = 1 ] || return 1
  _sandbox_strict_required && return 0
  [ "${STRICT_MODE:-0}" = 1 ]
}
gaffer_agents_wrapped() { gaffer_sandbox_probe; _gaffer_agents_wrapped_probed; }

# The one warning both say when agents run without OS isolation.
gaffer_human_verdict_isolation_warning() {
  printf '%s' "agents run without OS isolation, so a person's tester verdict (and every other human act) is guarded by the safety hook only; a waiver recorded now says \"recorded without OS isolation\""
}

# The isolation posture as one JSON object, for `gaffer sandbox-status` and the
# dashboard's Settings line: {provider, available, required, optedOut, missing, fix,
# wrapped}. `wrapped` is whether an agent launch is wrapped in the OS sandbox now: the
# provider is available AND the launch asks for it (required, or STRICT_MODE=1; see
# lib/tick-launch.sh). Dispatch records it on a person's tester waiver (package H1).
gaffer_sandbox_status_json() {
  gaffer_sandbox_probe
  local req=true opt=false wrapped=false
  if ! _sandbox_strict_required; then req=false; opt=true; fi
  if _gaffer_agents_wrapped_probed; then wrapped=true; fi
  node -e 'const [p,a,r,o,m,f,w]=process.argv.slice(1);process.stdout.write(JSON.stringify({provider:p,available:a==="1",required:r==="true",optedOut:o==="true",missing:m,fix:f,wrapped:w==="true"})+"\n")' \
    "$GAFFER_SBX_PROVIDER" "$GAFFER_SBX_AVAILABLE" "$req" "$opt" "$GAFFER_SBX_MISSING" "$GAFFER_SBX_FIX" "$wrapped"
}

sandbox_wrap_cmd() {
  local write_roots="${1:-}"
  local read_roots="${2:-}"   # used only by sandbox-exec's replay variant (reads are broad otherwise)

  case "$(_sandbox_provider)" in
    none)
      # No OS-level wrapping. Worktree isolation + safety hook still apply — UNLESS
      # the operator required an OS sandbox, in which case "none" is a contradiction.
      if _sandbox_strict_required; then
        printf 'strict-mode: SANDBOX_PROVIDER=none but the OS sandbox is required (GAFFER_STRICT_REQUIRE) — refusing to run (fail closed)\n' >&2
        return 1
      fi
      return 0
      ;;

    sandbox-exec)
      if ! command -v sandbox-exec >/dev/null 2>&1; then
        if _sandbox_strict_required; then
          printf 'strict-mode: sandbox-exec not found (macOS-only) and the OS sandbox is required (GAFFER_STRICT_REQUIRE) — refusing to run without an OS sandbox (fail closed)\n' >&2
          return 1
        fi
        printf 'strict-mode: sandbox-exec not found on this host — falling back to no OS sandbox (worktree isolation + safety hook still apply)\n' >&2
        return 0
      fi
      mkdir -p "${GAFFER_DATA:-/tmp}" 2>/dev/null || true
      # PER-CALL profile file, never a fixed shared path. Every invocation used to write
      # `$GAFFER_DATA/strict-profile.sb` and hand back a command that loads it LATER —
      # under GAFFER_CONCURRENCY>1 worker B could overwrite it between worker A composing
      # its wrap and A's sandbox-exec starting, so A ran under B's write roots. Same
      # pattern as the docker branch below: mktemp'd, prefixed with the tick's PID so
      # tick.sh's exit cleanup sweeps exactly its own files.
      local profile_path
      profile_path="$(mktemp "${GAFFER_DATA:-/tmp}/strict-profile.$$.XXXXXX" 2>/dev/null)" || {
        printf 'strict-mode: sandbox-exec provider could not create the per-call profile file under %s\n' "${GAFFER_DATA:-/tmp}" >&2
        return 1
      }
      if ! _sandbox_exec_profile "$write_roots" "$profile_path" "$read_roots"; then
        rm -f "$profile_path"
        return 1
      fi
      printf 'sandbox-exec -f %s' "$profile_path"
      return 0
      ;;

    docker)
      # Mode 2: run the agent inside a container with read + egress isolation (see
      # lib/sandbox-docker.sh + docs/sandbox.md). Unlike sandbox-exec this
      # is a full execution context, not a syscall filter — so it wraps by emitting a
      # prefix that runs the command in the container. Needs a live docker daemon.
      if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
        if _sandbox_strict_required; then
          printf 'strict-mode: docker provider selected but the docker daemon is unavailable and the OS sandbox is required (GAFFER_STRICT_REQUIRE) — refusing to run (fail closed)\n' >&2
          return 1
        fi
        printf 'strict-mode: docker daemon unavailable — falling back to no OS sandbox (worktree isolation + safety hook still apply)\n' >&2
        return 0
      fi
      mkdir -p "${GAFFER_DATA:-/tmp}" 2>/dev/null || true
      # write/read roots can be multi-line — hand them to the wrapper via files.
      # B25(a): PER-CALL files, never a fixed shared path. Under GAFFER_CONCURRENCY>1
      # every worker used to write `$GAFFER_DATA/sandbox-write-roots`: worker B's
      # roots could overwrite worker A's between A composing its wrap and A's
      # container starting, so A's agent was mounted B's worktree READ-WRITE (and
      # lost its own). Each call now gets its own mktemp'd pair, prefixed with the
      # tick's PID so tick.sh's exit cleanup can sweep exactly its own files.
      local wrf rrf
      wrf="$(mktemp "${GAFFER_DATA:-/tmp}/sandbox-write-roots.$$.XXXXXX" 2>/dev/null)" || {
        printf 'strict-mode: docker provider could not create the per-call write-roots file under %s\n' "${GAFFER_DATA:-/tmp}" >&2
        return 1
      }
      rrf="$(mktemp "${GAFFER_DATA:-/tmp}/sandbox-read-roots.$$.XXXXXX" 2>/dev/null)" || {
        rm -f "$wrf"
        printf 'strict-mode: docker provider could not create the per-call read-roots file under %s\n' "${GAFFER_DATA:-/tmp}" >&2
        return 1
      }
      printf '%s\n' "$write_roots" > "$wrf"
      printf '%s\n' "$read_roots" > "$rrf"
      printf 'bash %s/lib/sandbox-docker.sh %s %s --' "${RUNNER_DIR:-.}" "$wrf" "$rrf"
      return 0
      ;;

    # (The former `lima` stub case is gone: an unimplemented provider is simply an
    # unknown one — same fail-closed / degrade behaviour below, no misleading choice.)
    *)
      if _sandbox_strict_required; then
        printf "strict-mode: unknown provider '%s' and the OS sandbox is required (GAFFER_STRICT_REQUIRE) — refusing to run without an OS sandbox (fail closed)\n" "${SANDBOX_PROVIDER}" >&2
        return 1
      fi
      printf "strict-mode: unknown provider '%s' — falling back to no OS sandbox (worktree isolation still applies)\n" "${SANDBOX_PROVIDER}" >&2
      return 0
      ;;
  esac
}
