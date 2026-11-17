# The OS sandbox

Every delivery already runs in a throwaway git worktree, behind the deterministic
PreToolUse safety hook (`runner/safety-hook.mjs`), which blocks writes, branch moves
and reads outside the resolved roots at the tool layer. The OS sandbox is the third
layer under those two. It catches what an in-process hook cannot see: a path
built at runtime inside `python3 -c "..."`, a write from an exec'd child, a library
writing through a syscall the hook never inspected.

It is on by default, in every mode. `GAFFER_STRICT_REQUIRE` defaults to 1 and
`STRICT_MODE` to 1 with it, so every agent launch (a delivery, a review, clarify, a
bootstrap, the idle lanes, onboarding, Plan a build, Suggest work, the spec author, the
merge resolver, the tester and the judge) runs inside the sandbox or does not run. On a
host with no working provider, `gaffer run`, the loop, a tick and the dashboard's Poll
for work refuse before they claim anything, and the Node launchers the dashboard starts
refuse at the spawn. They all say the same thing: what the host is missing, the fix,
and the opt-out. `gaffer setup` never fails for lack of a sandbox: it prints what it
found and the fix, and on Linux with a reachable Docker daemon it builds the images.
The Settings page shows the posture as a read-only line in its Sandbox group, and
`runner/gaffer sandbox-status` prints it as JSON. Dry runs need no sandbox.

The opt-out is `GAFFER_STRICT_REQUIRE=0` (or `false`, `no`, `off`) in the environment.
settings.json cannot set it: the file lives in `GAFFER_DATA`, which an agent's sandbox
may reach. It means you contain the whole runner yourself, in a VM or a container: agents
then run with only the worktree and the safety hook around them (unless you also set
`STRICT_MODE=1` or `GAFFER_MODE=strict`, which still wrap where a provider exists), and
the runner says so once each time it starts. The Docker image sets it, because there
the container is the boundary.

It is defence in depth, not a security guarantee. It raises the cost of an escape; it
does not make one impossible, and it does not replace the worktree or the hook. The
honest posture is to run untrusted input only under the `docker` provider, on a host
whose blast radius you accept. [SECURITY.md](../SECURITY.md) has the full threat model.

## Providers

The sandbox is a provider seam: `sandbox_wrap_cmd` in `runner/lib/sandbox.sh` takes the
resolved write and read roots and echoes a command prefix for the agent run.
`SANDBOX_PROVIDER` picks the provider:

| Provider | What it contains | Notes |
| --- | --- | --- |
| `docker` | reads, writes and network egress | Any host with a Docker daemon. Experimental but real; the rest of this page is about it. |
| `sandbox-exec` | writes only | macOS. Apple has deprecated `sandbox-exec`; it still works on current macOS. |
| `none` | nothing | Keeps the toggle, adds no OS wrapping. |

Unset, the runner picks `sandbox-exec` where the binary exists and `docker` where only
the Docker CLI does. An explicit value always wins. A provider the host cannot supply
(`none`, an unknown name, docker without a daemon or its image) fails closed, and only
under the `GAFFER_STRICT_REQUIRE=0` opt-out warns and runs unwrapped. Adding a
provider is one `case` branch in `lib/sandbox.sh`; nothing in `tick.sh` or the config
changes.

`sandbox-exec` is a write sandbox, not a jail. It wraps the whole agent process,
which needs the network for its own model calls, so it cannot isolate egress, and it
does not isolate reads: under it, the path "read host data, encode it, send it out"
stays open. The `docker` provider closes both. What `sandbox-exec` does contain: no write outside the
worktree, the temp dirs and the agent CLI's runtime state, none to the factory's control
files under `$GAFFER_DATA` and none to the agent CLI's user configuration. What it does
not: reads, egress, and the agent writing the dispatch and memory databases directly
(the in-sandbox MCP servers need them writable). `docker` is the stronger provider.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `STRICT_MODE` | `1` while the sandbox is required (`0` under the opt-out) | `1` wraps the live agent in the sandbox provider. |
| `SANDBOX_PROVIDER` | auto (see above) | `docker`, `sandbox-exec` or `none`. |
| `GAFFER_STRICT_REQUIRE` | `1` | `1` refuses to launch an agent without a sandbox. `0` in the environment (only there) is the opt-out. |
| `STRICT_ALLOW_NETWORK` | `1` | Allow network inside the sandbox. `0` breaks a `sandbox-exec` run, because the agent's own model call is denied too. |
| `STRICT_ALLOW_HOME` | `$HOME/.claude $HOME/.cache` | HOME paths the agent (never a gate) may write: the agent CLI's own state and cache. Its configuration surface stays denied. |
| `GAFFER_DOD_SANDBOX` | `1` | Run the DoD gates and criterion checks under the sandbox (the validation profile); they execute agent-written code. |
| `GAFFER_DOD_ENV_PASS` | empty | Extra variable names every gate run receives; credential-shaped and factory names are refused. |

