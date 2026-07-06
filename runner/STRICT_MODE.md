# Strict execution mode (optional, best-effort OS-level containment)

Strict execution mode is an **optional** extra layer of containment for the live
`claude -p` delivery run. It is **OFF by default** and changes nothing about a
normal run unless you explicitly enable it.

## What it is — and what it is NOT

**It is:** best-effort, OS-level containment layered **on top of** the two
existing safety pillars:

1. **Worktree isolation** — delivery happens in a throwaway git worktree, never
   in a real repo's working tree.
2. **The deterministic PreToolUse safety hook** (`safety-hook.mjs`) — blocks
   writes/branches/reads outside the resolved write/read roots at the tool layer.

Strict mode adds a third, OS-enforced layer that catches the writes the
in-process hook **cannot see** — e.g. a dynamically-constructed path inside a
`python3 -c "…"` the hook allowed, a path written by an exec'd child process, or
a library writing through a syscall path the hook never inspected. With strict
mode on, the **kernel** refuses those writes outside the worktree.

**It is NOT:**

- a security guarantee
- a "secure sandbox"
- a replacement for the worktree isolation or the safety hook
- protection against a determined adversary

It is defence-in-depth: a best-effort net under the existing boundary. Treat it
as "raises the cost of an accidental escape," not "makes escape impossible."

> **A write sandbox, not a jail.** What strict mode bounds today is **writes** —
> where the agent process may create or modify files. It does **not** isolate
> **reads** (the agent can still read anything the OS user can) or **network egress**
> (the wrapped process can still reach the network — `claude` itself needs it). So
> the exfiltration path *read host data → encode it → send it out* is **not** closed
> by strict mode. Think of the current providers as a **write sandbox**; read and
> egress isolation wait on the container/VM providers below (still stubs). This is
> why enabling autonomy defaults `GAFFER_STRICT_REQUIRE=1` but is still "run only
> against input you trust, on a host whose blast radius you accept."

## The provider model (the core design)

Strict mode is built around a **provider seam**, not around any single tool. The
seam is one bash function — `sandbox_wrap_cmd` in `lib/sandbox.sh` — that, given
the resolved write/read roots, echoes a command prefix that wraps the
`claude -p` invocation. Which provider supplies the containment is chosen by
`SANDBOX_PROVIDER`:

| Provider       | Status                        | Behaviour |
|----------------|-------------------------------|-----------|
| `none`         | supported                     | No OS wrapping (worktree + hook still apply). |
| `sandbox-exec` | supported (default)           | Generates an SBPL profile and wraps with `sandbox-exec -f <profile>`. |
| `docker`       | **future** — falls back to none | Warns on stderr, adds no OS containment, does not break the run. |
| `lima`         | **future** — falls back to none | Same as `docker`. |

**Adding a provider = adding one `case` branch in `lib/sandbox.sh`.** Nothing in
`tick.sh`, the config, or the profile generator needs to change. `sandbox-exec`
is simply the provider a spike proved on macOS today.

### `sandbox-exec` is Apple-deprecated

`sandbox-exec` is **deprecated by Apple**. It still works on current macOS and is
useful as the *first* provider, but it is explicitly **a provider, not the
pillar** the design rests on. The provider seam exists precisely so that when
`sandbox-exec` goes away (or when you want stronger isolation), you switch
`SANDBOX_PROVIDER` to a container/VM provider with no changes to the rest of the
runner.

## The network caveat (read this)

Strict mode wraps the **whole** `claude -p` process. That process makes Claude's
own API calls. Therefore network **cannot** be denied without breaking Claude
itself — so `STRICT_ALLOW_NETWORK` defaults to `1` (network allowed).

True per-subprocess network isolation — deny the *agent's child processes*
network while letting *Claude itself* reach the API — is a **future-provider
capability** (docker/lima/VM with per-process network namespaces). A single
whole-process `sandbox-exec` wrap fundamentally cannot offer it. Setting
`STRICT_ALLOW_NETWORK=0` with the `sandbox-exec` provider will break the run; it
exists as an honest, explicit knob, not a recommended setting for that provider.

