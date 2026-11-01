# Docker sandbox provider — design & status (the second execution mode)

> Formerly `vm-sandbox-provider.md`. The shipped provider is **docker**; the
> per-ticket microVM described further down is a design sketch with no code behind
> it (the former `lima` provider stub was removed — an unknown provider fails closed
> under `GAFFER_STRICT_REQUIRE=1` and otherwise warns and runs unwrapped).

Status: **P0 built + validated (docker provider), including a full delivery through it
in CI with a stub agent; the same delivery with the real `claude` is an opt-in manual
workflow (see "Prove it on your own fork").** Fills the `docker` case in `runner/lib/sandbox.sh`'s `sandbox_wrap_cmd`
provider seam. Addresses the external security review's #1 ("no real exfiltration
boundary — read + network") — the item no amount of regex/hook hardening can close.

**Built so far** (`SANDBOX_PROVIDER=docker`): the seam `docker` case → `lib/sandbox-docker.sh`
wrapper (path-mirrored mounts, `--internal` network, allowlist-proxy env, credential
scrub) + the `runner/sandbox/egress-proxy` allowlist proxy + a red-team acceptance test
(`runner/test/sandbox-docker-containment.test.sh`). **Verified on real Docker:** host
secret unreadable (not mounted), egress to a non-allowlisted host blocked (DNS *and*
raw-IP), allowlisted model + registry reachable, worktree writable and round-tripping.
The delivery **image** exists (`runner/sandbox/Dockerfile`: node + `claude`), and a whole
delivery through it is tested in CI (`runner/test/sandbox-docker-delivery.test.sh`, the
`sandbox-delivery` job; below). Not done: the per-ticket **microVM** upgrade, a design
sketch, not code.

## Two modes (the framing)

Gaffer offers exactly **two execution postures**, and the operator chooses per the
trust level of the input:

| | **Mode 1 — current (write sandbox)** | **Mode 2 — VM sandbox (new)** |
|---|---|---|
| Boundary | throwaway worktree + deterministic safety hook + *optional* `sandbox-exec` write scoping | a real **VM**: own kernel, own filesystem, own network namespace |
| Writes | scoped to the worktree | physically cannot escape the guest |
| **Reads** | agent can read anything the OS user can | **only what is mounted in** (the repo + runtime state) |
| **Network egress** | unrestricted (`claude` needs the network; we wrap the whole process) | **allowlist only** (model endpoint + package registries) via a host-controlled proxy |
| Host creds / home | on the box, hook-guarded, same-UID reachable | **not present in the guest** |
| Good for | trusted repos, human on the gate (supervised/graduated) | **unattended + untrusted** — the posture autonomy actually needs |
| Selector | `SANDBOX_PROVIDER=sandbox-exec` (default) | `SANDBOX_PROVIDER=docker` |

Mode 1 is honest but limited: it is a *write* sandbox (see `STRICT_MODE.md`). Mode 2
is the boundary a determined or prompt-injected agent is actually contained by. This
composes with the just-landed rule that **any autonomy flag auto-requires an OS
sandbox** — the intended safe unattended config becomes `GAFFER_MODE=autonomous` (or
the flags) **+ `SANDBOX_PROVIDER=docker`**, and the runner fails closed if the VM can't
come up.

## Why a VM, not a container

`sandbox-exec` wraps the *whole* `claude -p` process, so it cannot isolate network
per-subprocess (documented caveat). A container could, but shares the host kernel and
the daemon is another attack surface. A **VM** gives the cleanest story for the threat
we care about — *read host data → encode → send it out*: the guest simply has no host
filesystem and no route to the internet except the allowlist. On macOS this is Lima
(Apple Virtualization / `vz`, or QEMU); on Linux, QEMU / cloud-hypervisor / Firecracker.

## The key enabler: the data plane already works against copies

`runner/.mcp.json` wires **stdio** MCP servers (`dispatch`, `memory`) as child
processes of `claude`, pointed at **runtime DB _copies_** (`${DISPATCH_DB}` /
`${MEMORY_DB}`) plus a runner-held `${GAFFER_CLAIM_TOKEN}`. The runner already
reconciles those copies back to the canonical DBs after delivery. Consequence for the
VM: **the whole MCP data plane runs *inside* the guest** (node + the dist bins + the
DB copies) — there is **no need to forward a live host MCP socket into the VM**. The
runner syncs artifacts in/out at the boundaries it already owns:

