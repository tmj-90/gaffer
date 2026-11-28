# Security model

Gaffer runs shell-capable agents on your machine, against your repos, with your
model credential. That is useful and it is risky. This page says what protects you,
how each protection is tested, and where the limits are. Read it before you point
Gaffer at anything you don't fully trust.

## Threat model

You are trusting a model-driven agent with a shell. Its inputs (ticket text, repo
contents, ingested issues, an onboarded repo) may be attacker-influenced, and the
agent itself may be prompt-injected. What it could go after:

- **The host**: your files, your credentials, other repos, the network.
- **The control plane**: the dispatch and memory databases, the settings file and
  the ledgers that decide what runs and what ships.
- **What ships**: the review verdict, the gates, the tester's verdict and the
  landing on your default branch.
- **Your money**: the model credential and the spend caps.

Gaffer's job is to contain what the agent can do and to keep a human in the loop on
anything that ships. In the default supervised mode the human review gate is the
last line; for unattended runs the OS sandbox is.

**Default host isolation.** The host is protected by default, not only when you turn
autonomy on: every agent launch, in every mode, runs inside an OS sandbox
(`GAFFER_STRICT_REQUIRE` defaults to 1, `STRICT_MODE` with it). The provider is
auto-detected (`sandbox-exec` on macOS, `docker` where the docker CLI is installed). On a
host that cannot supply one, `gaffer run`, the loop, every live tick and the dashboard's
Poll for work refuse before they claim anything, and the worker seams (bash and Node)
refuse each spawn, so no path launches an agent unwrapped by accident. The only way to
run without it is `GAFFER_STRICT_REQUIRE=0` in the environment, which settings.json
cannot set, and which the runner states loudly once per process.

## What is enforced and how it is tested

Test files are under `runner/test/` (`.sh`, `.mjs`) or `packages/*/test/` (`.ts`).

| Control | Enforces | Tested by | Does not cover |
| --- | --- | --- | --- |
| Safety hook | Writes only in the worktree, no secret reads, no control-plane CLI or raw DB access, no base-branch ref rewrites, no git config or hook edits; fails closed | `safety-hook*.test.mjs` (with `safety-hook-golden-corpus.test.mjs`, every verdict pinned), the crew parity tests | A compiled binary or a script the agent writes and runs |
| Throwaway worktrees | Delivery never touches your checkout; teardown removes only what the run owns | `cleanup-ownership.test.sh`, `crash-cleanup.test.sh` | A narrow teardown race (residual limits) |
| Agent files in the worktree | The runner's host-side writes into a worktree (settings, brief, skills, `node_modules` links) never follow a symlink or leave it; a committed link parks the ticket with the path; one settings rule for shell and Node | `worktree-write-safety.test.sh`, `worktree-write-safety.test.mjs`, `worktree-link-refusal.test.sh`, `agent-settings-rule.test.mjs` | A path changed between the check and the rename by another process on the host |
| Runner git | The runner's own git never runs repository hooks, drivers or helpers | `git-hooks-host.test.sh` | |
| Agent environment | Built from an allowlist; credential env vars stripped; CLI credential stores are secret paths | `agent-env-scrub.test.sh`, `safety-hook-credentials.test.mjs` | Credentials outside the listed stores while `HOME` is shared |
| Prompt quarantine | Untrusted text reaches every agent inside `<untrusted-*>` envelopes, every `<` escaped; MCP answers too | `prompt-quarantine.test.sh`, `untrusted-escape.test.mjs`, `rework-feedback-quarantine.test.sh`, `mcp-decision-quarantine.test.ts` | A model can still be persuaded by data |
| Review gate | Human approval by default, reviewer is not the author, approval pins the reviewed commit of every write repo | `review-gate-self-approval.test.ts`, `review-stale-revision-landing.test.ts`, `review-pin-human-approval.test.ts` | The opt-in autonomy flags remove it by design |
| Definition of Done | The runner runs tests, typecheck, lint and checked criteria; a red gate goes back to rework | `dod-gate.test.sh` | It is a quality gate, not a security boundary |
| Gate integrity | Base commit recorded at cut; gate scripts read from it; weakened tests flagged and held | `gate-integrity.test.sh`, `gate-integrity-e2e.test.sh` | It flags, it does not fail; see its limits |
| Merge gate | Gates rerun on the merge with the current target; lands only that commit, only while the target is unchanged | `e2e-release-gate-merge-combination.test.sh`, `landing-integrity.test.ts` | |
| Tester replay | The tester's named tests must run and pass on the tested commit and on what lands | `land-tester-replay*.test.sh`, `tester-replay-proof.test.mjs` | What the tests assert; a deliberate attack on the replay |
| Clean replay containment | The tester's test files run in the gate sandbox seam (`replay` profile) with no model credential, `GAFFER_DATA` or `DISPATCH_DB` in the environment and `wg` shadowed on `PATH`; strict mode without a sandbox holds; the proof key is a file the reporter unlinks, never an environment variable | `tester-replay-containment.test.mjs`, `tester-run.test.mjs`, `strict-mode.test.sh` (macOS), `sandbox-docker-mounts.test.sh` | With no sandbox configured, the factory's files by path; reads outside `$GAFFER_DATA` and HOME's secret folders under `sandbox-exec`; code that runs before the node:test reporter loads (a loader module, the registered command's own steps, a wrapper's non-node:test runner) reading the key file |
| Acceptance profiles | Commands a person registered behave as registered on the tested commit | `acceptance-profiles.test.ts`, `tester-acceptance.test.mjs` | Whether those commands cover the criteria |
| Required CI | No recorded PASS for the exact commit is a hold | `ci-required-before-review.test.ts`, `h3-ci-gate.test.sh` | |
| Landing | Never overwrites an ignored local file; a revocation stops every landing not yet started | `land-ignored-file.test.sh`, `revocation-safe-landing.test.ts` | A landing already started is reported, not undone |
| OS sandbox (`docker`) | Read and egress isolation; data plane on the host; private git dir | `sandbox-docker-containment.test.sh`, `sandbox-docker-mounts.test.sh`, `sandbox-docker-git-isolation.test.sh`, `sandbox-docker-delivery.test.sh` | A live agent inside it is proven only where you run it |
| OS sandbox (`sandbox-exec`) | Writes only in the allowed roots; under `$GAFFER_DATA` only the databases, the crew events log and the hook's ledgers (the agent) or nothing but the worktree (the gates); never `settings.json`, the usage pause, the ledgers, the runner's state, the generated profiles or the agent CLI's user configuration | `strict-mode.test.sh` (macOS), `sandbox-exec-data-plane.test.sh`, `sandbox-exec-agent-config.test.sh` (profile meaning on every host, the kernel on macOS) | Reads, egress, the agent writing the databases directly; hard-link and rename behaviour is proven by the macOS sections only |
| Settings loader | `settings.json` sets only the keys the dashboard API writes; anything else (NODE_OPTIONS, BASH_ENV, DYLD_*, CLAUDE_BIN, CLAUDE_FLAGS, the gate sandbox opt-out...) is ignored and named | `settings-allowlist.test.sh`, `settings.test.ts` (the two lists pinned) | A person who sets an autonomy or budget key through the dashboard |
| Gate environment | Every gate run starts from `env -i`: no model key, no `*_TOKEN`/`*_KEY`/`*_SECRET`, no `DISPATCH_*`, no principal token, on every provider and with no sandbox | `dod-sandbox-wrap.test.sh` | What a test reads from the files it can read |
| Default host isolation | `GAFFER_STRICT_REQUIRE=1` in every mode; no working sandbox means no launch, refused before any claim with the fix | `isolation-default.test.sh`, `strict-require.test.sh`, `autonomy-containment.test.sh` | `GAFFER_STRICT_REQUIRE=0` in the environment (never settings.json) |
| Research runs | The one agent with the web: only WebSearch and WebFetch (launcher flags, a research role in the hook, an empty home); https only, no IP literals or internal names, no login, sign-up or account step, no credential-shaped query, length caps; 40 fetches, 20 searches, 25 sites; an append-only record; its own docker egress profile; a strict result schema; plain-text rendering; person-only writes | `research-url-rules.test.mjs`, `research-hook.test.mjs`, `research-run.test.mjs`, `sandbox-docker-research-seam.test.sh`, `gaffer-research.test.sh`, `research.test.ts`, `research-url-rules.test.ts`, `web-research.test.ts`, the `s26-research` browser suite | The idea and queries go to the search provider and every site fetched; a hostile page can slant the findings; DNS can change between check and use; macOS has no network sandbox |
| Planning agents and scout | Read-only tool sets, safety-hook settings verified before spawn | `security-md-planning-agents.test.mjs`, `scout-gather.test.sh` | |
| Replay manifests and experiments | Manifests hold ids, commits, settings and hashes, never prompt text or credentials (mode 600, 16 KiB cap); the experiment runner is denied to agents in every launch form and its live mode needs a hard USD cap | `replay-manifest.test.sh`, `eval-experiment.test.sh`, `safety-hook-spelling.test.mjs` | |
| Command worker | Runs only inside the `docker` sandbox with the bridge | `worker-command.test.sh` | Turn and tool caps are hints |
| Dashboard and API | Bearer token on every data request, loopback by default, named principals with scopes, each signed with the factory key | `api-auth.test.ts`, `api-auth-loopback-hardening.test.ts`, `api-principal-scopes.test.ts`, `principal-seal.test.ts`, `landing-principal-seal.test.ts` | No TLS; a tokenless CLI is operator trust |
| Sealed autonomy | A policy row, a ticket's risk and a lift of a step-down count only with a seal under the factory key; an unsigned row grants nothing, an unsigned risk is decided as the highest; re-signing is a person's act; a verified checkpoint bounds the cost | `autonomy-seal.test.ts`, `autonomy-seal-resign.test.ts`, `autonomy-seal-checkpoint.test.ts`, `autonomy-sealed.test.sh`, `safety-hook-spelling.test.mjs` | A low risk stated by the ticket's creator before its first claim; events a keyless process wrote since the last anchor |
| Claims and logs | Claim tokens stored as hashes; hash-chained event log; content-redacted audit logs | `m2-claims.test.ts`, `event-chain.test.ts`, `audit.test.ts` | The chain has no key |
| Budget | A live run needs a dollar cap; caps reserved atomically; only the CLI can report a usage limit | `budget-admission.test.sh`, `lifetime-budget-gate.test.sh`, `usage-limit-detect.test.mjs` | One long call can overshoot |
| Notifications | SSRF policy, redacted bodies, URLs never returned | `notify.test.ts` | Endpoints you choose |
| Memory | Agent suggestions are drafts; drafts invisible to agents; restricted records gated | `mcp-redaction.test.ts`, `memory-auto-approve-docs.test.mjs` | `restricted` is not encryption |
| Onboarding | Reads stay inside the repo; credentials stripped from remote URLs | `onboard-boundary.test.sh` | |
| Repository checks | Dependency audit, shellcheck, containment gate, browser regression, config drift | run by hand, see `docs/testing.md` | No hosted CI runs them; CodeQL and the gitleaks scan went with the workflows |

The crew safety policy (`safety_policy.yaml`) is **not** enforced at runtime. It
drives crew's advisory classifier only; see [the safety hook](#the-safety-hook).

## The controls

### The safety hook

`runner/safety-hook.mjs` (the decision in `runner/safety-hook-core.mjs` and the rule
modules under `runner/lib/hook/`, the deny list in `runner/lib/dangerous-commands.mjs`) runs before
every tool call of every factory agent and either allows it (exit 0) or blocks it
(exit 2). It does not consult the agent, the model or any prompt; the same input
always gets the same decision. It:

- scopes writes to the ticket's worktrees (`GAFFER_WRITE_ROOTS`);
- denies reads of secret files by path, on every read vector, not by a list of reader
  binaries;
