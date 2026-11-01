# Worker providers

Every agent turn the factory takes (a delivery, a review, a clarify pass, a plan, a tester run, a merge resolution) goes through one worker seam: `worker_deliver` in [runner/lib/worker.sh](../runner/lib/worker.sh) for the shell runner and `deliver` in [runner/lib/worker.mjs](../runner/lib/worker.mjs) for the Node launchers. `GAFFER_WORKER_PROVIDER` picks what that seam runs.

| Value | What runs | Containment |
|---|---|---|
| `claude-code` (default) | `claude -p … --output-format json` | the in-process PreToolUse safety hook, plus the OS sandbox when it's on or required |
| `command` | your own program, `GAFFER_WORKER_COMMAND` | an OS sandbox, always (see below) |
| anything else | nothing: the launch refuses with exit 70 | n/a |

Both real providers get the same treatment at the seam: the same budget admission before every paid launch (no dollar cap, or a spent one, means no spawn and exit 77), the same scrubbed environment, the same sandbox wrap at every spawn site, the same wall-clock timeout, and the same MCP bridge under the docker sandbox. What the program returns is turned into the same envelope the runner already reads, so the usage ledger, the turn-cap and budget-cap pauses and the gates work the same way for both.

## The command provider

I added `command` so you can put a different agent behind the factory without patching the runner. You write a small program (a wrapper around another CLI, or an agent of your own), point `GAFFER_WORKER_COMMAND` at it, and the factory runs it in place of `claude -p`.

```bash
export GAFFER_WORKER_PROVIDER=command
export GAFFER_WORKER_COMMAND=/opt/my-worker/run   # absolute path, executable
export SANDBOX_PROVIDER=docker                    # it needs an OS sandbox
export GAFFER_WORKER_COMMAND_ENV="MY_MODEL_API_KEY"  # its own credential
```

### Containment: why it needs an OS sandbox

The safety hook that keeps a `claude-code` agent's writes inside its worktree runs inside `claude -p` itself. Your program doesn't have it. Nothing the runner can add from outside replaces an in-process hook, so the only boundary left is the OS: the command provider refuses to launch without an active sandbox wrap.

- Setting `GAFFER_WORKER_PROVIDER=command` defaults `GAFFER_STRICT_REQUIRE=1` and `STRICT_MODE=1`, the same way the autonomy flags do. Where no OS sandbox is available, the tick parks the ticket as `strict_require_unavailable` before anything runs, and says the command provider is why.
- The seam enforces the rule on its own as well, whatever `GAFFER_STRICT_REQUIRE` says, so a Node launcher the dashboard starts (Plan a build, Suggest work, the tester) can't slip past it. The refusal is exit 75 with this fix: set `SANDBOX_PROVIDER=docker` with a running docker daemon (or `SANDBOX_PROVIDER=sandbox-exec` on macOS).
- If you already contain the whole runner (it runs in a VM or a container you trust), set `GAFFER_STRICT_REQUIRE=0` explicitly. The worker then runs, and the runner prints a `WARNING:` line when the config loads and again at every spawn. Only an explicit `0`, `false`, `no` or `off` counts: unset, empty or anything else keeps the requirement.

`SANDBOX_PROVIDER=docker` is the one I'd use: it gives read and egress isolation as well as write isolation. macOS `sandbox-exec` only restricts writes. Under docker, the program has to exist inside the image: by default the seam runs the same path, which works when the program lives under the runner directory or a write root (both are mounted at their host paths). Set `GAFFER_SANDBOX_WORKER_COMMAND` when the image keeps it somewhere else.

### What the program receives

It's run with no arguments, in the call's working directory (the ticket's worktree for a delivery, the reviewer's worktree for a review, a throwaway agent home for planning), with stdin empty, inside the sandbox wrap and under the tick's timeout.

Its environment is the same allowlist a `claude-code` agent gets (the working shell, locale, proxy and trust-store settings, the `GAFFER_*` knobs, the boundary variables), minus the `claude-code` auth and config surface (`ANTHROPIC_*`, `CLAUDE_*`). Token, key and secret variables are stripped. To hand the program its own credential, name it in `GAFFER_WORKER_COMMAND_ENV` (space-separated). The runner's own secrets are never passed even if you name them: `DISPATCH_API_TOKEN`, `GAFFER_CLAIM_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN` and the notify and webhook settings.

