# Worker providers

Every agent turn the factory takes (a delivery, a review, a clarify pass, a plan, a tester run, a merge resolution) goes through one worker seam: `worker_deliver` in [runner/lib/worker.sh](../runner/lib/worker.sh) for the shell runner and `deliver` in [runner/lib/worker.mjs](../runner/lib/worker.mjs) for the Node launchers. `GAFFER_WORKER_PROVIDER` picks what that seam runs.

| Value | What runs | Containment |
|---|---|---|
| `claude-code` (default) | `claude -p … --output-format json` | the in-process PreToolUse safety hook, plus the OS sandbox when it's on or required |
| `command` | your own program, `GAFFER_WORKER_COMMAND` | the docker sandbox with the host-side MCP bridge, always (see below) |
| anything else | nothing: the launch refuses with exit 70 | n/a |

Both real providers get the same treatment at the seam: the same budget admission before every paid launch (no dollar cap, or a spent one, means no spawn and exit 77), the same scrubbed environment, the same sandbox wrap at every spawn site, the same wall-clock timeout, and the same MCP bridge under the docker sandbox. What the program returns is turned into the same envelope the runner already reads, so the usage ledger, the turn-cap and budget-cap pauses and the gates work the same way for both.

## The command provider

I added `command` so you can put a different agent behind the factory without patching the runner. You write a small program (a wrapper around another CLI, or an agent of your own), point `GAFFER_WORKER_COMMAND` at it, and the factory runs it in place of `claude -p`.

```bash
export GAFFER_WORKER_PROVIDER=command
export GAFFER_WORKER_COMMAND=/opt/my-worker/run      # absolute path, executable, owned by you
export SANDBOX_PROVIDER=docker                       # the one sandbox that counts for it
export GAFFER_WORKER_COMMAND_ENV="MY_MODEL_API_KEY"  # its own credential
export GAFFER_WORKER_COMMAND_COST_USD=0.25           # the least each call is booked at
```

These knobs are read from the environment only. `$GAFFER_DATA/settings.json` can't set `GAFFER_WORKER_PROVIDER`, `GAFFER_WORKER_COMMAND`, `GAFFER_WORKER_COMMAND_ENV`, `GAFFER_WORKER_COMMAND_COST_USD` or `GAFFER_SANDBOX_WORKER_COMMAND`, and the dashboard's Settings panel doesn't offer them: a file in the data directory must never be able to choose which program runs every agent turn or which secrets it gets.

### Every lane uses it

Under `GAFFER_WORKER_PROVIDER=command` no lane calls `claude`. The delivery, bootstrap, rework, reviewer and security reviewer, clarify, eval judge, the greenfield repo classifier (`inherit`), the planner (`decompose`), the spec author, the product owner, the tester, the merge-conflict resolver and the onboarding analysis all go through the seam, so they all run your program under the same contract. Each call says which lane it is in `GAFFER_WORKER_KIND`. The only `claude` invocation left is `runner/preflight.sh` printing `claude --version`, which is free and informational; the login probe is skipped.

### Containment: why it needs the docker sandbox

The safety hook that keeps a `claude-code` agent's writes inside its worktree runs inside `claude -p` itself. Your program doesn't have it. Nothing the runner can add from outside replaces an in-process hook, so the only boundary left is the OS, and only one of the OS boundaries holds without the hook:

- **`SANDBOX_PROVIDER=docker`, with the MCP bridge on.** The container sees the worktree, the factory's code (read-only) and, from `$GAFFER_DATA`, only the bridge socket, this call's MCP config and prompt file (read-only) and the hook's two telemetry ledgers. The dispatch and memory databases, `settings.json`, the usage ledger and the other workers' claim tokens aren't in it, and egress goes through the allowlist proxy. The bridge is on by default on Linux (`GAFFER_MCP_BRIDGE=auto`).
- **`sandbox-exec` doesn't count.** Its profile restricts writes only, and it still grants writes under `$GAFFER_DATA` ([SECURITY.md](../SECURITY.md), the `sandbox-exec` profile limit): `settings.json`, the databases, the usage ledger. For `claude-code` the hook refuses those writes; for a command worker nothing would. The seam refuses it with exit 75.
- **docker without the bridge doesn't count either.** With `GAFFER_MCP_BRIDGE` off (the macOS default, because Docker Desktop can't mount a host socket) the databases are mounted read-write into the container, where your program could change ticket state directly. The seam refuses that too. On macOS, run the runner in a Linux VM, or force `GAFFER_MCP_BRIDGE=1` if your Docker setup can mount the socket.

How it's enforced:

- Setting `GAFFER_WORKER_PROVIDER=command` defaults `GAFFER_STRICT_REQUIRE=1` and `STRICT_MODE=1`, the same way the autonomy flags do. A tick checks the rule before it composes the wrap: where it doesn't hold, the ticket is parked `strict_require_unavailable` before anything runs (not counted as a failed attempt), and the reason is logged.
- The seam enforces the rule on its own as well, whatever `GAFFER_STRICT_REQUIRE` says, so a Node launcher the dashboard starts (Plan a build, Suggest work, the tester) can't slip past it. It also refuses a wrap a caller composed that isn't the docker wrapper. The refusal is exit 75 and names the fix.
- If you already contain the whole runner (it runs in a VM or a container you trust), set `GAFFER_STRICT_REQUIRE=0` **in the environment**. The worker then runs, and the runner prints a `WARNING:` line when the config loads and again at every spawn. Only an explicit `0`, `false`, `no` or `off` counts: unset, empty or anything else keeps the requirement, and a `GAFFER_STRICT_REQUIRE=0` in `settings.json` is ignored under this provider.

Under docker the program has to exist inside the image: by default the seam runs the same path, which works when the program lives under the runner directory (mounted read-only at its host path). Set `GAFFER_SANDBOX_WORKER_COMMAND` when the image keeps it somewhere else.

### Where the program may live

The program runs every agent turn, so an agent must never be able to rewrite it. The seam refuses (exit 70) a `GAFFER_WORKER_COMMAND` that:

- isn't an absolute path to an executable file;
- lives under `$GAFFER_DATA` (the delivery worktrees are there), under any write root of the call or under its working directory, checked on the path as written, with its directory's symlinks resolved and fully resolved, so a symlink inside a worktree that points somewhere safe is refused too (the agent could re-point it);
- is writable by its group or by others, or sits in a directory anyone can write that isn't sticky.

Keep it somewhere like `/opt/my-worker/` or `~/bin/`, owned by you, mode `755`.

### What the program receives

It's run with no arguments, in the call's working directory (the ticket's worktree for a delivery, the reviewer's worktree for a review, a throwaway agent home for planning), with stdin empty, inside the sandbox wrap and under the tick's timeout.

Its environment starts empty (`env -i`, inside the container under docker) and gets the same allowlist a `claude-code` agent gets (the working shell, locale, proxy and trust-store settings, the `GAFFER_*` knobs, the boundary variables), minus the `claude-code` auth and config surface (`ANTHROPIC_*`, `CLAUDE_*`). Token, key and secret variables are stripped. Under docker, `HOME` is `/root` and `PATH` the image's (`GAFFER_SANDBOX_HOME`, `GAFFER_SANDBOX_PATH`), and the docker wrapper forwards no `claude` credential into a command worker's container.