- expands every read operand the way the shell will before judging it: the variables
  in its environment and those the command assigns, `~`, braces, and globs against the
  real filesystem (bounded, never through a symlinked directory), each match checked
  like a literal path. The read vectors covered are the read and copy tools, `<`
  redirects, `$(< file)`, `find ... -exec` start points, xargs-fed readers, `eval`,
  `sh -c` and command-substitution bodies. A directory that holds or sits above
  `GAFFER_DATA`, the MCP config directory or HOME is refused as a read operand; an
  operand it cannot expand (`read`, `$(...)`, an xargs placeholder) is refused; a glob
  with no match is judged by its literal directory; and a word anywhere that expands to
  a secret path is refused unless the command only lists or removes it. `$_` is
  unknown, extglob groups (`+(.)env`) are globs, CDPATH makes a relative `cd` unknown,
  and `..` is taken physically, as the kernel takes it: through a symlinked directory
  `wt/..` is the link target's parent, so file-tool paths, search roots and bash write
  targets are judged at both their lexical and physical place. A loop or `xargs` that
  takes file names from a listing of `GAFFER_DATA`, the MCP config directory or HOME
  (`find $GAFFER_DATA | while read f; do gzip -c "$f"; done`) is refused whatever
  program reads them, and `7z`, `pax`, `bsdtar`, `cpio -o` and `git grep / diff
  --no-index` are read vectors. Git's stored text (a commit message may name a
  control-plane CLI) is never run, also not through a variable (`a=$(git log ...);
  eval "$a"`);
- denies the control-plane CLI and raw database access, including a self-spawned
  control-plane MCP (`node .../dispatch/dist/mcp`), `node -e` reaching the dist or the
  database, and reading another process's environment (`ps`, `/proc/*/environ`);
- blocks force-push and ref rewrites of the base branch (`git branch -f`,
  `update-ref`, `checkout -B`, `switch -C`, `symbolic-ref`, `push` or `fetch` into a
  local path, in the spellings git accepts), allowing a force only on `gaffer/...`
  branches;
- refuses edits to hook scripts (`.husky/`, `.githooks/`, the repository's
  `core.hooksPath`), hook-manager configs, repository git config files, a
  `.gitattributes` line that assigns a filter, diff or merge driver, and `git config`
  or `git -c` of any of those keys;
- refuses the credential-using CLIs in command position (`gh`, `aws`, `gcloud`, `az`,
  `vault`, `kubectl`, `helm` and `terraform` against real state, container `login`,
  host namespaces, `--privileged`, bind mounts from outside the worktree, registry
  publish and login, keychain reads), while offline forms such as `helm template` stay
  allowed;
- resolves the command as the shell would: quotes stripped, assigned variables
  substituted, wrappers and `xargs` peeled off, the bodies of `eval`, `sh -c`, `$(...)`
  and inline `node -e` / `python3 -c` / `perl -e` / `ruby -e` scanned as commands of
  their own. The words that name what a privileged CLI does (`wg`, `dispatch`, `fg`,
  `crew`, `gaffer`, `memory`) must be plain literals; a `$(...)`, an unassigned
  variable, a glob, or `xargs`/`parallel`/`find -exec` filling one in is refused.
  A command proven to be data only (plain `git commit` / `log` / `show`, `echo`,
  `grep`, `cat` and the like, with no variable, substitution, pipe, backslash, newline
  or here-document) is judged with the CLI in command position, so a commit message
  or a search that names it is not refused; running git's stored text as a command
  (`$(git log -1 --format=%s)`, `git log ... | sh`, `eval "$(git ...)"`) is refused. A
  script file the agent wrote and then runs (`bash x.sh`, `cat x.sh | bash`) is as
  invisible to the hook as a file the Write tool wrote (see the residual limits);
- refuses an inline interpreter program (`python -c`, `node -e` / `-p`, `deno eval`,
  `bun -e`, `ruby -e`, `perl -e`, `php -r`, and the same programs fed on stdin by a
  here-document, a here-string or `echo` / `printf`, also behind wrappers, `xargs`,
  `sh -c` and `eval`) unless it is visibly free of file-writing, process, network and
  dynamic-code capabilities. It reads the program as the interpreter will receive it
  (the shell's quoting undone, a `cd` before it followed), lexes it per language, and
  refuses any such capability under any alias or spelling: a capability module imported
  under any name, a member of `os`, `sys`, `fs`, `process`, `File` and the like outside a
  read-only list, `eval` / `exec` / `getattr` / `__import__` / dunders, `Function`,
  `constructor`, computed member names, `send`, string callables, backticks. The one
  capability it allows is a write whose every path is a literal inside a write root, and
  that path then gets the checks a Bash write target gets (`.git`, the agent settings,
  the git execution surface, secret files). A program it cannot see (a command
  substitution, an xargs placeholder, a variable the command sets at run time, a program
  piped in from `curl` or `base64 -d`) is refused. The programs inside `$(...)`,
  backticks, `<(...)` / `>(...)`, an unquoted here-document's expansions, `trap` and
  `alias` values are read the same way. So are the ways an interpreter is made to run
  code its program text does not show: interactive mode reading stdin (`python -i`,
  `node -i`, `php -a`, `perl -d`, `bun repl`), a preload or startup variable set by the
  command (`NODE_OPTIONS=--require`, `PERL5OPT`, `PERL5DB`, `RUBYOPT -r`, `PHPRC`,
  `PYTHONSTARTUP`, `LD_PRELOAD`, `BASH_ENV`), `node --import data:...`, `php -d
  auto_prepend_file=...`, `deno run https://...`; all are refused. A variable that runs
  code for whatever command reads it is refused in front of any command, not only an
  interpreter: `NODE_OPTIONS` carrying a `data:` or `/dev/stdin` module (`npm test`
  starts node), `PERL5OPT=-M...`, `PS4` with a substitution, `PYTHONINSPECT`, a dotted
  `PYTHONWARNINGS` category, `MAKEFLAGS` / `MAKEFILES` carrying make text,
  `GIT_CONFIG_*` (the environment form of `git -c`), `GIT_SSH_COMMAND` and the other
  programs git runs, an editor other than a plain one or a sed script, a pager other
  than `cat` or `less`, `LESSOPEN`, a JVM `-XX:OnError`; `PYTHONPYCACHEPREFIX` and
  `NODE_V8_COVERAGE` are judged as writes. A standard-library `python -m` command line
  is read: `-m timeit` code is judged as a program, the output paths of `-m json.tool`,
  `-m venv`, `-m cProfile -o`, `-m py_compile`, `-m compileall -l` and `-m zipfile` /
  `-m tarfile -c` as writes, listing an archive and `-m pydoc NAME` pass, `-m
  http.server` passes only on the loopback interface serving the worktree, and the
  other standard-library command lines that can write, run code or serve (`-m pdb`,
  `-m tarfile -e`, `-m ensurepip`, ...) are refused. awk and sed programs are read for
  `system()`, pipes, `print >`, `getline <`, `w`, `e` and `r`, with their options as GNU
  getopt reads them (any unambiguous prefix of a long option); sqlite3 commands for
  dot-commands in any abbreviation, functions that reach files or code (also behind
  identifier quotes or comments), `ATTACH` and `VACUUM INTO`, and its database path is
  judged as a write unless it is opened `-readonly`; make's command line for `--eval`, a
  makefile on stdin and assignments make expands (`X=$(shell ...)` runs when any recipe
  runs); an inline program of lua, R, osascript, tclsh, expect or dc is refused. A
  command the walker cannot lex is refused (bash runs the lines before the one it cannot
  parse). Text matching is not a
  parser: a third-party package or local module the program imports is not analysed (a
  list of well-known capability packages is refused, and a few package save methods need
  a literal path), nor is a program file;

It fails closed: when it cannot prove a target is in scope, it blocks. Every hook
entry in the settings template carries `"onFailure": "block"` and a 60-second
`timeout`, because the agent CLI's default for a hook that times out or crashes is to
run the tool anyway; the settings writers refuse a template without them. Before any
rule runs, a payload over 2 MiB, or any inspected field (or those fields together)
over 64 KiB, is blocked as `unverifiable: tool input too large` and logged as
`oversized-input`. The caps are constants, not environment knobs.
`safety-hook-redos.test.mjs` pins that repeated wrapper options cannot drive the rules
into exponential backtracking.

Crew's own TypeScript classifier (`packages/crew/src/safety/`, driven by
`safety_policy.yaml`) is advisory: it is enforced only in the mock `crew run` loop and
answers questions elsewhere (`crew safety check`, `explain_safety_policy`,
`check_command_allowed`, `check_path_write_allowed`). Its `needs_approval` tier and any
`deny` entry you add are not enforced at runtime. Those checks also run the live hook
on the same input and report its verdict as `enforced`, with a `mismatch` note when
the two disagree. To change what agents may do, change the hook.

### Worktrees, the runner's git and the agent environment

Each ticket runs in a disposable worktree. Teardown runs on the success and error
paths and from an `EXIT`/`INT`/`TERM` trap, and removes only what the run still owns
(`runner/lib/cleanup-ownership.sh`): before each removal it checks that the ticket's
newest claim is still this run's, and it never deletes the branch of a submitted
review candidate. An unreadable Dispatch keeps everything.

Every git command the runner runs on the host (auto-commit, worktree add and remove,
fetch, merge, push, the landing paths) carries `core.hooksPath=/dev/null` and
`core.fsmonitor=false` through git's environment (`runner/lib/git-safe.sh`), and every
code-running key that points into the checkout or comes from a file in it (filter,
diff and merge drivers, textconv, `core.sshCommand`, credential helpers,
`gpg.program`, pager, editor, git-lfs transfers) is overridden with an inert value
(`runner/lib/git-safe.mjs`). A neutralised merge driver is a conflict and holds the
landing.