These are values `GAFFER_SANDBOX` and `GAFFER_GATES` derive (all of them are in
[CONFIG-ADVANCED.md](CONFIG-ADVANCED.md)); a real environment variable overrides each, so
scope them however you scope config:

```bash
SANDBOX_PROVIDER=docker runner/gaffer run   # pick docker on a Mac that has both
# a repo whose tooling needs more writable HOME state:
export STRICT_ALLOW_HOME="$HOME/.claude $HOME/.cache $HOME/.cargo"
```

When the sandbox is on, `tick.sh` logs the provider it used.

## The `sandbox-exec` profile

Each wrap writes its own profile file (`$GAFFER_DATA/strict-profile.<pid>.XXXXXX`, so
concurrent workers never share one). The profile is SBPL, which is last-match-wins:

1. `(allow default)`: reads, and everything else, broadly allowed.
2. `(deny file-write*)`: revoke all writes.
3. One `(allow file-write* ...)` that grants writes back only to each write root (the
   delivery worktrees), the temp dirs (`$TMPDIR`, `/private/var/folders`, `/tmp`), each
   path in `$STRICT_ALLOW_HOME` (the agent profile only), and `/dev/null`,
   `/dev/stdout`, `/dev/stderr`.
4. `(deny file-write* (subpath $GAFFER_DATA) ...)` with a literal deny for every parent
   directory of `$GAFFER_DATA` (so a rename of a parent cannot swap in another data
   directory), then writes granted back to the write roots that live under it and, for
   the agent profile only, to the files the in-sandbox writers need: the dispatch and
   memory databases with their `-wal`, `-shm` and `-journal` files, the crew events log
   and the safety hook's `safety-blocks.jsonl` and `tool-metrics.jsonl`. This is the same
   set the docker legacy layout leaves visible (`sandbox-exec-data-plane.test.sh` D3).
5. A deny, by name, of every host-trusted file under `$GAFFER_DATA`, even where a write
   root would cover it (see the table below).
6. A deny of the agent CLI's user configuration in `~/.claude` and in
   `CLAUDE_CONFIG_DIR`: the directory itself and its parents, every top-level `*.json`
   (`settings.json`, `settings.local.json`, `keybindings.json`) and `*.md` (`CLAUDE.md`),
   and the `hooks`, `agents`, `commands`, `skills`, `plugins`, `output-styles`, `rules`,
   `local` and `bin` directories, plus `~/.claude.json` and its backups. A planted user
   setting or hook would run in every later agent and in your own CLI. The CLI's runtime
   state (`projects/`, `todos/`, `statsig/`, `shell-snapshots/`, `history.jsonl`) stays
   writable, except each project's auto-memory directory (`projects/*/memory`), which the
   CLI loads into later sessions. A macOS volume is case-insensitive by default and the
   kernel checks a file being created by the name as typed, so these denies are also
   written in every letter case (`CLAUDE.MD`, `Skills/`), and any name under the
   directory holding a non-ASCII byte is denied (the volume folds some non-ASCII letters
   to ASCII ones). `$GAFFER_DATA` itself is denied in every letter case too.
7. Read and write denies for the factory keys directory, the operator's REST token and
   the runner's acceptance signing key.