```
host: copy worktree + DB copies + dist bins + skills + hook  ──►  guest (mounted RO/RW as appropriate)
guest: claude -p → spawns dispatch/memory MCP (stdio) → writes evidence to the DB copies + commits to the worktree
host: read the worktree branch + DB copies back  ──►  reconcile + review gate (unchanged)
```

## How it plugs into the seam

`sandbox_wrap_cmd` echoes a **command prefix** prepended to `claude -p …`. The `vm`
case echoes a wrapper (`runner/lib/vm-exec.sh` / a small bin) that:

1. ensures a warm guest is up (pool of 1+ ephemeral guests; cold-boot fallback),
2. mounts **only**: the target repo/worktree (RW), `$GAFFER_DATA` runtime copies (RW),
   the built `dist` bins + `runner/skills` + `safety-hook.mjs` (RO),
3. injects **only** the model credential — `ANTHROPIC_API_KEY`, *or* a subscription
   `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, the supported headless-Max
   path), *or* a mounted `~/.claude/.credentials.json` — and nothing else (the env is
   already `env -i` allowlisted; the guest enforces it structurally),
4. execs the wrapped `claude -p …` inside the guest with the translated cwd (worktree),
5. tears the guest down (or returns it to the pool, wiped).

Nothing else in `tick.sh` / config / the profile generator changes — that is the whole
point of the seam. `GAFFER_STRICT_REQUIRE=1` already fails closed if the provider can't
supply containment, so a VM that won't boot refuses the run rather than silently
degrading.

## Egress allowlist (the differentiator)

The guest's only network path is a host-side proxy that permits **only**:
`api.anthropic.com` (model), and the package registries a delivery legitimately needs
(`registry.npmjs.org`, `pypi.org`, … — configurable, default-deny). Everything else is
refused. Because the guest has no other route, `curl evil.com` and DNS-exfil both fail
at the network layer, not at a string check. `--ignore-scripts` on installs still
applies inside.

## MVP → phased

- **P0 — spike (prove it runs).** One `vm` provider (Lima on macOS / QEMU on Linux),
  one real ticket delivered end-to-end *inside* the guest, worktree + evidence synced
  back, review gate unchanged. Egress still open. Goal: the seam + sync loop works.
- **P1 — egress allowlist.** Host proxy, default-deny, model + registries only. Prove
  a delivery that needs `npm ci` still works; prove `curl` to anything else fails.
- **P2 — mount minimisation + red-team.** Confirm the guest sees *only* the repo +
  runtime copies (no `$HOME`, `~/.ssh`, `~/.aws`, sibling repos, canonical DBs). Ship a
  **red-team ticket** as a standing test: a prompt-injected brief that tries to read a
  host secret and POST it out **must fail at both the read (not mounted) and the egress
  (denied)** — this is the acceptance gate for calling Mode 2 real.
- **P3 — lifecycle / performance.** Guest pool + warm-boot (cold VM per ticket is too
  slow), image build/caching, teardown-wipe, resource caps, CI matrix.

## Acceptance criteria (what makes Mode 2 "done")

1. A ticket delivers to `done` end-to-end with `SANDBOX_PROVIDER=docker`, review gate intact.
2. The red-team ticket (read-secret + exfil) **fails closed** — verified, in CI.
3. `GAFFER_MODE=autonomous` + `SANDBOX_PROVIDER=docker` runs unattended; the same config
   **without** the VM refuses to launch (already true via strict-require).
4. Honest docs: `STRICT_MODE.md` + `SECURITY.md` updated to describe Mode 2 as the
   read+egress boundary, Mode 1 as the write sandbox.

## The data plane stays on the host (`lib/mcp-bridge.mjs`)

The dispatch and memory MCP servers do **not** run inside the container. For each
agent spawn under the docker provider, `lib/worker.sh`:

1. renders a **bridged** copy of the runtime MCP config (`mcp-bridge.mjs render`): the
   same server names, each replaced by `node mcp-bridge.mjs connect --socket <sock>
   --server <name>`, with **no env** — the claim token and DB paths never enter the
   container's config;
2. starts `mcp-bridge.mjs serve --socket /tmp/gaffer-mcp.XXXXXX/b.sock --config
   <runtime.json>` on the host (a short private mode-700 dir, because a unix socket
   path is capped at 104 bytes on macOS and `$GAFFER_DATA` can sit under a deep path) (one per spawn; the servers are spawned from
   the real config, with its env, on the first connection for each name);
3. exports `GAFFER_MCP_BRIDGE_SOCKET`, which `sandbox-docker.sh` reads to mount **only
   the socket** (rw), the bridged config (ro), the hook's two telemetry ledgers (rw), the
   crew events log (rw) — `$GAFFER_DATA` itself is not mounted and the DB env vars are
   not forwarded (the agent's skills are real copies inside the worktree, carried by its
   own mount; a `.claude/skills` symlink in a write root is never followed);
4. tears the bridge down with the agent (socket + bridged config removed).

Failure to render or start the bridge is a **refusal to spawn** (rc 76), never a bare
run. The Node launcher (`lib/worker.mjs`, used by decompose, product-owner, merge
resolver, tester and onboarding analysis) runs the identical lifecycle. `GAFFER_MCP_BRIDGE=auto`
(default) is on except on macOS Docker Desktop, which cannot bind-mount a host unix
socket into its VM; there the wrapper falls back to the legacy layout (DB directory
mounted rw, masked) and logs a WARNING naming the gap. Force with `1`/`0`.

### Data-plane modes (decided by the wrapper, never inferred from an absent socket)

| mode | when | what of `$GAFFER_DATA` is in the container |
|---|---|---|
| `validation` | `GAFFER_SANDBOX_PROFILE=validation` — the DoD gates / AC checks (`lib/dod.sh`) | nothing but the worktree; **no model credential** forwarded or mounted |
| `bridge` | `GAFFER_MCP_BRIDGE_SOCKET` set by the launcher | the socket (rw), the bridged config (ro), the hook's telemetry ledgers, the crew events log |
| `none` | no `--mcp-config` in the argv, or the launcher declared `GAFFER_SANDBOX_DATA_PLANE=none` (an empty MCP config) | the hook's telemetry ledgers, the crew events log |
| `legacy` | `--mcp-config` present, no socket, **bridge off** | the DB directory rw with every non-DB entry masked (WARNED) |
| refused | `--mcp-config` present, no socket, bridge **on** | the wrapper exits non-zero before any container runs |

The containment gate covers the legacy round (masking), the bridge round (databases
absent, token absent, MCP round trip over the socket), the validation profile
(databases and credential absent, worktree writable) and the refusal.

## The delivery end to end (`runner/test/sandbox-docker-delivery.test.sh`)

The containment gate above proves the boundary with a shell payload. This test proves
a delivery works through it. One ticket goes through the real `tick.sh` with
`SANDBOX_PROVIDER=docker`, `STRICT_MODE=1`, `GAFFER_STRICT_REQUIRE=1` and the bridge on,
on a real daemon. The image is the shipped one (`runner/sandbox/Dockerfile`) with a
probe file added and, by default, a deterministic stub agent
(`runner/test/lib/docker-delivery-stub.mjs`) installed as its own `claude`, so the
worker seam swaps in the image's binary exactly as it would for the real CLI. What it
checks:

| step | how the test knows |
|---|---|
| the agent runs inside the container | the stub sees `/.dockerenv`, and records it |
| the agent's env works inside | the stub checks git's `safe.directory` (the mounts are owned by the host user, the container runs as root), `HTTP(S)_PROXY` pointing at the egress proxy, a usable `TMPDIR`, and that the model credential reached it (a decoy in this run) |
| the MCP round trip goes through the bridge | the stub's `get_ticket` + token-free `record_ac_evidence` land in the host's canonical DB and satisfy the criterion (only the host-side server holds the claim token) |
| the worktree is written inside | the stub's commit, made through the mounted `.git`, is on the host branch with the stub's probes in its message |
| the DoD gates run under the validation profile | the repo's test command is `node gate-probe.mjs --require && node --test`; the probe fails the gate unless it runs in a container with no database, no bridge socket, no host `HOME`, no canary and no model credential (the runner holds the decoy, so a profile that forwarded it would fail), and the DoD evidence records the gate as PASS with the delivered test in its tally |
| the result envelope is parsed | the usage ledger books the envelope's cost |
| the ticket is submitted | it is `in_review` |
| the host outside the mounts is untouched | from inside, `dispatch.sqlite`, `memory.sqlite` and `settings.json` under `$GAFFER_DATA` are absent, the host `HOME` and a host canary file are unreadable, and a write beside the canary is refused; on the host the canary is unchanged, nothing appeared beside it, and no ref of the host repo but the ticket branch moved or appeared |

It runs in the `sandbox-delivery` CI job, on a GitHub Linux runner (the host user is
not root, the container is), with the containment gate's posture: no daemon means SKIP,
on CI it runs only with `RUN_SANDBOX_DOCKER_TEST=1`, and on a push to main
`GAFFER_SANDBOX_TEST_REQUIRE=1` turns an infra skip (an image that cannot be built) into
a failure. A host that has a daemon but not the built packages, node, git or perl is not
an infra outage: that is a plain SKIP the runner suite's strict mode refuses, and a
failure in the CI job. A failed run uploads its logs, the ticket record and the git log
as the `sandbox-delivery-evidence` artifact. This is the bridge layout of a Linux host;
on macOS Docker Desktop the bridge is off and the masked fallback applies, which no CI
job delivers through. Its daemon-free twin, `runner/test/sandbox-docker-delivery-seam.test.sh`, runs
in the normal suite on every OS: the same world with a fake `docker`
(`runner/test/lib/fake-docker.sh`) that records each container and runs it on the host,
so it checks the wiring (what each container mounts and is given) but not the isolation.

## Prove it on your own fork

The stub proves the plumbing; it cannot prove that the real CLI behaves inside the
container. The live variant runs the same delivery with the image's real `claude`. It
spends real credits, so it never runs on a push or a pull request.

1. Fork the repository and enable Actions on the fork.
2. Add one repository secret under Settings > Secrets and variables > Actions:
   `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (a subscription token from
   `claude setup-token`).