The agent's environment is built with `env -i` plus an allowlist, for the shell
launches and the Node launchers alike. Every credential variable is stripped
(`GITHUB_TOKEN`, `AWS_*`, `DISPATCH_API_TOKEN`, any `*_TOKEN`, `*_SECRET`, `*_KEY`,
`*_PASSWORD`), except the model credential the agent needs. File, keychain and socket
credentials are not removed: the agent keeps your `HOME`. The hook covers that
instead: the CLI credential stores (`~/.config/gh/`, `~/.docker/config.json`,
`~/.kube/`, `~/.config/gcloud/`, `~/.azure/`, `~/.pypirc`, `~/.pgpass`, `.ssh/`,
`.aws/`, `.netrc`, `.npmrc`, `.git-credentials` and the agent CLI's own config) are
secret paths, and the commands that use them are refused as above.

The runner marks each agent's workspace trusted in `~/.claude.json` before the launch, so
the agent CLI honours the project's `.claude/settings.json` permissions
(`runner/lib/trust-workspace.mjs`). When that write does not happen (the trust lock is
held by a live process, `~/.claude.json` is not valid JSON, or the path is refused), no
agent is launched there: a delivery or bootstrap ends the tick as a setup error with
`trust_unwritable` and the fix, the review pass holds the ticket for a human, and the
clarify pass, the independent tester and the merge-conflict resolver refuse to start. A lock
left by a run that is gone, one that records no holder, or one older than
`GAFFER_TRUST_LOCK_STALE_MS` (60 s) is taken over.

Before an agent runs, the runner writes its own files into the agent's worktree on the
host, outside any sandbox: `.claude/settings.json`, the `.claude/skills` copies,
`CLAUDE.factory.md` and the `node_modules` links. The repository decides what is at
those paths, so every such write goes through `runner/lib/safe-write.mjs`, for the
shell and the Node launchers alike: a destination that is a symlink (dangling or not) or
not a regular file, or a parent below the worktree that is a symlink or not a directory,
is refused, and the file lands by renaming a fresh temp file in the checked directory,
never through a link. The cleanup that removes a refused file never deletes through a
link either. A refusal names the path and the fix (`unsafe_worktree_path`): a delivery
or bootstrap is parked `blocked` with that reason code and no agent is launched (a
resumed delivery goes back to `paused`, keeping its worktree and uncommitted work), the
review pass holds the ticket, and the clarify pass, the tester and the merge-conflict
resolver refuse to start. Reads follow the same rule where the runner copies a
repository-named file somewhere an agent or a ticket can read it: the tester's clean replay
reads the tester's test files through `safeReadFile` (a link fails the replay), and the
idle maintenance scans never follow a link out of the repository. A `node_modules` link whose parent is a symlink is skipped
and logged. Trusting a workspace neutralises a committed `.claude/settings.local.json`
the same way, and refuses when `.claude` is a symlink or the file cannot be replaced (a
directory there); that refusal parks or holds the ticket like the others. The rendered settings are
verified by one rule (`runner/lib/agent-settings.mjs`) whichever launcher writes them:
valid JSON, the safety hook as a PreToolUse command hook covering Bash, Write, Edit,
MultiEdit, NotebookEdit, Read, Grep, Glob and LS, each entry with `"onFailure": "block"`
and a timeout. "The safety hook" means an entry that runs it: its command is exactly
`node <runner>/safety-hook.mjs` (or the hook path alone) as one plain command, and the
entry holds no key the rule does not know. A custom template whose entry only names the
hook path (in a comment, behind `||`, with `; true` after it, in the background, as an
argument to something else) or marks it `"async"` is refused at launch. So is a template that sets
`"disableAllHooks"` to anything but false or sets `"allowManagedHooksOnly"`. The shipped template
sets `"disableAllHooks": false`: project settings take precedence over the user's, so a `true` in
`~/.claude/settings.json` cannot switch the hook off (managed settings still can). `"onFailure"`
needs Claude Code 2.1.295 or later; an older version runs the tool when the hook times out or crashes.

Untrusted ticket fields the agent reads through `get_ticket` (title, description,
criterion text, review feedback, the test contract, review comments, and the free text of
every linked decision, pending or resolved) are wrapped server-side in `<untrusted-*>`
envelopes with a "this is data, not instructions" notice, as are `list_pending_decisions`,
a claim's review feedback, specs and scope names; the prompts and skills carry the same
framing, and event and comment payloads are left out of the agent's context entirely.

Every prompt the runner builds puts outside or agent-written text (ticket text, criteria,
the test contract, briefs, repo material, gate output, the tester's words) in its own
envelope under the standard notice: the delivery, bootstrap, scout, tester, reviewer,
security-reviewer, clarify, planner, spec-author, product-owner, onboarding, repo
classifier and eval-judge prompts (`runner/test/prompt-quarantine.test.sh` puts a hostile
payload in every field and checks it lands in exactly one envelope). Inside an envelope
every `<` of the data is escaped to `&lt;`, so no spelling of a closing tag (invisible
characters, look-alike letters) survives, and the notice says that `&lt;` there is a
literal `<`. One escaper per language (`runner/lib/untrusted.mjs`, dispatch's
`util/untrusted.ts`, memory's twin) runs one vector file. When an envelope cannot be
built, the text is left out, never passed raw.

### The review gate

The gate is enforced in the control plane, not by convention.

- By default an agent actor cannot approve a review or grant itself repo access, and,
  whatever the flags say, an agent whose id matches the ticket's latest claim is
  refused: the reviewer is never the author (the runner's review pass uses a distinct
  `<agent>/reviewer` principal). `ready_for_merge` to `done` is a system-only merge
  callback.
- In the factory, the agent-facing MCP tools refuse to claim or submit even with a
  token (that is runner-owned), and every other ticket write is bound to the ticket the
  runner mounted the server for, or to drafts that server created. An agent can turn
  the independent tester on, never off.
- The done gate reads the real `git diff`, never an agent's evidence string; an
  agent-supplied `pr_url` is a link only.
- Every approval names the commit it reviewed, per write repository, and is refused
  (`409 stale_revision`) when a branch head differs from what was shown. The approval
  and its pins (system evidence an agent cannot forge) are written in one transaction,
  and every landing path merges only those commits. An approval must cover every write
  repository (`409 repo_unavailable` otherwise), and a multi-repo ticket is done only
  when every pinned commit has landed. The landing record is the merge lane's: the hook
  denies `wg ticket record-landing` and `ci-result` to agents, and the control plane
  refuses a landing git does not show on the default branch. A partial landing stays in
  Ready for merge as "Partly merged" and can only be finished.

### Signed approvals and tester verdicts

An approval used to be a row: the `ticket.transitioned` event into `ready_for_merge`. The
hash chain over `work_events` has no key, so anyone who could write the sqlite file could
insert an approval and recompute a consistent chain, and every landing path acted on it.

- **What is signed.** Every transition into `ready_for_merge` (a person's or an admin's
  approval, the runner's own approval in an autonomous mode, a tester PASS that approves)
  and every `ticket.tester_passed` event (a tester PASS, or a person's waiver) carries a
  seal in the `gate_seals` table: HMAC-SHA256 under the factory key over the event's
  chain hash (its fields and its place in the chain) and the facts it binds: for an
  approval, the commit per repo the approver named (not a re-read of evidence rows and
  timestamps an agent can write; a tester PASS that approves carries the commits of the
  sealed approval that routed it to the tester); for a verdict, the row it names and a
  hash of that row's payload. An approval that names no commit lands nothing. No existing
  row or chain hash changes.
- **Who signs.** Only trusted host processes: the dispatch CLI and the REST server when
  they record an approval or a verdict (the runner's own approval goes through the CLI).
  The agent-facing MCP server opens the database with a keyring that refuses any load of
  the key; it has no approving tool. A signing that cannot use the key rolls the whole
  approval back: nothing unsigned is recorded.
- **What landing checks.** `wg ticket landing-begin` (the last word before a default
  branch moves or a PR merge is asked for), `record-landing` (including the landed-upstream
  recovery) and `mark-merged` refuse, and `runner/lib/tester-binding.mjs` (the one landing
  decision `land.sh`, the merge lane and `gaffer merge` apply) holds, unless the approval
  the landing acts on and the tester verdict it relies on verify under the key, the chain
  verifies from genesis up to them, and the commit about to land is one the signed
  approval pinned for that repo. A missing key, a missing signature, a mismatch or a broken
  chain: nothing merges and the ticket is held for a person (`unsigned_approval`,
  `unsigned_tester_verdict`), with what to do (re-approve; for a missing key, run setup
  first). There is no grandfathering: an approval from before the upgrade is re-approved.
- **A revoked approval stays revoked.** The old approval keeps its valid seal after a
  reopen, a send-back, a won't-do or a hold undoes it, so landing also requires that the
  approval is still the ticket's latest move (a status written back to `ready_for_merge`
  is not an approval), and that the event log still holds the head a trusted host process
  recorded outside the database after its last write: `<id>.anchor/` beside the key, a
  MAC'd (rowid, id, hash) under the same key, moved forward after every committed write by
  the CLI or the REST server. Deleting the rows after an approval (revocation by
  truncation), rewriting them with a recomputed chain, or rolling the whole file back to a
  copy breaks it, and the anchor never moves on past a gap, so a later host write does not
  hide one. Nothing lands until a person runs `gaffer wg gate-key reanchor` (only after
  restoring a backup on purpose: approvals in the restored log count again) and reopens and
  re-approves. A state import removes every seal and re-anchors. What the anchor cannot
  see: rows written by the agent-facing MCP server after the host's last write (an agent's
  own acts, which an agent could equally not have made), and a crash between a host commit
  and its anchor write.
- **Where the key lives.** `${XDG_CONFIG_HOME:-$HOME/.config}/gaffer/keys/<id>.key`, 32
  random bytes, mode 0600 (a looser mode is refused), in a 0700 directory. `<id>` is a hash
  of the canonical path of the dispatch database's directory (`$GAFFER_DATA`), never of
  anything stored where an agent writes. A keys directory inside the data directory is
  refused. `gaffer setup` creates the key; so does the first approval recorded on the host.
  Verification never creates it.
- **Keeping it from agents, per provider.** The agent environment (`gaffer_agent_env`,
  `lib/worker.mjs`, the docker env forwarding) carries neither the key nor its path. The
  safety hook refuses any tool call or command that names the keys directory (Read, Grep,
  Glob, Write, `cat`, `cp`, an interpreter opening it, a path assembled from variables in
  the same command), on every provider.
  - `sandbox-exec`: every profile (the agent, the gates' validation profile and the
    tester replay) denies reading and writing the keys directory outright, whatever the
    write roots grant. They also deny the operator's REST token
    (`$GAFFER_DATA/dashboard-token`, `~/.gaffer/dashboard-token`) and the runner's
    acceptance signing key: the agent profile otherwise reads everywhere and allows the
    network, so an agent past the hook could read the token, approve as the operator over
    the host's REST server on localhost, and the host would seal that approval. Nothing
    inside the sandbox needs either (the MCP servers and the CLI use sqlite).
  - `docker`: the keys directory is never mounted; the wrapper refuses a mount at, under
    or above the operator account's keys directory (and one under the current `HOME`
    when it exists). The MCP data plane runs on the host; the dashboard token and the
    other entries under `$GAFFER_DATA` are masked in the container.
  - `none` (`GAFFER_STRICT_REQUIRE=0`): **only the safety hook stands between an agent and
    the key file.** The hook is a string analyser (see the residual limits): a compiled
    binary, or a script the agent writes and runs, can read any file the operator's user
    can. An inline program (`python -c`, `node -e`, ...) is refused unless it is visibly
    free of file-writing, process, network and dynamic-code capabilities, but a program
    the agent first writes into its worktree and then runs (`python x.py`, a module it
    imports) is not analysed at all: the write roots apply to the Write tool, not to what
    a script does when it runs. Under this provider the signature proves less than it does elsewhere: an agent
    that escapes the hook can read the key and sign a forged approval. The hook alone
    also guards the dashboard token (with it, the REST server seals an approval for its
    caller) and the tokenless operator CLI (`wg ticket tester-pass --as system`, `wg
    review approve`), which signs for whoever runs it on the host. Run without an OS
    sandbox only inside a VM or container you trust.
  - **The tick's helper servers** (`runner/config/17-cli.sh`): the dispatch server is that
    operator CLI kept running for one tick, and runs whatever command reaches its request
    pipe, as the operator; the JSON server runs `runner/lib/json-tool.mjs`, which reads
    files, can run `git show` and evaluates the expression it is given. Their pipes live
    in 0700 directories under `$GAFFER_DATA/wg-serve`, never on an inherited file
    descriptor, and they exit with their tick. The 0700 mode stops no process of the
    operator's user, and an agent is one (with `GAFFER_DATA` in its environment), so each
    server answers only lines that end with the tick key: 128 random bits the tick makes,
    keeps only in its shell's memory (never exported, never in an argv or a file) and
    hands each server through a pipe on its stdin. No call is in flight while the agent
    runs, so agent code that finds the pipes has nothing to copy the key from; the
    safety hook also refuses any command that names `wg-serve`. What remains is a process
    left running past the agent's turn, which could read a request line or swap a
    request file during a later call; such a process can equally start the operator CLI
    itself (the `none` residual below). Under `sandbox-exec` every profile denies writing anything there (it is not
    one of the in-sandbox writers); under `docker` the wrapper creates `wg-serve/` before
    it masks the entries of `$GAFFER_DATA`, so it is masked; under `none` they are as
    reachable as the CLI itself. Sandboxed code can still READ a reply file under
    `sandbox-exec` (reads are open there), which holds nothing the database it can also
    read does not.

### Signed principals

Signed gate events protect the acts (an approval, a tester verdict) and the event chain.
They did not protect the rows that decide who may act: a process that could write the
sqlite file (on the macOS sandbox the in-sandbox MCP servers write it by design) inserted
an `api_principals` row with a token hash it chose, `admin` and unscoped, called the
loopback REST API with that token, and the server sealed a real approval for it. Denying
the operator's token file to the sandbox did not help: the attacker never needed it.

- **What is signed.** Every principal row carries a seal in `row_seals`: HMAC-SHA256 under
  the factory key over its identity and authority (id, name, token hash, capability, actor
  type and id, repo and ticket scope, created_at, created_by) and the id and chain hash of
  the event that last set its state (`principal.created`, or `principal.resigned`), so the
  seal is bound to its place in the log. `events/rowSeal.ts` is generic: the autonomy
  policy and a ticket's risk level are meant to use it next.
- **Verified at every decision point, every time.** The REST auth pipeline, the CLI's
  `GAFFER_PRINCIPAL_TOKEN` / `--as-principal` path, the live event feed's per-write
  re-check and a person's tester verdict (re-read inside its transaction) all go through
  one check: the MAC must verify over the row as it is now (a swapped token hash, a raised
  capability, a widened scope or another row's seal copied over is refused), the bound
  event must be on record and be the row's latest lifecycle event, and the event log must
  still hold the head the host anchored outside the database. A row without a valid seal
  is refused exactly like an unknown token (401, or the CLI's UNAUTHORIZED), the REST
  server logs it once, and `dispatch doctor` names it: "principal <name> is not signed by
  this factory: it was created before signing, restored from a backup, or written outside
  the factory". Verification never creates a key or a seal; with the key gone every
  principal is refused. The agent-facing MCP server holds no key and can neither verify
  nor sign.
- **The row that is verified is the row that is used.** A database writer can act between
  two reads of one decision, so each decision reads a principal once. Sign-in reads the row
  by its token hash, checks the seal over that row's facts and builds the identity,
  capability and scope it returns from that same row, inside one read snapshot with the
  seal and the event it names; it never looks the row up again by id. (It used to: a
  writer that showed a forged row to the first read and put the genuine row back for the
  second signed in with authority no seal covered.) The unsigned-principal review builds
  what it shows and the codes a person confirms from one read of each row in one snapshot;
  a person's tester verdict checks the seal over the row it read. The re-sign itself runs
  in a write transaction that no other writer can interleave.
- **Revocation stays revoked.** Revoking writes `principal.revoked` and retires the seal in
  the same transaction. Flipping `revoked_at` back to NULL, restoring a copy of the old
  seal, or both, is refused: the revocation event supersedes the seal. Deleting the
  revocation event as well breaks the chain up to the anchored head (or the anchored row
  itself), as a removed revocation of an approval does.
- **Who signs.** Only the trusted host paths that create a principal today (the shared
  operator token over REST, the operator CLI) and the re-sign below. A principal token,
  even an admin's, may not create, revoke or re-sign principals, and the safety hook
  refuses `principal create|revoke|resign` from an agent's shell.
- **Landing.** An approval's seal now binds the principal it was made through (null for
  the operator, the runner and agents), and every landing (`landing-begin`,
  `record-landing`, `mark-merged`, `runner/lib/tester-binding.mjs`) refuses while that
  principal is not signed (`unsigned_approval`, failure `unsigned_principal`); so does the
  review that routed a ticket to the tester and a person's waiver (whose verdict row names
  its principal under the verdict's seal). An approval sealed before this change names no
  principal, and nothing in the log says which principal made it (checking the rows that
  speak as its actor is undone by deleting a forged one), so a person's or an admin's such
  approval is held until it is re-approved; the runner's and an agent's still count.
  Revoking a principal withholds its approvals that have not landed: re-approve them.
- **Upgrade and restore.** Nothing is signed on upgrade: that would bless a forged row.
  Principals created before this change stop working until a person reviews and re-signs
  them, with one deliberate act: `gaffer wg principal unsigned` lists them (who each acts
  as, its capability and scope, created_by and created_at, whether a matching
  `principal.created` event is on record) and prints a confirmation code for exactly that
  list and a `review_code` for each row; `gaffer wg principal resign <name> --confirm
  <review_code>` signs one, `gaffer wg principal resign --all --confirm <code>` signs the
  listed rows whose creation event is on record (operator only), or the callout in Settings (Access), which shows the same list. **The review is
  the control, not the creation event.** A process that can write the database can also
  append a `principal.created` event that matches its forged row (the chain has no key),
  and a forged event written before signing existed cannot be told from a real one: the
  event check only catches a row inserted with no event at all. So a re-sign signs nothing
  without a code, and a row added or changed after the review changes the code, so the
  operator's routine step cannot be made to sign a row the operator never saw, or a row
  raised to admin after the operator looked at it. Re-sign
  only the sign-ins you created yourself with the access shown; revoke the rest. Principals are not part of the state export, and row seals are neither
  exported nor kept by an import: after restoring a backup, run `gaffer wg gate-key
  reanchor` as before, then re-sign the principals you recognise.

### Sealed autonomy

The rows that decide what may happen without a person were plain rows: a process that
could write the sqlite file inserted an `autonomy_policy` row (repo, risk, gate, mode
`auto`), or lowered a ticket's `risk_level` to one such a row covered, or appended an
`autonomy.step_down_lifted` event, and the runner then approved and merged on its own.
Each of them now counts only with a seal under the factory key (`events/autonomySeal.ts`,
on the same `events/rowSeal.ts` as signed principals):

- **Policy rows.** Enabling, changing or re-signing a row writes an
  `autonomy_policy.enabled` / `.changed` / `.resigned` event and seals the row's authority
  (id, repo id and the repository it names: name, checkout path and remote; risk, gate,
  mode, who enabled it and when, created_at) against that event, in
  one transaction; turning it off writes `autonomy_policy.disabled` and retires the seal.
  Every decision that can answer "automatic" (the runner's `wg ticket auto-decision`, an
  agent's approve, the landing check, the landing facts, the ladder, the
  recommendations' "already automatic") reads a row whose seal does not verify as ABSENT:
  a person decides. The ladder cell says "Not signed: a person decides" and Settings and
  `dispatch doctor` say how many automatic rows are off until a person signs them. A
  mode's env floor (the operator's own configuration) is unchanged.
- **Ticket risk.** A `ticket.risk_set` event and a seal over {ticket, risk} record the
  risk a ticket is decided at. An unsigned risk reads as the HIGHEST risk for every
  autonomy decision (with the critical ceiling: a person decides; the hold reason is
  `autonomy_risk_unsigned`), and the observed-risk comparison treats it as indeterminate
  (held), never the stored value. Who seals: a KEY HOLDER at creation (the REST server,
  the host CLI); the trusted host at a ticket's FIRST claim when nothing sealed it before
  (a ticket created through the agent-facing MCP server, which holds no key, or an agent's
  sandboxed CLI, which cannot read it), and tickets the planner's idle loops file. The
  claim rule seals only a ticket that has no risk record, no seal and no earlier claim,
  exactly one `ticket.created` event, and a stored risk equal to the one that event
  recorded (a risk lowered by a database writer between creation and claim is not sealed:
  a person re-signs it), and only after checking that its creation, claim history and risk
  records are intact in the chain; a later claim never re-signs a changed value, and
  nothing else repairs a missing or broken seal.
- **Lifts.** A lift of a step-down is a person's act, sealed with the lift event (its id,
  chain hash, the row it gives back, how and by whom). A lift without a valid seal is
  ignored: the step-down stays in force, and its evidence count does not restart. A
  step-down needs no seal (a forged one only takes autonomy away). Every "not stepped
  down" answer also checks the anchor and the chain over the step-down and lift events,
  so a deleted or rewritten step-down does not lift anything.
- **Re-signing is a person's act.** `gaffer wg autonomy unsigned` / `risk-unsigned` (and
  Settings, and `GET /api/autonomy/signatures`, `/api/autonomy/risk-signatures`) list what
  is not signed with a code for exactly that list and for each row; `gaffer wg autonomy
  resign` / `risk-resign` (and the POST routes) sign only what the code covers. Refused
  for an agent or the runner, for a read-only, scoped, non-admin or revoked principal,
  and absent from MCP; the safety hook's control-plane rules deny both verbs to an
  agent's shell.
- **The verified checkpoint.** A new process used to walk the whole chain once (about
  2.2 s on a 100k-event log for one autonomy decision). A key holder that verified the
  chain now records beside the anchor, under the factory key, the head it verified and a
  digest of every entity's lifecycle rows up to it. A new process walks only the rows
  after it (one decision costs 12 to 18 ms on that log), and for the row a decision is
  about it re-reads that row's lifecycle events before the checkpoint, re-hashes each and
  compares their digest. A checkpoint that does not verify under the key, names a row the
  log no longer holds as recorded, or lies past the anchored head is refused (a person
  decides), never skipped. A re-anchor or a new key clears it.
- **Upgrade.** Nothing is signed on upgrade. Existing policy rows grant nothing until a
  person re-signs them; tickets not yet claimed are sealed at their first claim; tickets
  already in flight read as the highest risk until a person re-signs them.

What a database writer can still do: take autonomy away (forge a step-down, break a seal,
delete rows: every such change is a hold for a person, a denial of service it had
anyway); state a low risk for a ticket it creates itself (through MCP, or a row it inserts
with a creation event it appends), which the first claim then seals (the observed-risk
comparison at approval is the defence, as before); rewrite events
written by a keyless process after the last anchor, before a key holder's next write moves
the anchor (the claim rule checks up to the head, but a deletion with a rechain of that
unanchored tail is not detectable); and anything that needs the factory key, which it does
not hold.

### Definition of Done, gate integrity and the merge gate

Before a delivery reaches review, the runner (never the agent) runs the enabled gates
in the worktree, each under a timeout: tests, typecheck, lint, and each acceptance
criterion's `check_command`, executed byte for byte as stored (dispatch refuses a
result whose command differs, and the done gate refuses a checked criterion the runner
has not passed). A red gate sends the delivery back to rework with the gate name and an
output tail as evidence. The gates follow `GAFFER_GATES` and are turned off only by the
environment (`GAFFER_DOD_*`, see [docs/CONFIG-ADVANCED.md](docs/CONFIG-ADVANCED.md)); crew.yaml's `definition_of_done` block is not read by
the runner. A gate with no configured or detected command is skipped and logged.
Coverage, SAST and docs checks are not gates. The Review view shows gate results only
from rows the `system` actor recorded, and flags an agent-claimed test count the
runner's own count contradicts (a consistency check, not a gate).

**What a ticket writer can make the runner run.** Anyone who may write a ticket (the
shared token, the tokenless CLI, or a human or admin principal with write on it, scoped
or not) can give it `check_command` criteria and a `cli` / `api` acceptance profile
whose argv lists the runner executes. In the factory an agent can add a
`check_command` only to a ticket its mount is bound to, or a draft it created, before it
is claimed (never from a reviewer or tester mount); outside the factory an MCP agent can
add one to any ticket not yet claimed. An agent may name an acceptance profile for a
ticket's test contract (`set_test_contract` `profile`, never replacing one a person set)
but never registers the argv the runner runs for it: a person does. The contract freezes
once the ticket is claimed. That is
deliberate and not admin-gated: those commands run only for that ticket, in its own
worktree or a fresh checkout of its tested commit, through the same gate path as the
repository's test command (`gaffer_dod_run_one`: the gate sandbox profile with no data
plane and no model credential when an OS sandbox is present, a timeout, the scrubbed
agent environment; the acceptance argv also cannot set `HOME`, `TMPDIR`, `LD_PRELOAD`,
`BASH_ENV` or `GAFFER_*`). A ticket writer can already make the runner execute code of
its choosing by describing it in the ticket for the delivery agent to write and the test
gate to run, so a per-ticket command grants nothing a ticket write does not. A
repository's own gate commands (`POST /repos/:id/commands`) run for every ticket on that
repository, other people's included, so they need an admin principal.