`process-exec` and `process-fork` are allowed; network follows `STRICT_ALLOW_NETWORK`.
Because the temp dirs are writable (build tools need them), the escape it blocks is a
write into your home, another repo, the factory's control files or anywhere else outside
the worktree and the list. A path that cannot be written into SBPL faithfully (a quote or
a line break in `$GAFFER_DATA` or `$HOME`) refuses the profile, and the launch with it.

### Who writes what under `$GAFFER_DATA`

| Entry | Written by | Trusted by the host as | Agent profile |
| --- | --- | --- | --- |
| `dispatch.sqlite`, `memory.sqlite` and their `-wal`/`-shm`/`-journal` | the in-sandbox MCP servers; the host CLI | board and memory state | writable (the residual limit: use docker's bridge to close it) |
| `events.jsonl` (crew events), `safety-blocks.jsonl`, `tool-metrics.jsonl` | the MCP servers, the safety hook | telemetry | writable |
| `settings.json` and `.settings.*.tmp` | the dashboard | configuration exported into every runner process | denied |
| `usage-pause.json`, `.usage-pause.lock` | the runner | the usage pause | denied |
| `usage-ledger*.jsonl`, `eval-ledger.jsonl`, any `*ledger*` | the runner | spend caps, verdicts | denied |
| `delivery-metrics.jsonl`, `context-selection.jsonl`, `skills-telemetry.jsonl`, `command-worker.jsonl` | the runner | dashboard figures | denied |
| `audit.jsonl`, `memory-audit.jsonl` | the MCP servers (append, fail-soft) | the audit trail people read | denied (as docker masks them; the append is skipped) |
| dot entries (`.failed-tickets`, `.reviewed-tickets`, `.tester-held`, `.merge-held-tickets`, `.daily-ticks`, `.route/`, `.workers/`, `.dod-serial/`, ...) | the runner | per-ticket state | denied |
| `crew.yaml` | you, the runner | configuration | denied |
| `mcp-runtime.*.json`, `mcp-product-owner-runtime.json` | the runner | MCP configuration (the agent only reads its own) | denied |
| `strict-profile.*`, `sandbox-*-roots.*`, `worker-prompt.*` | the runner | the sandbox's own configuration | denied |
| `dashboard-token`, `acceptance-signing.key` | the dashboard, the runner | credentials | denied, reads too |
| `dashboard-url`, `dashboard.pid`, `*.log`, `agent_id`, `agent_reviewer_id` | the runner (agent output reaches the log through an inherited descriptor) | facts and identity | denied |
| `skills-mounts/`, `sandbox-git/`, `locks/`, `run-state/`, `runs/`, `manifests/`, `scout/`, `experiments/`, `wg-serve/` | the runner | skills agents load, runner state, the tick's helper server pipes | denied |
| `worktrees/<this call's>` | the agent | the code under review | writable (a write root) |
| `worktrees/<another call's>` | other agents | their code | denied |

### The gates' profile

The DoD gates, the acceptance checks, the pre-gate install and `bin/dod-regate.sh` (the
merge gate, the conflict re-gate, the tester replay through the landing path) run agent
code with no hook, so they never run under the agent's profile file. Each run gets a fresh
`GAFFER_SANDBOX_PROFILE=validation` profile, removed afterwards: rules 1 to 7 with its
worktree as the only write root, no `$GAFFER_DATA` grant beyond it and no HOME grant. A
profile that cannot be generated means the gate is not run. Every gate run, on every
provider and with no sandbox at all, also starts from `env -i` plus PATH, a throwaway
HOME, the locale, `CI=1`, the proxy and CA settings, `TERM`/`TZ`, the toolchain homes
(`GOPATH`, `CARGO_HOME`, `RUSTUP_HOME`, `JAVA_HOME`, `NVM_DIR`, `PNPM_HOME`, ...), a
placeholder git identity and the names you list in `GAFFER_DOD_ENV_PASS`. A
credential-shaped name, an endpoint, `ANTHROPIC_*`, `CLAUDE_*`, `DISPATCH_*`, `MEMORY_*`,
`AWS_*` or `GAFFER_*` never passes, listed or not.

### How it is tested

`runner/test/strict-mode.test.sh` proves on macOS, with real temp dirs and a generated
profile, that a write inside the worktree succeeds, a write outside it (including a path
built at runtime) or to `settings.json` is blocked by the OS, `python3 -m unittest`
still runs, and the seam dispatches each provider correctly.
`runner/test/sandbox-exec-data-plane.test.sh` and `sandbox-exec-agent-config.test.sh`
read real generated profiles through a small SBPL evaluator
(`runner/test/lib/sbpl-eval.mjs`), so the profile's meaning is checked on every host;
their macOS sections check the kernel: an append to `settings.json`, a temp-file rename
over it, a hard link to it, a rename of `$GAFFER_DATA` or `~/.claude` and a write to
`~/.claude/settings.json` or `CLAUDE.md` all fail, while a SQLite write in WAL mode to
the dispatch database and a write under `~/.claude/projects` succeed, and a gate cannot
write the database. `dod-sandbox-wrap.test.sh` checks the gates' profile and
environment.

What is not fully validated: a whole live agent run under the profile. The agent CLI
writes to state and cache paths that vary by host and version. If a live run is
blocked on a path it legitimately needs, the block shows in `$GAFFER_LOG` as a sandbox
or permission error on that path; add it to `STRICT_ALLOW_HOME` (the configuration
surface listed in rule 6 stays denied whatever you add).

### The tester replay's profile

The tester lane's clean replay runs the tester's own test files, so it asks for
`GAFFER_SANDBOX_PROFILE=replay`. Under `sandbox-exec` that is the gates' validation profile
(no `$GAFFER_DATA` grant beyond the write roots: the replay's checkout, which lives under
`$GAFFER_DATA/worktrees`, and its scratch `HOME`, `TMPDIR` and `PATH` directory; no
`$STRICT_ALLOW_HOME`) with these rules added (so they win):

1. `(deny file-read-data (subpath $GAFFER_DATA))`, then reads allowed back for the
   write roots and the read roots (the dependency links and the repository's git
   directory). Metadata stays readable, so the checkout's own path still resolves.
2. `(deny file-read* file-write* ...)` for HOME's credential and agent folders:
   `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.kube`,
   `~/.docker`, `~/.claude`, `~/.npmrc`, `~/.netrc`, `~/.pypirc`, `~/.git-credentials`,
   cargo's `credentials` files and `~/.gnupg`. The replay's own `HOME` is a scratch
   directory, so nothing it runs needs the real one, and a test cannot plant a hook in
   the agent's settings.

Under `docker` the replay gets the validation layout below. In both, the command runs
with an allowlisted environment (no model credential, no `GAFFER_DATA` or
`DISPATCH_DB`, `wg` and `gaffer` shadowed by refusing stubs, the toolchain locations
such as `CARGO_HOME` and `GOPATH` kept), and when `STRICT_MODE=1`
or `GAFFER_STRICT_REQUIRE=1` asks for a sandbox the host cannot supply, the replay holds
instead of running. `strict-mode.test.sh` asserts the refusals on macOS;
`tester-replay-containment.test.mjs` runs everywhere (the docker path through a fake
`docker`).

## The `docker` provider

`SANDBOX_PROVIDER=docker` runs each agent in a container (`runner/lib/sandbox-docker.sh`,
image `runner/sandbox/Dockerfile`, built by `docker compose --profile sandbox build`):

- **Reads**: only the write and read roots and what the data plane needs are mounted
  (paths mirrored, so the agent sees the same paths as the host). Your home, other
  repos and the canonical databases are not in the container.
- **Egress**: the container sits on an `--internal` network whose only way out is the
  allowlist proxy (`runner/sandbox/egress-proxy`). It is default-deny: the model
  endpoint and package registries pass, and `GAFFER_EGRESS_ALLOW` or
  `$GAFFER_DATA/egress-allow.txt` add hosts without an image rebuild. A request to any
  other host fails at the network layer, by DNS or by raw IP.
- **Privileges**: capabilities dropped, `no-new-privileges`, and CPU, memory and pid
  limits (`GAFFER_SANDBOX_LIMITS="cpus=4 memory=4g pids=512"`, the defaults).
- **Credentials**: only the model credential is forwarded; the rest of the environment
  is scrubbed. If the daemon is down, the run fails closed under strict-require.

### The data plane stays on the host

The dispatch and memory MCP servers do not run inside the container. For each agent
spawn, `lib/worker.sh` (and `lib/worker.mjs`, which decompose, the product owner, the
merge resolver, the tester and onboarding analysis use) runs the same lifecycle:

1. It renders a bridged copy of the runtime MCP config (`lib/mcp-bridge.mjs render`):
   the same server names, each replaced by `node mcp-bridge.mjs connect --socket <sock>
   --server <name>`, with no env. The claim token and database paths never enter the
   container's config.
2. It starts `mcp-bridge.mjs serve` on the host, on a socket in a private mode-700
   temp dir (a unix socket path is capped at 104 bytes on macOS). The servers are
   spawned from the real config, with its env, on first connection.
3. It exports `GAFFER_MCP_BRIDGE_SOCKET`, and the wrapper mounts only the socket (rw),
   the bridged config (ro), the hook's two telemetry ledgers and the crew events log.
   `$GAFFER_DATA` itself is not mounted. The agent's skills are real copies in the
   worktree; a `.claude/skills` symlink in a write root is never followed.
4. It tears the bridge down with the agent.

A bridge that fails to render or start is a refusal to spawn (rc 76), never a bare run.
`GAFFER_MCP_BRIDGE=auto` (the default) is on everywhere except macOS Docker Desktop,
which cannot bind-mount a host unix socket into its VM. There the wrapper falls back
to the legacy layout (the database directory mounted rw with every other entry masked)
and logs a warning naming the gap. `1` or `0` forces it.

| Data-plane mode | When | What of `$GAFFER_DATA` is in the container |
| --- | --- | --- |
| `validation` | `GAFFER_SANDBOX_PROFILE=validation` (the DoD gates and criterion checks) or `replay` (the tester lane's clean replay) | nothing but the worktree, and no model credential; a tester replay gets its proof key's file path, never the key |
| `bridge` | the launcher set `GAFFER_MCP_BRIDGE_SOCKET` | the socket, the bridged config, the telemetry ledgers, the crew events log |
| `none` | no `--mcp-config`, or the launcher declared `GAFFER_SANDBOX_DATA_PLANE=none` | the telemetry ledgers and the crew events log |
| `legacy` | `--mcp-config`, no socket, bridge off | the database directory rw, every non-database entry masked (warned) |
| refused | `--mcp-config`, no socket, bridge on | nothing: the wrapper exits non-zero before any container runs |

The wrapper decides the mode; it never infers one from an absent socket.

### The container's git view

A delivery worktree is a linked worktree of your repository, so its refs live in the
repository's shared `.git`. The container never gets that `.git`. For each linked
worktree the wrapper builds a private git dir on the host (under
`$GAFFER_DATA/sandbox-git/`, outside every write root) and mounts it where the
worktree's `.git` file points:

| Part | In the container |
| --- | --- |
| `HEAD` | the worktree's own branch (or its detached commit) |
| refs | a snapshot of the host's branches, tags and remotes, so `git diff main...` works; every write stays private |
| objects | empty and writable; the host's `.git/objects` is mounted read-only and reached through `objects/info/alternates` |
| `index` | a copy of the worktree's index |
| `config` | written by the wrapper: identity and object format, `core.hooksPath=/dev/null`, `core.fsmonitor=false` |
| the rest of the host's `.git` | not mounted |

When the container exits, the wrapper imports exactly one ref: the worktree's own
branch. It refuses a private dir holding a symlink or special file, re-checks that the
worktree's `.git` file still names its registered git dir, fetches the branch with hooks
off into a scratch ref, checks it is a commit, and moves the host branch with a
compare-and-swap `update-ref` from the value it had when the container started. A
branch that moved on the host meanwhile is kept, and the wrapper exits non-zero naming
it. Tags, `main` and any other ref written inside are dropped. The validation profile
imports nothing, so a gate can never move the branch it validates. On a non-root Linux
host, files the container (root) wrote in its private dir are root-owned, so the
wrapper removes them with a minimal container (no network, only `DAC_OVERRIDE`, only
`$GAFFER_DATA/sandbox-git/` mounted). Landing the branch onto the target is unchanged:
the host does it, after approval.

### How it is tested

- `runner/test/sandbox-docker-containment.test.sh`, on a real daemon: a host secret
  is unreadable, egress to a host off the allowlist is blocked, the model endpoint
  and registry are reachable, the worktree round-trips, and the host's refs and config
  are unreachable while its objects are read-only. It covers the legacy, bridge and
  validation layouts and the refusal.
- `runner/test/sandbox-docker-git-isolation.test.sh`: no `-v` mount in any data-plane
  mode is writable at, or sourced from, a path under `.git`; a commit made inside comes
  back, while `update-ref main`, `branch -f main` and a new tag do not.
- `runner/test/sandbox-docker-delivery.test.sh`: one ticket through the real `tick.sh`
  with `SANDBOX_PROVIDER=docker`, `STRICT_MODE=1`, `GAFFER_STRICT_REQUIRE=1` and the
  bridge on, using the shipped image with a deterministic stub agent installed as its
  `claude`. It checks the agent ran in the container with a working env (git
  `safe.directory`, the proxy, `TMPDIR`, the credential), its `get_ticket` and
  token-free `record_ac_evidence` reached the host database through the bridge, its
  commit came back to the ticket branch while the `main` it moved inside did not, the
  DoD gates ran under the validation profile (a probe in the test command fails the
  gate if it can see a database, the socket, the host `HOME`, a canary or the
  credential), the cost reached the usage ledger, the ticket reached `in_review`, and
  nothing on the host outside the mounts changed.
- `runner/test/sandbox-docker-delivery-seam.test.sh`, its daemon-free twin, runs in the
  normal suite on every OS with a fake `docker` that runs each container on the host. It
  checks the wiring (what each container mounts and is given), not the isolation.

The delivery test needs a Docker daemon and is run by hand on Linux
(`RUN_SANDBOX_DOCKER_TEST=1 bash runner/test/sandbox-docker-delivery.test.sh`). No
daemon means SKIP; `GAFFER_SANDBOX_TEST_REQUIRE=1` turns an image that cannot be built
into a failure. Nothing delivers through the macOS Docker Desktop fallback.

## Prove it with a live agent

The stub proves the plumbing; it cannot prove that the real agent CLI behaves inside
the container. The live variant runs the same delivery with the image's real binary.
It spends real credits, so it only ever runs when you start it.

With a Docker daemon and one credential in the environment (`ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN`, a subscription token from `claude setup-token`):

```bash
pnpm install && pnpm -r build
RUN_SANDBOX_DOCKER_TEST=1 GAFFER_SANDBOX_TEST_REQUIRE=1 GAFFER_LIVE_DOCKER_DELIVERY=1 \
  GAFFER_LIVE_MAX_CALL_USD=2 bash runner/test/sandbox-docker-delivery.test.sh
```

`GAFFER_LIVE_MAX_CALL_USD` is the dollar cap for the agent call, passed as
`--max-budget-usd`. The test refuses anything but a positive dollar figure and checks
the runner resolves it to the flag before any credit is spent. The run also has a $5
daily budget.

The live run keeps every host-side check (the ticket in review, a commit on the branch,
a measured cost in the ledger, the gates contained, the canary untouched). It reports,
but does not require, the agent's own MCP evidence, because a real agent decides what
it runs. Without a credential it fails at once and names the two variables.

## Limits

- The opt-out exists. `GAFFER_STRICT_REQUIRE=0` in the environment runs agents without
  an OS sandbox, and nothing checks that the VM or container you vouched for is there.
- `sandbox-exec`, the macOS default, restricts writes only (see above), and still lets
  the agent write the dispatch and memory databases directly.
- The containment and delivery tests need a Docker daemon, so they run in CI, not on
  every developer machine; the seam test runs everywhere.
- The container runs as root with only `DAC_OVERRIDE`, so on a Linux host the files it
  creates in the worktree are root-owned (the test hands them back with one `chown`
  container).
- The default registry allowlist covers the common registries; a monorepo that pulls
  from others needs them added with `GAFFER_EGRESS_ALLOW`.
- On macOS Docker Desktop the bridge is off and the masked legacy layout applies.