## Configuration

All knobs live in `factory.config.sh` and are env-overridable per run/per repo.

| Variable             | Default                        | Meaning |
|----------------------|--------------------------------|---------|
| `STRICT_MODE`        | `0`                            | `1` wraps the live agent in the OS sandbox provider. |
| `SANDBOX_PROVIDER`   | `sandbox-exec`                 | Which provider supplies containment (`none`/`sandbox-exec`/`docker`/`lima`). |
| `STRICT_ALLOW_NETWORK` | `1`                          | Allow network inside the sandbox (see caveat — cannot be `0` with `sandbox-exec`). |
| `STRICT_ALLOW_HOME`  | `$HOME/.claude $HOME/.cache`   | Space-separated HOME paths the sandbox may write to (Claude's own state/cache). |

### Enable it for a run

```bash
STRICT_MODE=1 DRY_RUN=0 bash tick.sh
```

### Per-repo configuration

Strict-mode knobs are plain environment variables, so set them however you scope
config — e.g. an `.env` you source before `loop.sh`/`tick.sh`, or a per-repo
wrapper:

```bash
# strict for this repo, default sandbox-exec provider, default allowed HOME paths
export STRICT_MODE=1
# if a repo's tooling needs extra writable HOME state, widen the allow-list:
export STRICT_ALLOW_HOME="$HOME/.claude $HOME/.cache $HOME/.cargo"
```

When strict mode is active, `tick.sh` logs the provider it used (or that the
provider added no containment and the run continued under the existing
boundary).

## What the generated `sandbox-exec` profile allows

The profile (written to `$GAFFER_DATA/strict-profile.sb`) is SBPL, which is
**last-match-wins**:

1. `(allow default)` — reads (and everything) broadly permitted.
2. `(deny file-write*)` — revoke all writes.
3. A single `(allow file-write* …)` re-granting writes only to:
   - each **write-root** (the delivery worktree(s)),
   - `$GAFFER_DATA` (MCP sqlite dbs, agent id/log, the MCP runtime, the profile),
   - temp dirs (`$TMPDIR`, `/private/var/folders`, `/tmp`) — build/test tools need these,
   - each path in `$STRICT_ALLOW_HOME`,
   - `/dev/null`, `/dev/stdout`, `/dev/stderr`.

Read-roots need no special rule: reads are broadly allowed. `process-exec` and
`process-fork` are allowed; network is gated on `STRICT_ALLOW_NETWORK`.

Because temp dirs are intentionally writable (tools genuinely need them), the
meaningful escape strict mode blocks is a write into the human's home, another
repo, or anywhere else outside the worktree + the allow-list above.

## Validation

`test/strict-mode.test.sh` proves, with real temp dirs and a real generated
profile, that under the `sandbox-exec` profile:

- a write **inside** the worktree succeeds,
- a write **outside** the worktree (including a dynamically-constructed path) is
  OS-blocked,
- `python3 -m unittest` still runs,
- the provider seam dispatches correctly (`none`/`docker`/`sandbox-exec`).

```bash
bash test/strict-mode.test.sh
```

### Not yet fully validated: a full live `claude -p` under the profile

The validation above exercises the profile against representative subprocesses
(python writes + a test runner), which is the class of escape strict mode
targets. A full end-to-end `claude -p` run **under** the profile has not been
exhaustively validated here, because Claude Code writes to its own state/cache
paths that vary by host and version. `STRICT_ALLOW_HOME` defaults to
`$HOME/.claude $HOME/.cache` to cover the common cases, but if a live run is
blocked from a path Claude legitimately needs, widen `STRICT_ALLOW_HOME` to
include it (the block will appear in `$GAFFER_LOG` as a `sandbox` / permission
error against a specific path). Tuning that allow-list for your Claude Code
version is the remaining step before relying on strict mode for live runs.