Gate integrity resists an agent that weakens its own tests:

1. **The base is a recorded commit.** When the runner cuts the delivery branch it
   records the commit (`ticket_repo_delivery.base_sha`) before any agent runs; retries
   and resumed branches keep it, and dispatch refuses a different one unless the runner
   says it recut the branch. The gate and dispatch's scan both read from it.
2. **Gate scripts come from the base.** When a gate command is a package-manager
   script call and the delivery changed it, one of its `pre`/`post` hooks, or a script
   it reaches through a simple chain, the base version runs instead (`base-pinned`).
   Each gate row records where its command came from.
3. **An integrity row flags weakening.** It compares base with the worktree (committed
   and not) and flags: deleted or renamed test files; added skip or focus markers in
   the common frameworks (JS, Python, Go, Rust, Java, Ruby, PHP, Elixir); changed
   scripts the gates reach; changed, removed or (once the base has tests) added
   test-runner configs; any change to a package-manager rc file (`.npmrc`, `.yarnrc`,
   `.yarnrc.yml`, `bunfig.toml`), on disk too; files that lost test cases or whose
   assertions fell to zero; and a change it cannot fully see (a symlinked test file,
   `skip-worktree` or `assume-unchanged`, a sparse checkout).
4. **Dispatch recomputes the check server-side** from the real diff against the
   recorded base (`test-modified`, high risk). An unallowed `test-modified` holds an
   agent approval for a human, whatever the declared risk. A human approval is never
   held.