3. In the Actions tab, run **Docker sandbox live delivery**
   (`.github/workflows/sandbox-live.yml`). Its one input, `max_call_usd` (default 2), is
   the dollar cap for the agent call (the runner passes it as `--max-budget-usd`; the
   test refuses to start on anything but a positive dollar figure, and checks the runner
   resolves it to the flag before any credit is spent); the run also has a $5 daily
   budget.

Locally, with a Docker daemon and a credential in the environment:

```bash
pnpm install && pnpm -r build
GAFFER_LIVE_DOCKER_DELIVERY=1 bash runner/test/sandbox-docker-delivery.test.sh
```

The live run keeps every host-side check (the ticket in review, a commit on the branch,
a measured cost in the usage ledger, the gates contained, the canary untouched). It
reports, but does not require, the agent's own MCP evidence, because a real agent
decides what it runs. Without a credential it fails at once and names the two secrets.

The container runs as root with only `DAC_OVERRIDE`, so on a Linux host the files it
creates in the worktree and the git objects it writes are owned by root; the test hands
them back with one `chown` container before it removes its temp dir. A non-root
`--user` with a tmpfs `HOME` is the next hardening step.

## Constraints / open questions

- **Validated in CI, not on every dev machine**: the containment gate and the delivery
  e2e need a Docker daemon (a GitHub ubuntu runner has one); the daemon-free seam test
  runs everywhere.
- Boot latency: cold VM per ticket is likely 10–30s+; a warm pool is probably required
  before this is usable at throughput (P3, but design the pool seam in P0).
- Registry allowlist breadth: monorepos pull from many registries; the default-deny
  list needs a sane, documented, per-repo-overridable default.
- Worktree/object-DB sharing: today the worktree shares the host repo object DB; in the
  guest it must be a self-contained clone or a mounted repo — decide in P0 (mount the
  repo RW is simplest; clone-in is cleaner isolation).
- macOS vs Linux provider parity: one `vm` case or two (`lima` / `qemu`)? Prefer one
  `vm` case that auto-selects the backend, mirroring how `sandbox-exec` hides SBPL.