To hand the program its own credential, name it in `GAFFER_WORKER_COMMAND_ENV` (space-separated). The runner's own secrets are never passed even if you name them: `DISPATCH_API_TOKEN`, `GAFFER_CLAIM_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN` and the notify and webhook settings. Anything else you name is passed as is, so think before you list a credential: everything the worker runs can read it, including the tests and scripts of the repository it's working in, and its value is part of the `env` argv the runner starts (visible in the host's process list for the life of the call). If you list `ANTHROPIC_API_KEY`, your program gets your `claude-code` key.

The call's inputs ride these variables. An empty value means "not set for this call".

| Variable | Meaning |
|---|---|
| `GAFFER_WORKER_CONTRACT` | `1`, the contract version |
| `GAFFER_WORKER_PROMPT_FILE` | path to a private file (mode 600, read-only under docker) holding the rendered prompt, the same text `claude -p` would get. Always set. The runner removes it when the call ends |
| `GAFFER_WORKER_PROMPT` | the same prompt inline, but only when it's 64 KiB or less; empty otherwise. One environment string is capped at 128 KiB on Linux and macOS caps the whole argv plus environment near 1 MiB, so a long prompt with big context blocks would fail to start the program at all. Read the file |
| `GAFFER_WORKER_MCP_CONFIG` | path to the MCP config, in the usual `{"mcpServers": {name: {command, args, env}}}` shape. Under docker it's the bridged copy: each server is a `mcp-bridge.mjs connect` stub to the host-side server, and it carries no token |
| `GAFFER_WORKER_MODEL` | the model the router chose, a hint; empty means your default |
| `GAFFER_WORKER_MAX_TURNS` | the turn cap for this call, a hint |
| `GAFFER_WORKER_MAX_BUDGET_USD` | the per-call dollar cap (`GAFFER_MAX_CALL_USD`, clamped to the remaining budget), a hint |
| `GAFFER_WORKER_TOOLS` | `all`, or `none` for a text-only call (the eval judge, the repo classifier) |
| `GAFFER_WORKER_ALLOWED_TOOLS` / `GAFFER_WORKER_DISALLOWED_TOOLS` | the tool names a planning launcher allows or denies, space-separated hints |
| `GAFFER_WORKER_KIND` | which launcher: `delivery`, `review`, `clarify`, `bootstrap`, `inherit`, `eval-judge`, `decompose`, `spec-author`, `tester`, … |
| `GAFFER_WORKER_TIMEOUT_SECS` | the wall-clock bound the runner enforces |

The per-call boundary variables come along too: `GAFFER_WRITE_ROOTS`, `GAFFER_READ_ROOTS`, `GAFFER_DATA`, `GAFFER_TICKET` and the database paths, the same as for `claude-code`.

**What to do with the MCP config.** Start each server it names with its `command`, `args` and `env` and talk MCP to it over stdio, the way any MCP client does; that's how the agent reads its ticket and records evidence. Don't read the `env` block for anything else. Outside docker (only under the `GAFFER_STRICT_REQUIRE=0` opt-out) the config is the raw one, and the dispatch server's `env` carries this ticket's claim token, exactly as `claude-code` gets it; under docker the token stays host-side in the bridge.

The hints are hints. The runner can't make your program honour a turn cap or a tool list, which is part of why the OS sandbox is mandatory. What it does enforce from outside is the wall-clock timeout, the dollar caps between calls, and every gate after the call.

### What the program returns

One JSON object on stdout. Log lines before it are fine (the last top-level JSON object wins), but logs belong on stderr, which is appended to the factory log and never parsed. The runner reads at most the last 16 MiB of stdout. Every field is optional:

```json
{
  "result": "Added DELIVERED.txt and a test.",
  "stop_reason": "end_turn",
  "cap_hit": false,
  "num_turns": 6,
  "duration_ms": 41000,
  "cost_usd": 0.12,
  "model": "my-model-name",
  "usage": { "input_tokens": 1200, "output_tokens": 340 }
}
```

| Field | Type | Default when absent | What the runner does with it |
|---|---|---|---|
| `result` | string | `""` | the agent's text: logged, and read by the reviewer verdict, the tester verdict, the judge and the resume report |
| `stop_reason` | string (200 chars kept) | none | a value naming the turn cap (`max_turns`, `turn limit`) counts as a cap hit; one naming the budget cap (`max_budget`) as a budget stop |
| `cap_hit` | boolean | `false` | `true` is a turn-cap stop: a delivery that has commits pauses for your Continue, exactly like a `claude-code` turn-cap stop, whatever the exit code |
| `num_turns` | number, 0 or more | unknown | recorded on the ledger row; counts toward the turn-cap detection (`GAFFER_CAP_DETECT_TURNS`) |
| `duration_ms` | number, 0 or more | unknown | recorded on the ledger row |
| `cost_usd` | number, 0 or more | unknown | the cost you report, booked as described below |
| `model` | string (80 chars, safe characters) | none | names the serving model on the ledger row and the attempt's evidence |
| `usage` | object of numbers: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | unknown | token counts on the ledger row |

Other fields are ignored. Every row the command provider writes carries `worker_provider: "command"`.

**The cost is your program's word, and the caps count it.** The daily and lifetime caps are the runner's only spend control over a program it can't see inside, so the runner books every call at no less than a per-call floor:

- the floor is `GAFFER_WORKER_COMMAND_COST_USD` when you set it; else this call's dollar cap (`GAFFER_WORKER_MAX_BUDGET_USD`) when it has one; else `GAFFER_KILL_ESTIMATE_USD` (default `0.05`);
- a reported cost at or above the floor is booked as reported (`cost_basis: "reported"`);
- a cost below the floor, or none at all, is booked at the floor (`cost_basis: "floor"`), with your figure kept beside it as `reported_cost_usd` (or `"unknown"`);
- `GAFFER_WORKER_COMMAND_COST_USD=0` means you trust the program's own figure: an unreported cost is then `"unknown"` (`cost_basis: "unreported"`) and counts as $0, so only do that for a worker whose reports you'd bet the budget on.

Stdout with no JSON object at all is read like a crashed call: the ledger books the conservative kill estimate.

Two outcomes a `claude-code` envelope can signal are not available to a command worker: a usage-window refusal and an authentication failure. Both release the ticket without counting an attempt, and a program the agent may have influenced must not be able to buy that. A command worker that hits its own rate limit should exit non-zero; the call then counts as a failed attempt.

### Exit codes

| Exit | Meaning |
|---|---|
| `0` | the call finished. The runner's gates still decide whether the work is done |
| non-zero | the call failed, counted like a crashed `claude -p`. An envelope printed anyway is still read: `cap_hit` still pauses, and the call is booked at the larger of its (floored) cost and the kill estimate |
| `124` | reserved: the runner's own wall-clock kill. Don't use it |
| `70`, `75`, `76`, `77` | reserved for the runner's own refusals. A program that exits with one is recorded as exit `1` |

### Timeouts

The shell runner sends the program's whole process group `TERM` at `GAFFER_TICK_TIMEOUT` and `KILL` after `GAFFER_REAP_GRACE` seconds. The Node launchers run it in its own process group and send that group `KILL` at their timeout. So anything your program started goes with it. Under docker the process killed is the `docker run` client; see [SECURITY.md](../SECURITY.md) for what that means for the container.

### Testing your program

[runner/test/fixtures/command-worker.mjs](../runner/test/fixtures/command-worker.mjs) is a small worker that reads the contract, commits a change in the worktree, calls the dispatch MCP server the way an agent's MCP client does, and prints the envelope. [runner/test/worker-command.test.sh](../runner/test/worker-command.test.sh) runs it through a real `tick.sh` delivery, under the real docker wrapper with a stand-in `docker` and the real host-side MCP bridge, all the way to review. `runner/preflight.sh` checks that `GAFFER_WORKER_COMMAND` is an executable an agent can't rewrite and whether the sandbox rule holds.