The call's inputs ride these variables. An empty value means "not set for this call".

| Variable | Meaning |
|---|---|
| `GAFFER_WORKER_CONTRACT` | `1`, the contract version |
| `GAFFER_WORKER_PROMPT` | the rendered prompt, the same text `claude -p` would get |
| `GAFFER_WORKER_MCP_CONFIG` | path to the MCP config (the dispatch and memory servers, with the claim token in the server's own env block). Under docker it's the bridged copy |
| `GAFFER_WORKER_MODEL` | the model the router chose, a hint; empty means your default |
| `GAFFER_WORKER_MAX_TURNS` | the turn cap for this call, a hint |
| `GAFFER_WORKER_MAX_BUDGET_USD` | the per-call dollar cap (`GAFFER_MAX_CALL_USD`), a hint |
| `GAFFER_WORKER_TOOLS` | `all`, or `none` for a text-only call (the eval judge) |
| `GAFFER_WORKER_ALLOWED_TOOLS` / `GAFFER_WORKER_DISALLOWED_TOOLS` | the tool names a planning launcher allows or denies, space-separated hints |
| `GAFFER_WORKER_KIND` | which launcher: `delivery`, `review`, `clarify`, `bootstrap`, `decompose`, `tester`, … |
| `GAFFER_WORKER_TIMEOUT_SECS` | the wall-clock bound the runner enforces |

The per-call boundary variables come along too: `GAFFER_WRITE_ROOTS`, `GAFFER_READ_ROOTS`, `GAFFER_DATA`, `GAFFER_TICKET` and the database paths, the same as for `claude-code`.

The hints are hints. The runner can't make your program honour a turn cap or a tool list, which is part of why the OS sandbox is mandatory. What it does enforce from outside is the wall-clock timeout, the dollar caps between calls, and every gate after the call.

### What the program returns

One JSON object on stdout. Log lines before it are fine (the last top-level JSON object wins), but logs belong on stderr, which goes to the factory log. Every field is optional:

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

| Field | Default when absent | What the runner does with it |
|---|---|---|
| `result` | `""` | the agent's text: logged, and read by the reviewer verdict, the tester verdict and the resume report |
| `stop_reason` | none | a value naming the turn cap (`max_turns`) counts as a cap hit; one naming the budget cap (`max_budget`) as a budget stop |
| `cap_hit` | `false` | `true` pauses a delivery that has commits for your Continue, like a turn-cap stop |
| `num_turns`, `duration_ms` | unknown | recorded on the ledger row |
| `cost_usd` | unknown | relayed to the ledger verbatim and counted against the daily and lifetime caps |
| `model` | none | names the serving model on the ledger row and the attempt's evidence |
| `usage` | unknown | token counts on the ledger row |

The runner never invents a figure. A cost you don't report is recorded as `"unknown"` with `cost_basis: "unreported"` and counts as $0 against the caps, so report it if you want the caps to mean anything. Every row the command provider writes carries `worker_provider: "command"`. Stdout with no JSON object at all is read like a crashed call: the ledger books the conservative kill estimate.

Two outcomes a `claude-code` envelope can signal are not available to a command worker: a usage-window refusal and an authentication failure. Both release the ticket without counting an attempt, and a program the agent may have influenced must not be able to buy that. A command worker that hits its own rate limit should exit non-zero; the call then counts as a failed attempt.

### Exit codes

| Exit | Meaning |
|---|---|
| `0` | the call finished. The runner's gates still decide whether the work is done |
| non-zero | the call failed, counted like a crashed `claude -p` |
| `124` | reserved: the runner's own wall-clock kill. Don't use it |
| `70`, `75`, `76`, `77` | reserved for the runner's own refusals. A program that exits with one is recorded as exit `1` |

### Testing your program

[runner/test/fixtures/command-worker.mjs](../runner/test/fixtures/command-worker.mjs) is a small worker that reads the contract, commits a change in the worktree, calls the dispatch MCP server the way an agent's MCP client does, and prints the envelope. [runner/test/worker-command.test.sh](../runner/test/worker-command.test.sh) runs it through a real `tick.sh` delivery, under a stand-in sandbox, all the way to review. `runner/preflight.sh` checks that `GAFFER_WORKER_COMMAND` is an executable and says whether the sandbox requirement is on.