5. **Only a human may excuse it**, with `allow_test_changes` (CLI, REST or the Review
   page). Agents and the system are refused, the hook denies the verb, and no MCP tool
   exposes it. The allowance does not change what the gate runs.

Limits of gate integrity: it flags, it never fails a delivery. It does not detect a
weakened assertion in a test that still runs, tests replaced by trivial ones in
another file of the same language, a test that never ran on base, pytest settings in
`pyproject.toml` or `setup.cfg`, or package-manager settings outside the four rc files.
A compound gate command runs as registered. The hook's ref-rewrite rule is defence in
depth; the recorded base commit is what keeps the scan honest. The review diff is
still computed against the base branch's merge-base.

Nothing lands on the strength of each side's own gates. Every landing path, for each
repository of a multi-repo ticket, builds the merge of the approved commit onto the
current target in a scratch worktree, runs the gates on it, and lands exactly that
commit only while the target is still the gated head; a red combination is held
(`merge_gate_red`) with the target untouched. A conflict resolution the resolver agent
commits is gated again on a clean checkout before re-review. Merge commits carry
`Gaffer-Ticket`, `Gaffer-Reviewed-By` and `Gaffer-Gates` trailers; they are a record,
not a proof (unsigned; `GAFFER_PROVENANCE_TRAILERS=0` turns them off).

### The independent tester and what its verdict proves

With `GAFFER_TESTING` unset, the tester gates a testable ticket only when every write
repo has a registered test command; an epic's acceptance ticket is always tested. Where
it gates, it runs before human review, and the control plane refuses an approval of a
commit the tester has not passed (`not_tested`). On a multi-repo ticket the other
repositories' commits are reviewed, not tested.

**Replay.** A tester PASS binds the test identities the runner's own clean replay saw
pass in the tester's files (recorded as `system`; refused from an agent, a person or an
admin; the hook refuses `tester-pass` in every spelling). The merge gate replays the
tester's files (from `gaffer-tests/ticket-<n>`, never its agent wiring) on the merge
candidate, using the registered test command with only the tester's files and a proof
reporter appended. Every named test must execute and pass: a skipped, missing or
renamed one holds (`tester_replay_unverified`), a failed one is red
(`tester_replay_red`), and dispatch refuses a replay record that does not prove all of
them. A PASS the runner could not replay (no test command, `GAFFER_TESTER_REPLAY=0`) is
held for a human as unverified, and dispatch refuses an automated PASS without a passed
replay. An older PASS without identities is file-level evidence only.

**A person's verdict.** A person may record the tester's verdict instead: a PASS that
waives the tester (a hold the runner cannot settle on this host, a criterion the tester
cannot observe) or a FAIL. Dispatch accepts one only from an active human or admin
principal with full capability, re-read from the database inside the verdict's
transaction: `GAFFER_PRINCIPAL_TOKEN` / `--as-principal` on the CLI, the principal's
bearer token on REST and the dashboard. The tokenless operator CLI, `--as human|admin`,
the shared API token and a revoked principal are refused (`principal_required`). A
waiver records what dispatch computed: every write repo's delivery head (refused when one
cannot be read), the contract hash, the criteria it waives, the summary, the principal and
the factory's isolation (`none` when agents run without an OS sandbox, read from the
runner's `sandbox-status`). It carries no runner measurement. A new commit in any covered
repo or a contract edit voids it (approval and `landing-begin` refuse as not tested, and
the landing decision holds a waiver of another commit or of none). Every surface labels
it "tester verdict waived by <principal> for criteria <...> on <sha>: <summary>", and an
epic resting on one reads "accepted with N waiver(s)".

The principal token is a person's credential. The runner takes it out of its own
environment when the config loads (only `gaffer wg` hands it back to the CLI the person
typed), the bash agent-env allowlist and the Node worker seam drop it from every agent
launch, the command worker can never be handed it, and the docker wrapper forwards an
allowlist that does not name it. The safety hook refuses it handed to any program and the
hand routes around the tester (`ticket move`, `ready`, `hold`, `reopen-for-review`,
`block`, `unblock`, `human-claim`, `human-release`, `tester-pass`, `tester-fail`) from an
agent's shell. Where agents run without an OS sandbox (`GAFFER_STRICT_REQUIRE=0` and no
wrapping), the safety hook is all that stands between an agent and a person's verdict:
`preflight.sh` and `gaffer status` say so, and a waiver recorded then says "recorded
without OS isolation". The operator who can open the database file can still write
anything in it; signing the gate events (a separate change) addresses that. Two operator
credentials also reach a tester verdict by another road, and the principal requirement
does not change it: the tokenless CLI can record the runner's own verdict by hand
(`tester-pass --as system --replay passed` with the head and the contract hash), which
reads as the tester's verified PASS rather than a waiver; and the shared API token (the
dashboard link) or the tokenless CLI can mint a human principal (`POST /api/principals`,
`principal create`) and waive with it. The requirement keeps a person's verdict out of an
agent's reach and attributes it to a named principal; it does not bound the operator's
own credentials, and until gate events are signed only the safety hook and the OS sandbox
keep an agent off those two roads.

**What the replay proves**: that those named tests executed and passed under the
registered command on the candidate. Not what they assert. The tester's per-criterion
notes are its own claims.

**How hard the evidence is to forge.** node:test events are signed by the reporter with
a per-replay key that is never in an environment variable. The runner writes it to a
mode 0600 file with a random name inside a mode 0300 directory in the proof directory;
only the file's path travels (`GAFFER_REPLAY_PROOF_KEY_FILE`). The reporter reads the
file and unlinks it when it loads, before any test file runs, and signs nothing if the
unlink fails; the runner removes a file no reporter consumed. So a test that reads every
ancestor's `/proc/<pid>/environ` finds the path of a file that is already gone. The
modes keep other users out and the directory out of a plain listing; they do not stop
code running as the runner's user, which can change them. What protects the key is that
the file is gone before a test runs. All three replay paths (the clean replay, `land.sh`, `merge-ticket.mjs`)
use the same helper, and the docker wrapper forwards the path, never the key. Other
runners' evidence is a JSON report with the runner's shape, a by-path file set, or
`go test -json` events; printed text never counts.

**The clean replay is contained.** The tester's test files are the tester's own code, so
the clean replay, where the identities are measured, runs them through the same sandbox
seam as the gates, with the `replay` profile:

- under `sandbox-exec` it is the validation profile plus read denials for `$GAFFER_DATA`
  outside the replay's checkout and dependency links, no write grant for `$GAFFER_DATA`
  or `$STRICT_ALLOW_HOME`, and no reads or writes at all of HOME's credential and agent
  folders (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.kube`,
  `~/.docker`, `~/.claude`, `~/.npmrc`, `~/.netrc`, `~/.pypirc`, `~/.git-credentials`,
  cargo's credentials, `~/.gnupg`), so a test cannot plant a hook in the agent's
  settings;
- under `docker` it is the validation layout: nothing from `$GAFFER_DATA` is mounted and
  no model credential is forwarded;
- the environment is an allowlist (`PATH`, locale, `CI=1`, and where the host's
  toolchains live, such as `CARGO_HOME`, `RUSTUP_HOME` and `GOPATH`) with a scratch
  `HOME` and `TMPDIR`: no model credential, no `GAFFER_DATA`, no `DISPATCH_DB`, and `wg`
  and `gaffer` are shadowed on `PATH` by stubs that refuse;
- when strict mode asks for a sandbox (`STRICT_MODE=1` or `GAFFER_STRICT_REQUIRE=1`) and
  the host cannot supply one, the replay holds and the PASS is held unverified with the
  reason; it never runs the tester's files unsandboxed. `GAFFER_DOD_SANDBOX=0` drops the
  wrap here as it does for the gates (the stripped environment and the key file stay).
  With no sandbox configured at all (supervised mode) it runs bare with the stripped
  environment and the key file. That stops the environment and `PATH` routes only: the
  checkout lives under `$GAFFER_DATA/worktrees`, so a bare test can still find the
  factory's database and the dispatch CLI by path. Containment needs a sandbox.

What remains: a node loader module the registered command imports (`--import
./test/setup.mjs`) loads before the reporter and can read the key file, and so can the
registered command's own steps before node starts. In registered mode the runner still
issues a key for a runner it cannot identify (`sh scripts/test.sh` that runs node
--test). If that wrapper runs something other than node:test (vitest, jest, pytest), no
reporter ever consumes the key, so that runner's tests and the code they import can
read the file for the whole run and sign node:test events with it: evidence from an
unidentified registered command proves execution against code that is not attacking the
replay, nothing more. Register the runner's own command (`node --test`, `vitest run`,
`pytest`) and the replay runs it by path instead. A go or cargo command the replay cannot
scope gets no key at all. The wrapper, like any loader it names, comes from the tested
commit, never from the tester's files, and a delivery's change to a script is already
flagged for the reviewer (gate integrity). Under `sandbox-exec`, reads outside
`$GAFFER_DATA` and the listed HOME folders stay open, as for the gates. One key signs one
node:test run: a second `node --test` in the same registered command proves nothing and
holds, and the hold says so. A pooled flaky rerun of the landing's tests gate gets a
fresh key file: `land.sh` and `merge-ticket.mjs` hand the key to `dod-regate.sh` on
stdin, and `lib/dod.sh` writes it to a new file just before the rerun.

**Acceptance profiles.** For a ticket with the `cli` or `api` profile, the runner runs
the commands a person registered (human or admin only; refused for agents in the
control plane and by the hook) in a fresh checkout of the tested commit, before and
apart from the replay, and dispatch refuses an automated PASS without a passed record
for that profile, commit and contract hash (`ACCEPTANCE_EVIDENCE_REQUIRED`). What is
proven: those argv lists exited and printed as expected, the named files exist, and the
probes got the named statuses, keys and schema shapes. What is not: that the commands
cover the criteria, anything the expectations do not name, behaviour under real data
or load. The commands run with a stripped environment (a spec cannot set `HOME`,
`TMPDIR`, `LD_PRELOAD`, `BASH_ENV` or `GAFFER_*`) under the gates' sandbox posture; a
required sandbox the host cannot supply refuses the run. The api profile is refused
under the docker provider. Output excerpts are redacted with the crew secret patterns;
a secret in an unknown shape can still appear. The record carries an HMAC with a key in
`$GAFFER_DATA/acceptance-signing.key`, but nothing verifies it yet: dispatch checks the
record's actor and fields, so anyone who can write the database as the runner's user
can write a record.

**Required CI.** With `GAFFER_REQUIRE_CI` and PR creation on, the runner marks CI as
required before review, and approval, a tester PASS and landing all need a recorded
PASS for the exact commit: none reported, a PASS for another commit, or an unresolvable
candidate is a hold (`ci_required`). A gate that cannot read CI sends the delivery back
to rework, or under `GAFFER_CI_TIMEOUT_POLICY=proceed` lets it reach review with
approval still held.

**Landing.** Every merge or checkout that updates your checkout passes
`--no-overwrite-ignore` and checks by name for a file the branch adds where you have an
ignored copy (`ignored_file_in_the_way`). A cancellation or a red required check
recorded while a merge gate runs stops every landing not yet started: each path
re-checks ticket, approval and CI in one transaction right before a default branch
moves. A landing already started is reported (`landed_already`, exit 4 `LANDED AFTER A
REVOCATION`), not undone. A repository with a recorded PR lands only through that PR.

### The OS sandbox

[docs/sandbox.md](docs/sandbox.md) has the full design and its tests. In short: the
`docker` provider mounts only the roots and what the data plane needs, runs on an
`--internal` network whose only exit is a default-deny allowlist proxy (operator hosts
are escaped and anchored, so `.*` cannot widen it), drops capabilities except
`DAC_OVERRIDE`, and sets `no-new-privileges`. The dispatch and memory MCP servers run on
the host behind a per-spawn unix socket, so the container holds no database, settings,
dashboard token or claim token. Mounts are an allowlist of runner-created paths: a
worktree `node_modules` symlink is mounted only when it resolves exactly to the primary
checkout's own; anything else is skipped with a warning. The container gets a private
git dir, and the host imports only the ticket branch with a compare-and-swap. The DoD
gates and criterion checks run under a `validation` profile with no data plane and no
model credential, and so does the pre-gate dependency install, with `--ignore-scripts`
and a stripped environment (a package manager can still run repository code such as a
`.pnpmfile.cjs`, which is why the install is inside the wrap).

The `sandbox-exec` provider (macOS) is a write filter and nothing more. After this
release its agent profile denies every write under `$GAFFER_DATA` (also where a temp
grant contains it, and on every parent directory, so no rename swaps the directory) and
grants back only what the in-sandbox writers need: the dispatch and memory databases
with their `-wal`/`-shm`/`-journal` files, the crew events log and the safety hook's two
ledgers (the same set the docker legacy layout leaves visible, pinned by a test). The
host-trusted files are denied by name after that: `settings.json` and its temp
siblings, `usage-pause.json`, every ledger, the per-ticket marker files, `crew.yaml`, the
MCP runtime configs, the generated profiles, the agent ids and the skills mounts. Every
profile also denies the agent CLI's user configuration (`~/.claude` settings, `CLAUDE.md`,
hooks, agents, commands, skills, plugins, and `~/.claude.json`), while its runtime state
(`projects/`, `todos/`, `statsig/`, `shell-snapshots/`) stays writable. The gates (DoD,
acceptance checks, the pre-gate install, the merge gate) never run under the agent's
profile: each run gets a fresh validation profile with no `$GAFFER_DATA` grant beyond
its worktree and no HOME grant. Every gate run, on every provider and with no sandbox,
starts from `env -i` plus PATH, a throwaway HOME, locale, CI=1, proxy and CA settings,
the toolchain homes and the names in `GAFFER_DOD_ENV_PASS`; no credential-shaped name
ever passes. What `sandbox-exec` still does not contain: reads (the agent can read
anything your user can, except the keys, the REST token and the acceptance key), egress
(the network is open), and the agent writing the two databases directly instead of
through the MCP tools. **`docker` is the stronger provider**: read and egress isolation,
and with the bridge no database in the container at all.

The wrap is applied inside the single worker seam, so every agent spawn (delivery,
bootstrap, reviewer, clarify, eval judge, and through the Node seam the planner, Suggest
work, onboarding, the spec author, the merge resolver and the tester) is contained the
same way. `GAFFER_STRICT_REQUIRE` defaults to 1 in every mode, and the runner refuses to
launch when no provider is available: once before anything is claimed (`gaffer run`,
the loop, a tick, Poll for work) and again at each spawn. Only an explicit
`GAFFER_STRICT_REQUIRE=0` in the environment opts out; settings.json cannot, and the
opt-out is logged as a warning (with a second, louder one when a ship flag is on too). Under strict-require, the idle loops' repo commands
(`coverage_command`, `audit_command`, the tsc and semgrep oracles) are refused on the
host unless `GAFFER_IDLE_HOST_EXEC=1`.

**Command workers.** `GAFFER_WORKER_PROVIDER=command` runs your own program under the
contract in [docs/worker-providers.md](docs/worker-providers.md). It has no in-process
hook, so it launches only inside the `docker` sandbox with the host-side bridge:
`sandbox-exec`, docker without the bridge and any other wrap are refused (exit 75),
unless `GAFFER_STRICT_REQUIRE=0` is set explicitly in the environment. Its knobs are
environment-only, the program must live where no agent can write it, and no model
credential is forwarded into its container. Its reported cost is booked at no less than
a per-call floor, and its envelope can never read as a usage-window refusal or an
authentication failure. Any other provider value fails closed (exit 70, no spawn).

### Planning agents and the scout

- **Planning agents run read-only.** The propose and analyse agents read untrusted input (a brief, an onboarded repo), so a prompt injection there must not be able to write anything.
  - `decompose` and `spec-author` run in a throwaway agent home, `<GAFFER_DATA>/<decompose|spec-author>-XXXXXX` (falling back to the OS temp dir), removed after the turn. It holds a role-scoped `.claude/skills` mount and the rendered safety-hook settings (PreToolUse matchers for Bash, Write/Edit/MultiEdit/NotebookEdit, Read and Grep/Glob/LS, plus the recursive secret-file Read deny rules), parsed and verified before the spawn. `GAFFER_WRITE_ROOTS` is the home.
  - `onboard-analyze` runs in the factory's own source dir (`RUNNER_DIR`) with no project settings, so it is hook-less; the secret-file Read deny rules are passed to it through `--disallowedTools`. Its per-file card turns run text-only: no built-in tools, an empty MCP config, from an empty scratch cwd.

  All three are launched with `--disallowedTools Write Edit MultiEdit NotebookEdit Bash`. That is a denylist rather than an allowlist, because an allowlist would cut off their MCP tools; a new write tool in the agent CLI has to be added to it, and the spawn tests pin the current list.
- **The model scout** (`GAFFER_SCOUT=auto|on`, off by default) reads untrusted ticket text with less than that: one call through the worker seam, built-in tools limited to Read, Grep and Glob (every write, shell, web and sub-agent tool denied by name), an empty MCP config, a turn cap, and an empty scratch cwd as its only write root. Its reply is data: a path is kept only when it exists at the base commit, every list is capped, and what is kept reaches the delivery prompt inside `<untrusted-scout>`. It is skipped under the command worker. Its risk record is the runner's and can only raise the ticket's declared risk.

### Research runs

A research run (docs/FEATURES.md, "Research") is the one agent that reaches the open web.
It reads an idea a person typed and pages anyone can write, so everything around it is
code, never a prompt line. What it can and cannot do:

- **A. Two tools, three ways.** The launcher (`runner/bin/research-run.mjs`) passes
  `--tools WebSearch,WebFetch` (the built-in tool set is exactly those two),
  `--allowedTools` of those two (a `-p` run denies anything that needs approval), an
  explicit `--disallowedTools` list of every other built-in tool and `mcp__*`, and
  `--strict-mcp-config` with no `--mcp-config`, never reading `CLAUDE_FLAGS` or
  `MCP_CONFIG`, and `--setting-sources project`, so the operator's user settings (their
  hooks, plugins, `env` block and memory files) are not loaded. Its home is an empty
  throwaway in a private `~/.gaffer-research` (0700, owned, not a link; never the shared
  temp dir, which every other agent's `sandbox-exec` profile may write) holding only the
  verified settings and the hook's state; its environment is built from an allowlist (no
  `GAFFER_DATA`, no database path, no `DISPATCH_*`, no token but the model credential;
  `DISABLE_TELEMETRY=1`, so the CLI calls WebFetch itself instead of through the web-fetch
  subagent; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). The safety hook's research role refuses every other tool name. Neither tool
  sends a form, a body, a header or a cookie, and the hook refuses any input key the two
  tools do not document, so a login or a sign-up has nothing to do it with.
  **How the role is chosen:** by the program the settings run, never by the environment.
  Only the research launcher renders `runner/claude/research-settings.json`
  (`validateResearchSettings`: every PreToolUse entry runs `runner/research-hook.mjs`,
  matcher `*`, `onFailure: block`); every other agent's settings run
  `runner/safety-hook.mjs`, which reads no role variable, refuses WebFetch and WebSearch
  by name and whose template denies both. An agent cannot claim the research role for
  itself, and the research agent cannot switch it off (it has no shell and no file tool).
- **B. The URL rules** (`runner/lib/hook/url-rules.mjs`, pure, and dispatch's twin
  `util/researchUrl.ts`, one vector file of 285 rows): `https://` on the text itself; no
  userinfo, percent sign or port in the authority; a public DNS name (IP literals in every
  spelling, single labels, `.local` / `.internal` / `.lan` / `.home.arpa` / `.corp` /
  `.test` / `.example` / `.onion` and the rest, metadata names, wildcard DNS services and
  addresses written into a name are refused; internationalised `xn--` hosts are refused
  because look-alike letters cannot be told apart by reading); no host label or path
  segment that is a login, sign-up, account, password, checkout, billing, subscribe or admin
  step, as a whole word (so `how-oauth-works` stays readable); no credential-shaped query
  name or secret-looking value; at most 512 bytes in all, 200 in the query, 200 characters
  in a search query. The hook resolves every host and refuses any non-public answer; a
  name that does not resolve is refused, except under the docker research profile, whose
  container may have no resolver and whose egress proxy resolves the name (that profile
  never lets a private answer through).
- **C. Budgets the hook counts**: 40 fetches, 20 searches, 25 sites per run, in a state
  directory the agent cannot write; past them every call is refused with "write your
  result now". The launcher seeds the counts; a missing, unreadable or malformed counts
  file refuses every call instead of starting the budget again. Plus the admission check (a dollar cap), the per-call cap, an 80-turn cap,
  a 15-minute wall clock and the usage ledger.
- **D. A record the model cannot write**: every allowed fetch and search is appended to
  the run's log by the hook; the launcher returns it and dispatch stores it with the run.
  A PostToolUse hook records that a fetch completed; the CLI does not document the fetch
  result's shape, so a final URL after a same-host redirect is recorded only when the
  result names one under an obvious key and it passes the rules. A cross-host redirect
  comes back to the model as a new URL, which must pass B like any other. A source is
  marked fetched when the hook ALLOWED a fetch of it: the fetch itself may still have
  failed (a 404, a timeout), which the mark does not say.
- **E. The sandbox.** The launch goes through the worker seam's `deliverResearch`, which
  requires a real OS sandbox wrap (no wrap, the `GAFFER_STRICT_REQUIRE=0` opt-out
  included, is a refusal) and never runs on the command worker. Under `docker` it gets its
  own egress profile: its own internal network behind its own proxy
  (`runner/sandbox/research-proxy`: CONNECT to port 443 only, plain http refused, IP
  literals, internal and metadata names and wildcard DNS refused), mounting only the
  throwaway home and `runner/` read-only (the hook runs from it): no repository, no
  `$GAFFER_DATA`, no socket. Every other launch has the research profile stripped, and the
  wrapper refuses it for any command that is not the research agent, so a delivery can
  never get the wider filter. On macOS `sandbox-exec` restricts writes only: reads and the
  network are open there, as for every agent.
- **F. What comes back** (`runner/lib/research-result.mjs`, and dispatch again when it
  stores): the exact schema, every count and string capped (over a cap the result is
  refused, not cut), control, bidirectional and zero-width characters removed, nothing
  outside the schema kept, every URL through B again. "Not fetched by the run", "the
  agent's opinion" and "only opinion behind it" are computed from the record (D) on every
  read; the model cannot set them.
- **G. What the person sees**: plain text only (no `innerHTML`, no Markdown); a source is
  a link only when it is https with no credentials and its host is the one the server
  checked, opened with `rel="noopener noreferrer"` beside its full host; no image,
  favicon, preview or embed from a result; neither the dashboard nor the server fetches a
  research URL.
- **H. What goes on to agents**: only what the person kept, as spec clause text (capped,
  and wrapped in the planner's quarantine envelope like the brief). Findings, sources and
  page text never reach the spec author, the planner or a delivery agent.
- **I. Human acts stay human**: starting a run, editing it and drafting the spec are a
  person's acts. The service refuses an agent or the system; the REST writes refuse read
  tokens and scoped principals; no MCP tool touches research; the safety hook refuses `wg
  research create|feature|feature-add|question|draft-spec|discard`, `gaffer research` and
  running the launcher to an agent's shell.
- **J. Honest limits.** The idea text and the search queries go to the search provider
  (WebSearch runs on Anthropic's search backend) and the hostname of every page to
  Anthropic's WebFetch domain check; the pages themselves are fetched from the agent's
  machine or container, so every site fetched sees the request. A hostile page can slant
  what the agent reports: the person reads every claim with its sources and marks beside
  it. The login and account word list is a list, not a proof; the proof of "no login" is
  A, there is nothing to log in with. The name check has a gap between check and use (a
  name whose DNS answer changes after the hook resolved it), and under `docker` the proxy
  resolves names itself, so a public name that resolves to a private address is caught
  only when the container can resolve it too. `--setting-sources project` keeps the
  operator's user settings out; whether the CLI then also skips `~/.claude/CLAUDE.md` on
  the `sandbox-exec` path is not documented and was not confirmed with a live run. The
  agent is told its working directory, which lives under the operator's home folder
  (`~/.gaffer-research/run-*/home`), so the account name in that path is visible to it:
  the price of a place no other agent's sandbox can write. An installed Claude Code mod can, in some setups (no managed settings
  and no Team or Enterprise login), approve a call a PreToolUse hook blocked; a tool that
  `--tools` removed does not exist, which is why `--tools` is the first layer. macOS has
  no network sandbox.

### Replay manifests and the experiment runner

- **Manifests hold facts, not text.** Each delivery attempt's manifest (`$GAFFER_DATA/manifests/<ticket>-<n>.json`, `runner/lib/replay-manifest.mjs`) keeps ids, local repo paths, commits, the router's tier, model and reasons, a fixed list of settings stored only when they are short tokens, the gate rows and the outcome. The prompt and the scout packet appear only as sha256 hashes. The registered test command loses any assignment or flag whose name says key, token, secret, password or auth, Bearer and Basic header values, a URL's user and password, and any long opaque string. The file is capped at 16 KiB and written mode 600; a write failure is logged and never holds up a delivery.
- **The experiment runner is a person's to start.** `runner/eval/experiment.sh`, `experiment.mjs` and the stub agent are denied to an agent shell in every launch form: by path, through node, a shell or `source`, the bare name with `--live`, `gaffer eval experiment`, spellings built from variables, and package runners such as `npx`, `pnpm exec` and `npm exec`, which the hook now peels for every rule. Live mode refuses to start when it sees an agent's write roots, needs a hard USD cap (a call whose spend cannot be read counts its whole cap), passes the factory's budget admission and usage pause, gives the agent an empty MCP config and the verified safety-hook settings, and records nothing to dispatch.
- **Recommendations only print.** `wg routing recommend` writes a proposed registry diff to the terminal and nothing else; routing changes only when a person edits `runner/model-registry.json`, and nothing is ever proposed for the security review or the tester.

### Dashboard, API and identity

The dashboard and REST API bind `127.0.0.1` by default; any other bind needs
`--unsafe-bind`. A bearer token gates every request that returns control-plane data,
reads on loopback included; only the static shell and `/healthz` are tokenless. The
token is auto-provisioned to `$GAFFER_DATA/dashboard-token` (0600). Tokenless requests
pass a DNS-rebinding Host/Origin check (`DISPATCH_ALLOWED_HOSTS` for a proxy).

Named principals (`dispatch principal create <name>`, `gfp_...` tokens stored as
SHA-256, shown once) carry an actor (`human` or `admin`), a capability (`full` or
`read`) and an optional scope of repos or tickets. Every write under one names it; only
the shared operator token mints or revokes principals; recording a merge and reopening a
done ticket are admin acts. One evaluation (`accessScope.ts`) decides every scoped
request on REST, the CLI and the factory MCP mount: a scoped principal sees exactly the
tickets it may change, everything factory-wide is refused (`403 SCOPE_DENIED`), the
repository and agent lists (`/repositories` in every hidden mode, `/scope/repos?all=1`,
`/agents`, `/api/squad`) hold only the repositories it reaches and the agents on its
tickets (a ticket it reaches that links another repository shows that repository's name
and access, never its location or gate commands), and repository-level writes need an admin principal (a ticket's own
runner-executed commands are a ticket write, see "What a ticket writer can make the
runner run" below). Its own identity
(`/api/whoami`), the club's name and kit (`/api/club`) and the API description
(`/api/openapi.json`) stay open to it: none carries ticket or repository content. A decision is readable only when every
ticket it is linked to is (`decisionInScope`), on every surface that carries one: the
decision routes, a ticket's detail and claimability, the human queue and `wg ticket
show` under `GAFFER_PRINCIPAL_TOKEN`. One the holder may not read still shows where it
blocks the holder's ticket, as `{ id: null, title: null, outside_scope: true }` with no
title, question or answer, and the policy still counts it. With `GAFFER_PRINCIPAL_TOKEN`
the CLI resolves the same principal and enforces the same scope. The factory MCP mount is
not a principal and is not held to that rule: it carries no credential, opens the factory
database itself and reads any ticket through `get_ticket`, and the runner already puts
the answers on the agent's ticket into its prompt, so hiding them there protected nothing
while it cost the reviewer, tester, clarify and planning agents (whose only source is
`get_ticket`) the answer to a decision on their own ticket. A factory agent reads every
decision linked to a ticket its mount is bound to, whatever else it is linked to, and the
unattached ones; a decision only on other tickets is left out of `list_pending_decisions`
and shows on another ticket only as the generic blocker. A mount bound to no ticket
(product owner, planning) lists every pending decision, so it does not file one again.
Its writes stay bound to its tickets: every ticket write (criteria, test contract,
testable flag, decisions, both ends of a dependency) names a ticket the runner bound the
mount to (claim, `GAFFER_SCOPE_TICKET`, `GAFFER_REVIEW_TICKET`) or a draft that server
created. Its new drafts (`create_ticket`, `create_epic`) name only repositories its bound
ticket writes, never under a looser policy pack than that ticket's; the product-owner
mount (no ticket, `GAFFER_DEFAULT_TICKET_REPO`) drafts on its repository; a planning
mount bound to neither may draft on any registered repository. Every draft still needs a
person to ready it. Freezing a spec is a person's act: dispatch refuses it for any agent.
A spec draft (`create_spec`) stays open to agents. The per-repo delivery record (branch, commit,
status) that the Review diff, the approval pin, required CI and the landing read is the
runner's: it records each write repo's branch, commit and `review_ready` at close as the
system actor. An agent records one only on a ticket it is delivering (claimed or
in_progress, with an active claim) and never changes a branch, commit or PR already
recorded; in the factory only the mount holding the delivery claim may, and only progress,
so a reviewer or tester mount cannot re-point the delivery it judges.

A request's credential is resolved once, before any gate, into a frozen identity that
every later check and route reads. The shared operator is whoever presented the shared
token (or a server with auth off), never a request whose principal went missing: a
principal token that does not resolve is refused with 401, and a principal revoked part
way through a request stays that principal until the request ends (the live event feed
re-checks on every write and stops when the credential no longer resolves the same way).

Claim tokens are opaque leases stored only as SHA-256 hashes. Every `work_events` row is
hash-chained (`prev_hash`, `hash`); `dispatch events verify`, `dispatch doctor` and the
Health view name the first altered row. The dispatch, crew and memory audit logs (0600)
are content-redacted by construction: free text becomes a character count, claim tokens
a presence boolean, and an argument not on the allowlist is never copied.

### Budget, notifications, memory and onboarding

- **A live run needs a dollar cap.** `gaffer run`, the loop and Poll for work refuse to
  start while neither `GAFFER_DAILY_BUDGET_USD` nor `GAFFER_BUDGET_USD` is positive, and
  every other paid launch is refused the same way at the worker seam.
  `GAFFER_ALLOW_UNCAPPED=1` is read from the environment only, never from
  `settings.json`. Tick caps are reserved atomically, and a spend that cannot be
  measured halts rather than reading as $0. A usage-limit refusal releases a ticket
  without counting an attempt only when the CLI says so in an error envelope; an agent
  that prints a limit string takes the ordinary failure path.
- **Notification sinks** (`GAFFER_NOTIFY_WEBHOOK_URL`, `GAFFER_NOTIFY_SLACK_URL`) pass
  an SSRF policy (http(s) only; no loopback, link-local or private range unless
  `GAFFER_NOTIFY_ALLOW_PRIVATE=1`) and send a minimal body (kind, ticket number, status,
  dashboard URL) unless `GAFFER_NOTIFY_FULL_PAYLOAD=1`. The URLs are credentials, so the
  settings API reports only `configured` and the host; only an admin principal reads
  the value back. A failed delivery is logged and reported with the sink name, the
  URL's origin and the status only (never the path, where Slack keeps its secret, the
  query or user information), every URL in a sink's error is cut to its origin, and
  the dashboard link in an event is sent without user information or a query. A
  delivery that times out is aborted, and a redirect is never followed: a 3xx answer
  is a failed delivery, so it cannot move the POST to a host the URL policy refuses.
- **Ticket markers.** The factory reads a few marker lines back from a ticket
  description as its own (`Source:` for issue ingest dedupe, `Finding-Key:` for the idle
  loops, `Feature-Id:` for which feature a merge ships). Outside text that lands in a
  description (an ingested issue body and its labels, an idle scan's summary of repository
  text, a planned ticket's text) has every marker-shaped line quoted as `> `, in any case
  and after any line break, so it cannot dedupe an issue, suppress a loop's draft or name
  a feature; only the trailer the factory appends is read back.
- **Memory.** Agent suggestions (`suggest_lore`, `report_conflict`) land as drafts, and
  the record a conflict challenges is never mutated. Restricted records are left out of
  default search, and an MCP fetch of one is refused unless
  `MEMORY_ALLOW_RESTRICTED_MCP=1`; `report_conflict` against one is always refused.
  `record_absence` over MCP is off unless `MEMORY_ALLOW_MCP_ABSENCE=1`, and its markers
  expire. The memory server uses stdio only and makes no outbound calls. An agent's shell
  may not write lore past the MCP: the safety hook refuses the memory CLI's human verbs
  (`approve`, `reject`, `review`, `add`, `update` and its other name `edit`, `supersede`,
  `deprecate`, `delete`) and its other writes (`suggest`, `sync import`, `sync pull`).
  A lesson (lore tagged `post-merge-finding`, served by path to later deliveries,
  reviewers and testers) is filed by dispatch from a person's finding, approved by a
  person, and retired when that person withdraws the finding. The hook judges command
  text: a script file the agent wrote, or other code it runs, could still write the
  memory database where the sandbox lets it (the `sandbox-exec` limit below). Don't store
  secrets in lore: `restricted` is a retrieval guard, not encryption, and anyone who can
  read the database file reads every record.
- **Onboarding** resolves every file it reads to its real path and refuses one outside
  the repository root (symlinks included), and strips userinfo from https remote URLs
  before they reach prompts, digests, lore, events or logs.
- **The factory's own tests** never delete outside their temp dir: removal goes through
  `gaffer_test_rm_work` (`runner/test/lib/tmpdir.sh`), which refuses `/`, `$HOME`, the
  repository root and anything outside a temp root.

## Honest residual limits

- **The safety hook is a string analyser.** It is hardened and fails closed, but a
  compiled binary, a script the agent writes and then runs, a child process's own
  syscalls and content-only data flows are out of its reach. Inline interpreter programs
  are refused when they show a file-writing, process, network or dynamic-code capability,
  judged on their text: a program file (`python x.py`, `node x.js`, `ruby -r ./x`, a
  local or third-party module an inline program imports, `python -m` of a package or a
  local module, `node -r ./x`, a directory put on `PYTHONPATH`, `NODE_PATH`, `RUBYLIB`
  or `PERL5LIB`) is not read, so under `SANDBOX_PROVIDER=none` that remains open, and the
  autonomy modes require containment (`runner/config/15-modes.sh`). An installed
  package's own API is not modelled either: beyond the listed capability packages, a
  package that writes files or compiles strings into code (a build tool, a template
  engine) does so unseen. In JavaScript a function fetched by a member name computed at
  run time is refused when it is called directly or through a variable, but not after it
  passes through an array or an object. Interpreters other than the ones named above
  (`ed`, `ex`/`vim -c`, `emacs --eval`, `gdb -ex`) are judged only by the rest of the
  hook. Variables that point a runtime at files the agent wrote (`PYTHONHOME`,
  `PYTHONUSERBASE`, `BUNDLE_GEMFILE`, `npm_config_script_shell`, `JAVA_TOOL_OPTIONS
  -javaagent:`, `LD_LIBRARY_PATH`, `CC` for a makefile) are the program-file residual
  above; `TMPDIR` names where programs put temporary files and is not judged. Bash write
  targets are read in every command the expansion walk reaches (`( )`, `{ }`, if / for /
  case bodies, functions, substitutions, `eval`, `trap`, `sh -c`, `echo ... | sh`); a
  shell program that only exists at run time (`eval "$(tool)"`, a program piped to `sh`
  from another command, bash evaluating a quoted `a[$(cmd)]` as arithmetic) is not.
  Environment variables
  exported by an earlier command, if the agent's shell keeps them, are not seen. A lexer
  can also misjudge where a string ends in an exotic program; a capability word inside
  text is refused for that reason, but a determined obfuscation in a language's dark
  corners is a residual, not a proof. It shrinks the gap to
  dynamic reads and fully dynamic non-secret paths; it does not close it.
  Globs are expanded when the hook decides: a symlink to a secret created by an earlier
  step of the same command through a path the hook cannot see (an interpreter, a
  compiled tool) is not there yet when a later glob is expanded.
- **`sandbox-exec` still permits writes to the dispatch and memory databases** under
  `$GAFFER_DATA` (the in-sandbox MCP servers need them), so code the agent runs can change
  board and memory rows without the MCP tools' checks. `settings.json`, the usage pause,
  the ledgers and the other control files are no longer writable, and `settings.json`
  is an allowlist of dashboard keys besides. `sandbox-exec` also isolates neither reads
  nor egress, so the default host isolation on macOS is write-only isolation. Kernel
  behaviour (hard links, renames, SQLite's journal files) is proven only by the macOS CI
  sections of `sandbox-exec-data-plane.test.sh` and `sandbox-exec-agent-config.test.sh`.
  `~/.cache` stays writable for the agent (not for the gates), and tools there that you
  run outside the sandbox (corepack's pnpm and yarn, Playwright's browsers) could be
  replaced by agent code. The MCP servers' audit logs (`audit.jsonl`,
  `memory-audit.jsonl`) are not writable from the sandbox, so MCP calls on macOS go
  unaudited (the servers warn and carry on). The files the agent may write (the
  databases' `-wal`/`-shm`/`-journal` names, the hook's ledgers) can also be replaced by a
  symlink, which host processes that open them follow. Use `docker` where you can.
  What such a write cannot do any more: grant itself a principal (signed principals) or
  automatic approval or merge (sealed autonomy: a policy row, a lowered risk or a lift it
  writes counts for nothing). It can still state a low risk for a ticket it creates
  itself (through MCP, or a row it inserts with a creation event it appends) before that
  ticket's first claim seals it (the observed-risk comparison at approval is the defence),
  and take autonomy away.
- **Agent launches still read user-level settings.** No launch passes
  `--setting-sources project,local`: an operator who authenticates through user-level
  settings (`apiKeyHelper`, `env`) would lose it, and that cannot be proved without the
  real CLI. Sandboxed code can no longer write those settings, but a person's own user
  settings still reach every agent.
- **The factory key is only as safe as the provider.** Signed approvals stop a forged row
  only while the agent cannot read the key. Under `sandbox-exec` and `docker` the OS keeps
  it out of reach; under `SANDBOX_PROVIDER=none` / `GAFFER_STRICT_REQUIRE=0` only the hook
  does. The event-log anchor that catches a truncated revocation lives beside the key and
  is exactly as safe: under `none`, an agent that escapes the hook can rewrite it too.
- **The isolation opt-out exists.** `GAFFER_STRICT_REQUIRE=0` in the environment runs
  agents without an OS sandbox, with only the worktree and the hook around them, and
  nothing verifies the VM or container it vouches for. On a non-macOS host without Docker
  that is the only way to run, and there `strict` reduces to `autonomous`. The Docker
  image sets it because the container is the boundary.
- **The docker sandbox is proven with a stub agent.** `sandbox-docker-delivery.test.sh`
  runs one delivery through it on Linux with a deterministic stub; a live agent inside
  it is proven only where someone runs that test's live form with their own credential
  ([docs/sandbox.md](docs/sandbox.md#prove-it-with-a-live-agent)). On macOS Docker
  Desktop the bridge is off and the masked-mount fallback applies, which no CI job
  delivers through. The container runs as root (with only `DAC_OVERRIDE` kept). A
  timeout kills the `docker run` client, and a container that ignores the signal can
  outlive it.
- **The model credential is visible inside the sandbox.** The agent needs it to
  authenticate, so code inside can read it. The runner never handles the raw value and
  the egress allowlist limits where it could go, but it is present.
- **Without a sandbox, the gates run bare.** The gates execute agent-modified code with
  the runner's privileges, exactly as contained as the agent. For unattended runs, put
  the whole runner in an isolated VM or container with only the repos and credentials
  it needs. `GAFFER_DOD_SANDBOX=0` opts a repo out, and is logged.
- **No TLS.** The dashboard and REST API speak plain HTTP. By default they bind
  loopback, so the token never leaves the machine. `gaffer dashboard --lan`, or
  publishing the container's port beyond loopback (`GAFFER_PORT=0.0.0.0:8787`), changes
  that: on a LAN the bearer token, the full one included, crosses the network in the
  clear, and anyone who sees it can approve, merge and start paid runs. Use `--lan` only
  on a network you trust; otherwise use an SSH tunnel
  (`ssh -L 8787:127.0.0.1:8787 <host>`) or a TLS-terminating proxy, and give viewers a
  read-scoped token
  (`GAFFER_DATA=.gaffer node packages/dispatch/dist/api/bin.js print-read-token` from the
  checkout, or a principal minted with `--read`). Run without the factory's
  `GAFFER_DATA`, `print-read-token` reads `~/.gaffer/dashboard-token` and prints a token
  the dashboard won't accept.
- **A tokenless CLI is operator trust.** Whoever can open `dispatch.sqlite` can change
  anything in it; a tokenless `wg` records `$USER` and enforces nothing. Principals
  narrow what a token holder can do; they do not protect the file. What stays asserted
  is the agent's actor id on MCP writes: it is bound to its claim token, the API token is
  scrubbed from its environment, the hook refuses `principal create|revoke` and
  `--as-principal`, and the review gate refuses the author's approval.
- **The event chain has no key.** It catches accidental and naive edits; anyone with
  write access to the file can recompute it. Record the chain head that
  `dispatch events verify` prints somewhere the database's writers cannot reach.
- **The tester and acceptance evidence prove execution, not intent.** See
  [what its verdict proves](#the-independent-tester-and-what-its-verdict-proves): the
  replay does not prove what tests assert, its clean run runs bare when no sandbox is
  configured, it is not proof against code that runs before the node:test reporter
  loads (a loader module, the test command's own steps, a wrapper's other runner) and
  reads the key file, and the acceptance record's signature is not verified yet.
- **Spend is measured after each call.** A single call that runs long past the cap is
  bounded by the per-tick timeout and turn cap, not by the dollar figure. A command
  worker's reported cost is operator-trusted (at no less than its floor).
- **The opt-in autonomy flags remove protections by design.** `DISPATCH_ALLOW_AGENT_APPROVE` lets the agent approve, and `AUTO_MERGE` + `MERGE_ON_AGENT_REVIEW` together let that approval land without a human (`AUTO_MERGE` alone only lands what a human approved; `REVIEW_MODE=both` keeps a human confirm on every approval); `MEMORY_AUTO_APPROVE` lets the model-derived memory the runner files (the requirement distilled from a delivered ticket, onboarding induction lore) go live immediately, which re-opens cross-ticket memory poisoning. Lore a delivery agent suggests through its memory MCP server stays a draft even then: the runner pins `MEMORY_AUTO_APPROVE=0` in that server's environment. A draft is invisible to factory agents in every read path (`search_lore`, the duplicate feedback `suggest_lore` returns, `get_lore` by id, `report_conflict`), so one agent's unratified suggestion cannot reach another's context before a human approves it. Only enable these with trusted input.
- **A same-ticket teardown can meet a fresh delivery in a narrow window.** Between an
  old attempt's ownership check and its `git worktree remove` or `update-ref -d`,
  another worker could claim the same ticket and cut a fresh worktree at the same path.
  That needs the old attempt descheduled for the new one's whole claim-to-worktree path
  inside a window of milliseconds; the new attempt then fails, and nothing approved or
  landed is touched.

## Running it safely

- Keep the human review gate on for anything that matters.
- Don't point Gaffer at untrusted issues or repos, or enable the autonomy flags,
  without `SANDBOX_PROVIDER=docker` (or explicit out-of-band containment) on a machine
  whose blast radius you accept.
- Leave `GAFFER_STRICT_REQUIRE` alone unless the runner already runs inside a VM or a
  container you trust; `runner/gaffer sandbox-status` shows what the host provides.
- Run it as an isolated user with no ambient cloud credentials and scoped repo access.
  The environment scrub is defence in depth, not a substitute.
- Prefer repos you own, on a machine you control.

## Reporting a vulnerability

This is run-at-your-own-risk software ([LICENSE](LICENSE): Apache-2.0, no warranty).
Report a vulnerability privately through GitHub's private vulnerability reporting: the
repository's **Security** tab, then **Report a vulnerability**. Please don't file a
public issue. Include a reproduction and the host and OS. This is the one route for
every part of Gaffer (dispatch, crew, memory, the runner); the details stay embargoed
until a fix is available.
