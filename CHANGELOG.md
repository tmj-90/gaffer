# Changelog

All notable changes to Gaffer are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every package moves on one version train (see [docs/RELEASING.md](docs/RELEASING.md)).
Before the monorepo, memory-mcp shipped on its own as 0.1.0, 0.1.1 and 0.2.0
([its log](https://github.com/tmj-90/gaffer/blob/28475dc/packages/memory/CHANGELOG.md));
its `package.json` still says 0.2.0 from then, and the next release sets every package
to the same version.

## [Unreleased]

### Review

- **The review packet.** The Review view puts the runner's facts above the agent's words: what the ticket asked for, the gates and the tester's verdict as the runner recorded them, and whether the commit on screen is the candidate that passed.
- **A Behavioural surface panel above the diff** says what a change touches, and lists the callers and tests of each symbol it changes, read from the new code index.
- **Review comments, Fix these, and changes since your review.** Comment on a diff line, a file or the whole change (in Review, with `wg review comment` or over REST), mark each Must fix or Consider, and see the next attempt as the change since your review instead of the whole diff again.
- **Repeated review feedback becomes a proposed rule.** When the same send-back reason or must-fix comment appears on three tickets in a repository, Gaffer drafts it as a repo-scoped convention you approve (`wg review-rules` lists them). Only a person's feedback seeds a rule, and a rule draft never auto-approves.
- **An approval names the commit you saw.** Every approval pins the reviewed commit of each write repository and is refused (`stale_revision`) when a branch moved after the diff was shown.
- **An approval covers every write repository.** While any write repo's delivery head cannot be resolved, approval is refused for humans and agents alike, and a multi-repo ticket is done only when every pinned commit has landed.
- **The reviewer is never the author.** The control plane refuses an agent's approval when it holds the ticket's latest claim, whatever the autonomy flags say.
- **Gate integrity: a delivery cannot pass by weakening its tests.** The runner records the commit each delivery branch was cut from, runs the gate scripts as that commit has them, and flags deleted, renamed, skipped, emptied or gutted tests, changed test-runner config and package-manager rc files. Dispatch recomputes the check from the real diff and holds an agent's approval for a human; only a human can allow test changes. It flags, it never fails a delivery.
- **Machine-checkable acceptance criteria.** A criterion can carry a `check_command` the runner executes byte for byte as stored; the done gate refuses one the runner has not passed.
- **Editable Definition-of-Done commands.** Set a repo's test, lint and coverage commands from its page or with `wg repo set-commands`; onboarding detects them.
- **A red tests gate under a worker pool is rerun once at concurrency 1** before the attempt counts, so a test that races for a port no longer parks a correct delivery.
- **A security second-opinion reviewer.** After the primary reviewer approves a high-risk ticket, or one touching a security-sensitive path, a second agent reviews it against the security checklist (`GAFFER_SECURITY_REVIEW=0` turns it off).
- **Required CI controls approval and fails closed.** With `GAFFER_REQUIRE_CI`, approval, a tester PASS and landing need a recorded PASS for the exact commit; a gate that cannot read CI no longer reports success.
- **The sign-off says what Approve will do**: send to the tester, wait for Merge now, or merge, and whether every write repo lands.
- **Tickets and their criteria can be edited until they are claimed** (`wg ticket edit`, `wg ac edit`, `wg ac rm`); from claimed on the contract is frozen (`CONTRACT_FROZEN`).

### Tester

- **The tester tests before you review.** When the independent tester gates a ticket, it runs before the human review, and approval of a commit it has not passed is refused. With `GAFFER_TESTING` unset, it gates a ticket when every write repo has a registered test command.
- **Acceptance profiles.** A CLI or API change can be accepted only after the runner ran the commands or probes a person registered (`wg ticket acceptance-profile`), in a fresh checkout of the tested commit.
- **Every epic has an acceptance ticket** the tester must pass, and an epic reads accepted only when the tester's assertions passed on what actually landed.
- **The landing replay runs the registered test command** with the tester's files appended, and the tester's PASS binds the named tests the runner's own replay saw pass: a skipped, missing or failed one holds the landing.
- **Accepted means verified.** An automated PASS needs a passed replay of the tested commit and contract; a PASS the runner could not replay is held for a human.
- **The tester gets the requirements it verifies**, its verdict is bound to the code and contract it tested, and it can no longer advance the reviewed delivery branch.
- **A tester FAIL is a bounded rework** in autonomous mode, not a silent stop, and a reworked ticket is tested again in the same run.
- **Planned tickets reach the tester with a test contract**, and while the tester is on, a planned epic's implementation tickets are created testable.
- **What you agree while planning is tested.** Each answer you give the planner becomes a criterion of the epic's acceptance ticket, and the proposal flags any answer no criterion covers.

### Landing

- **The merge gate.** "Done" means the merge of the approved commit onto the current target passed the gates; every landing path lands exactly that commit while the target is unchanged, and holds a red combination for a human.
- **A merge lane.** What is approved lands, whoever approved it, and a merge conflict no longer ends an autonomous run: the resolver's commit is gated again before re-review.
- **Provenance trailers** (`Gaffer-Ticket`, `Gaffer-Reviewed-By`, `Gaffer-Gates`) on every merge commit; `GAFFER_PROVENANCE_TRAILERS=0` turns them off.
- **Landing never overwrites a file you ignore locally**; the ticket is held with the file named.
- **A cancellation or a red required check stops every landing not yet started**, and one that had started is reported, never read as a clean merge.
- **PR mode merges through the PR.** Every recorded pull request must land upstream before a ticket is done, and a failed PR merge holds the ticket instead of landing locally.
- **A partly landed ticket can only be finished**, never cancelled, and a multi-repo ticket whose branch moved since review lands nowhere.
- **Teardown removes only what the run owns**, so a stopped or expired worker cannot delete its replacement's branch.

### Scout and routing

- **A pre-work scout** tells the delivery agent where a change likely lands and can raise a ticket's risk. The deterministic scout is always on; the model scout is opt-in (`GAFFER_SCOUT=auto|on`) and read-only.
- **The reviewer and clarify passes are routed** by the same tier router as delivery, and every attempt records the model it asked for and the CLI version.
- **Skills follow the role, the stack and the paths a job touches.** Each agent gets its role's skills for its repo's stack, a mixed repo routes per path, a two-repo ticket gets each repo's stack, and the ticket text can pull in a matching skill.
- **Every bundled skill rewritten against primary sources, behind a lint gate**, mounted beside a repo's own `.claude/skills` where the agent CLI looks.
- **An opt-in live test** checks that the agent actually uses the skill Gaffer chose (`GAFFER_LIVE_SKILL_TEST=1`).
- **Every delivery attempt leaves a replay manifest** (`$GAFFER_DATA/manifests/<ticket>-<n>.json`): repos and commits, the router's decision with declared and effective risk, the settings that shaped the attempt, hashes of the prompt and scout packet, the ledger join key and the outcome. Credentials in a test command are redacted and a write failure never holds up a delivery.
- **A routing scorecard** (`wg stats routing`, `routing_scorecard` in `/api/health`, a Health card) splits attempts, submissions, rework, first-pass acceptance, attempts and cost per accepted change, escaped defects and tester false greens by provider, model, role and work class. Every figure shows its n; cells under 10 read "too few to compare"; nothing is ranked and there is no overall score.
- **Matched experiments.** `gaffer eval experiment` delivers the same tickets under two or more arms of settings through the real worker seam and gates and reports paired differences with intervals. The default stub agent is free and runs in CI; `--live` runs the real agent under a hard USD cap, a ticket cap and the factory's budget admission and usage pause, and records nothing to dispatch.
- **Advisory routing recommendations.** `wg routing recommend` prints a proposed `model-registry.json` diff with the evidence behind it and never edits the registry; nothing is proposed for the reviewer or the tester. You apply a proposal by editing the registry.

### Memory and index

- **A code index.** `memory index build | neighbours | stats` maps a repo's TypeScript, JavaScript and Python files, symbols, imports and tests, incrementally and within caps; it answers which files and tests import a path or symbol.
- **Hybrid lore retrieval.** Search fuses full-text ranking with a dense vector per record, so a typo or a synonym still finds the record.
- **Lore version history.** Every update snapshots the previous version; `memory history <id>` lists them.
- **Lore drafts are ratified from the dashboard** (and `gaffer lore`), not only from the memory CLI.
- **Unapproved drafts are invisible to other agents** in every read path, and the requirement the runner distils from a delivered ticket is a draft unless `MEMORY_AUTO_APPROVE` is on.
- **Spec-freeze lore, agent drafts and onboarding lore reach delivery agents** once approved.
- **The index describes the merged commit.** After overlapping merges memory refreshes from the merged tree and verifies the file cards (`memory card verify`) before recording a repo as indexed; summaries survive the refresh and a rename.

### Dashboard

- **Match Day.** The dashboard is now a football manager's match day: a scoreboard and Team sheet of what needs you on the Overview, a Tactics board, the Squad with a named club and agents (name, shirt number, kit colours), a claret header with live counts, and light and dark from one token set.
- **The Floor** (`#/floor`): a live factory floor with one parcel per open ticket and a robot on every live claim.
- **Health** measures human review time, first-pass acceptance, flow efficiency from agent-working time only, rework including review send-backs, escaped defects you link to the change they escaped from, and what each judging lane said.
- **A live event stream** (`GET /api/events/stream`) keeps every view current without polling.
- **The Team sheet** lists paused deliveries, lore drafts and the dependents of a cancelled or failed ticket.
- **A read-only token sees no live write control**, and the login gate sends no data call it cannot have.
- **Fonts are self-hosted** and the CSP allows no third-party origin.
- **Accessibility and layout.** Every form label is associated with its control, the palette, More menu and Floor work from the keyboard, and no view scrolls sideways at phone, tablet or desktop widths.
- **The board has no ticket ceiling**, and the Map, Overview and Epics read ticket details in batches.
- **Every dashboard image in the docs comes from one script.** `node scripts/screenshots.mjs` builds a demo world on the browser harness, works its tickets through the live path with the stub worker (no model is called and nothing is spent) and rewrites `docs/img`; `--reuse --only <names>` recaptures a few shots. The stub worker gains scripted deliveries for it (`steps`, `tester` and `observation`), and a caller that sets none of them sees no change ([docs/testing.md](docs/testing.md#screenshots-scriptsscreenshotsmjs)).

### Runner and sandbox

- **A whole delivery through the docker sandbox is tested in CI**, and a live one is a workflow you run on your fork ([docs/sandbox.md](docs/sandbox.md#prove-it-on-your-own-fork)).
- **The docker sandbox holds no database.** The dispatch and memory MCP servers run on the host behind a per-spawn socket, the container gets a private git dir and the host imports only the ticket branch, and a repository cannot add a host directory to the mounts.
- **Validation runs inside the agent's sandbox**: the DoD gates, the criterion checks and the pre-gate dependency install, with no data plane and no model credential.
- **Autonomy requires containment.** Every ship flag, `GAFFER_AUTO_PUSH` included, defaults `STRICT_MODE=1` and `GAFFER_STRICT_REQUIRE=1`, and every agent spawn goes through the one containment seam.
- **`SANDBOX_PROVIDER` auto-detects the host**: `sandbox-exec` where it exists, `docker` where only the Docker CLI does. The `lima` stub is removed.
- **A second worker provider: your own program.** `GAFFER_WORKER_PROVIDER=command` runs a program under [a documented contract](docs/worker-providers.md), only inside the docker sandbox with the bridge, with its cost booked at no less than a per-call floor.
- **The safety hook judges a command as the shell would run it**, refuses a control-plane verb it cannot read off the command line, fails closed on oversized input, blocks a timed-out or crashed hook's tool call, and blocks the package-manager commands that rewrite the shared `node_modules`.
- **The runner's own git never runs a repository's hooks or drivers.**
- **A live run needs a dollar cap.** `gaffer run`, the loop, Poll for work and every other paid launch refuse to start without `GAFFER_DAILY_BUDGET_USD` or `GAFFER_BUDGET_USD` (`GAFFER_ALLOW_UNCAPPED=1` opts out, from the environment only); the cap fails closed when spend cannot be measured.
- **A usage limit pauses the factory** instead of burning attempts, and only the CLI can report one.
- **Waste controls.** A delivery stopped by a cap or timeout keeps its work, the rework loop stops when an attempt repeats the previous failure, and prompts carry a turn and output budget.
- **The idle maintenance lane closes its loop** and can be switched on from the dashboard.
- **A greenfield run needs no first-run steps**: the factory handles the proxy CA, an offline npm cache, the tester flags and a repo with no remote.
- **Execution preflight probes the package registry** from the agent's own environment.
- **One-command container run.** A root `Dockerfile` and `compose.yaml` start the dashboard and runner (`docker compose up -d`); bootstrapped repos survive a container recreate.
- **The runner no longer needs python3**, and its text processing runs through one typed renderer.
- **`runner/tick.sh` is orchestration only.** Its phases (admission and claim, launch, the delivery gates and the submit / rework / park decision, the close path, idle work, crash recovery and resume, the greenfield bootstrap) moved verbatim into `runner/lib/tick-*.sh`, which `tick.sh` sources up front and will not run without; no behaviour changed.
- **The runner's config is split by area.** `runner/factory.config.sh` is now a short file that sources `runner/config/NN-area.sh` in a fixed order and stops when a part is missing or did not load whole; no knob, default or precedence changed.

### CLI and API

- **One front door.** `gaffer wg`, `gaffer approve`, `gaffer merge`, `gaffer plan "<goal>"` and `gaffer lore` cover the first run from the terminal; `gaffer onboard <path> --name <alias>` onboards under an alias.
- **Named principals.** `dispatch principal create <name> [--read] [--admin]` (or Settings, Access) mints a credential bound to an identity, optionally scoped to repositories or tickets; the CLI acts as one with `GAFFER_PRINCIPAL_TOKEN`. Repository-level writes need an admin principal.
- **Every data-returning request needs the bearer token**, reads on loopback included.
- **`wg block` and `wg unblock` for people**, and `wg ticket create --repo <name>`.
- **`wg` speaks to a person.** Usage errors exit 2, every failure is one JSON error line with a message you can act on, `--json` works everywhere, and a board command starts faster.
- **`dispatch repo list`**, and `gaffer status` lists the registered repos and the autonomy posture.
- **`gaffer dashboard --stop`**, a `--restart` that restarts, and "up" only when its own server answers.
- **Tamper-evident event log.** Every event is hash-chained (`dispatch events verify`) and carries the tick that wrote it.
- **An OpenAPI 3.1 contract** at `GET /api/openapi.json` and [docs/openapi.json](docs/openapi.json).
- **A generated configuration reference**, [docs/CONFIG.md](docs/CONFIG.md), checked in CI.
- **Gate replay and an eval ledger.** `gaffer eval replay` replays recorded deliveries through the real gates, and `gaffer eval agreement` measures whether the opt-in judge agrees with reviewers ([docs/eval-harness.md](docs/eval-harness.md)). `gaffer eval` now labels its old "memory lift" figure as the *memory score gap*, since it compares different tickets and proves no uplift.
- **A release pipeline.** A `vX.Y.Z` tag builds, tests and publishes tarballs, an SBOM, checksums, a provenance statement and the image ([docs/RELEASING.md](docs/RELEASING.md)).
- **`dispatch export` is a consistent snapshot** that proves it restores, and a rejected restore leaves the previous state intact.

### Security

- **Every agent now runs inside an OS sandbox by default, in every mode (a behaviour change).** `GAFFER_STRICT_REQUIRE` defaults to 1 and `STRICT_MODE` to 1 with it, so a delivery, a review, the planner, onboarding, Suggest work, the spec author, the merge resolver, the tester and every other agent launch runs inside the sandbox or does not run. Before, a supervised run launched agents unwrapped. The provider is auto-detected: `sandbox-exec` on macOS, `docker` wherever the docker CLI is installed. On a host with neither (a Linux machine without Docker, say), `gaffer run`, the loop, a tick and the dashboard's Poll for work refuse before they claim anything, with one message naming what the host is missing, the fix and the opt-out. The opt-out is `GAFFER_STRICT_REQUIRE=0` in the environment (settings.json cannot set it), for a runner you contain yourself; agents then run unwrapped and the runner says so once each time it starts. The Docker image sets it, because there the container is the boundary. `gaffer setup` never fails for lack of a sandbox: it prints what it found and the fix, and on Linux with a reachable Docker daemon it builds the sandbox images. Settings shows the posture as a read-only line in its Sandbox group, and `runner/gaffer sandbox-status` prints it as JSON. Dry runs need no sandbox.
- **The tester's tests run sandboxed in the clean replay.** The runner's replay of the tester's test files goes through the gate sandbox seam with a new `replay` profile (under `sandbox-exec`: no reads of `$GAFFER_DATA` outside the checkout, no writes to your real HOME, and no reads or writes of `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.claude`, `~/.npmrc`, `~/.netrc`, `~/.gnupg` and the other credential folders; under `docker`: the validation layout), with no model credential, `GAFFER_DATA`, `DISPATCH_DB` or `wg` in reach. Strict mode with no sandbox on the host holds the PASS instead of replaying bare.
- **The replay proof's key is never in an environment variable.** The runner hands the reporter a 0600 file in an unlistable directory and passes only its path; the reporter unlinks it when it loads, before any test file runs, on the clean replay and on both landing paths. A pooled flaky rerun of the landing's tests gate gets a fresh key file, so it no longer holds a landing whose first run was red.
- **The safety hook peels package runners** (`npx`, `pnpm exec`, `npm exec`, `yarn dlx`, a bare `pnpm <bin>`) before matching a privileged CLI, so `pnpm exec gaffer approve 3` is denied like `gaffer approve 3`.
- **The safety hook's rules are split by concern and pinned by a golden corpus.** `runner/safety-hook-core.mjs` is now a short module that re-exports the decision from `runner/lib/hook/` (shell parsing, paths and roots, effective verbs, the rule groups, the decide pipeline), with no rule changed. Before the split, `runner/test/safety-hook-golden-corpus.test.mjs` recorded the verdict for every tool call the hook suites make (2118 calls under three environments), and the split reproduces all of them byte for byte.
- **Changes to the hook's rule modules count as security-sensitive.** The lite-mode classifier, the security second-review lane and dispatch's risk annotations match `runner/lib/hook/` and the deny list `runner/lib/dangerous-commands.mjs` as well as `safety-hook`, so moving the rules did not move them out of review. The deny list had never been matched: a change to it went through as an ordinary one.
- **Preflight loads the hook's rules.** `preflight.sh` now loads the hook's decision once, so a missing or broken `lib/hook` module or deny list shows as a failure there instead of as a hook that blocks every tool call.
- **Notifications are redacted and SSRF-checked by default.** Webhook and Slack bodies carry only the event kind, ticket number, status and dashboard URL unless you set `GAFFER_NOTIFY_FULL_PAYLOAD=1`. A sink URL must be http(s) and must not point at loopback, link-local or a private range unless you set `GAFFER_NOTIFY_ALLOW_PRIVATE=1`, so a LAN relay needs that flag now. The settings API no longer returns a webhook URL to any principal but an admin.
- **The container image's build context is an allow-list.** `.dockerignore` used to let `./repos` and a root `.env` into the image; now only the build inputs enter it. If you built an image from a checkout with either present, rebuild it.
- **Onboarding stays inside the repository.** A file that resolves outside the repo root (a symlinked README, say) is never read, and a password embedded in an https remote URL is stripped before it reaches a prompt, the digest, lore, events or logs.
- **The docker sandbox cannot move your branches.** The container works in a private git dir; only the ticket branch is imported back, and a gate run imports nothing.
- **Every agent spawn is checked for the safety hook.** The bootstrap, reviewer and clarify agents refuse to launch when their rendered settings do not name the hook, as delivery already did, and the macOS sandbox profile is written per call so concurrent workers cannot swap each other's write roots.
- **Dependency advisories.** The MCP SDK moves to ^1.32.2 and every package to zod 4 (GHSA-mrhx-c7xc-m3w5), and `fast-uri` to 3.1.6 or later (four SSRF and host-confusion advisories). REST and MCP validation errors keep their shape.
- **CodeQL and gitleaks run in CI**, and every action is pinned by commit.

### Changed

- The eval judge's grade on the Review page is collapsed behind *Show the judge's view*, and opening it before you decide is recorded on the ticket (`POST /tickets/:id/judge-revealed`, `wg review judge-view`). Until it is opened the grade is hidden from the ticket page, the ticket's API reads and `wg ticket show` too, so a reviewer cannot read it there and still count as blind. `wg judge-agreement` takes its figures and reading from blind decisions only and reports the revealed ones apart with the count of each; Health's eval judge line says which is which. Decisions made before the upgrade, when the grade was shown openly, count as revealed.
- A matched experiment's acceptance difference uses Newcombe's paired score interval and reports the discordant tickets, since acceptance is a paired yes or no; ten tied tickets no longer read as an interval of [0, 0]. `wg routing recommend` proposes from an experiment only with at least one discordant ticket and an interval lower bound within a 0.10 non-inferiority margin, and says which condition failed otherwise.
- `docs/CONFIG.md` is down from 270 rows to 119 an operator could set, one table per area of `runner/config`: a knob read where it is used sits in its area's table, deprecated names have their own table, and names that are not settings (paths the runner derives, plumbing it sets for a child, the packages' and the sandbox image's own variables, test seams) are named once at the end instead of as rows. They still work as before. Four runner file paths the config set for itself are now internal (`_GAFFER_ESTIMATE_LIB`, `_GAFFER_WORKER_MJS`, `_GAFFER_USAGE_PAUSE_MJS`, `_GAFFER_USAGE_WORKER_MJS`), which also keeps them out of the agent's environment.
- The dashboard's single 30,000-line `app.js` is now a small entry that imports one ES module per view and a set of shared modules under `js/`, served from the same origin under the same CSP; nothing on screen changes.

### Deprecated

Each still works for one release, mapped onto its replacement with a one-line warning on stderr (once per run); docs/CONFIG.md lists them under Deprecated.

- The twelve per-role turn caps become one knob, `GAFFER_ROLE_MAX_TURNS="review=30 tester=120"`: `GAFFER_REVIEW_MAX_TURNS`, `GAFFER_SECURITY_REVIEW_MAX_TURNS`, `GAFFER_CLARIFY_MAX_TURNS`, `GAFFER_JUDGE_MAX_TURNS`, `GAFFER_TESTER_MAX_TURNS`, `GAFFER_MERGE_MAX_TURNS` and `GAFFER_RESOLVER_MAX_TURNS` (`merge=`), `GAFFER_PO_MAX_TURNS`, `GAFFER_SCOUT_MAX_TURNS`, `GAFFER_DECOMPOSE_AGENT_MAX_TURNS` (`decompose=`), `GAFFER_SPEC_AUTHOR_AGENT_MAX_TURNS` (`spec_author=`) and `GAFFER_ONBOARD_MAX_TURNS`. A role the knob does not name keeps its built-in cap, and every cap is still clamped to `GAFFER_MAX_TURNS`.
- The seven per-role model overrides become one knob, `GAFFER_ROLE_MODELS="card=haiku judge=opus"`: `GAFFER_REWORK_STRONG_MODEL` (`rework=`; `rework=off` keeps the routed model), `GAFFER_SCOUT_MODEL_FLAG` and `GAFFER_JUDGE_MODEL_FLAG` (`scout=` / `judge=`, a model id rather than a flag), `GAFFER_TEST_MODEL` (`tester=`), `GAFFER_CARD_MODEL` (`card=`), `GAFFER_ONBOARD_SYNTH_MODEL` (`synth=`) and `GAFFER_INHERIT_MODEL` (`inherit=`). A role the knob does not name keeps its default.
- `GAFFER_SLACK_WEBHOOK`, the status pane's legacy Slack channel: `GAFFER_NOTIFY_SLACK_URL` (the Slack field in Settings) reaches the same channel through the shared notifier.
- The docker sandbox's resource caps become one knob, `GAFFER_SANDBOX_LIMITS="cpus=4 memory=4g pids=512"` (those are the defaults): `GAFFER_SANDBOX_CPUS`, `GAFFER_SANDBOX_MEMORY`, `GAFFER_SANDBOX_PIDS`.
- `GAFFER_EXPERIMENT_MAX_USD`, `GAFFER_EXPERIMENT_MAX_TICKETS` and `GAFFER_EXPERIMENT_MAX_ATTEMPTS`: their command's flags are the knob (`gaffer eval experiment --max-usd X --max-tickets N --max-attempts N`); `--live` still refuses without a dollar cap.
- `GAFFER_LITE_SENSITIVE_RE` and `GAFFER_SECURITY_REVIEW_RE` (which defaulted to it) become one knob, `GAFFER_SENSITIVE_PATH_RE`: the paths lite never auto-approves are the paths that get the security second opinion. Empty is the built-in list, as before.
- `GAFFER_LITE_MAX_LINES` and `GAFFER_LITE_MAX_FILES` become one knob, `GAFFER_LITE_MAX_DIFF="lines=60 files=4"` (the defaults): how small a diff must be for lite mode to call it trivial.
- `GAFFER_GREENFIELD_INSTALL`: `GAFFER_DOD_INSTALL=0` is the one switch for managing dependencies yourself and now also skips a new greenfield repo's install (the old switch already turned both off).
- Four environment switches of one command become its flags: `GAFFER_VERBOSE` (`gaffer onboard --verbose`), `GAFFER_PREFLIGHT_LIVE` (`runner/preflight.sh --live`), `DEMO_DIR` (`gaffer demo --dir <path>`) and `GAFFER_DAEMON_INTERVAL` (`gaffer run --daemon --interval N`, which already existed).
- `GAFFER_SCOUT_PACKET`: the model scout needs the packet, so `GAFFER_SCOUT` takes the switch: `GAFFER_SCOUT=none` builds neither (`off`, the default, still builds the free packet).
- `GAFFER_CAP_DETECT_TURNS` (the ask-on-cap threshold) only ever made sense as the turn cap it defaulted to: a call is cap-hit when it reaches `GAFFER_MAX_TURNS`.

### Removed

- Fifteen environment variables nothing in Gaffer set, no test set and no doc told you to set, so each only ever held its built-in value; that value is now fixed in the code: `GAFFER_REWORK_HISTORY_BYTES` (8000), `GAFFER_JUDGE_DIFF_BYTES` (120000), `GAFFER_MERGE_GATE_RETRIES` (2), `GAFFER_PREFLIGHT_LIVE_TIMEOUT` (60 s), `GAFFER_ACCEPTANCE_TIMEOUT_MS` (5 minutes), `GAFFER_BUDGET_LOW_FRACTION` (0.20; set `GAFFER_BUDGET_LOW_THRESHOLD` instead), `GAFFER_INHERIT_PLAN_TIMEOUT` (60 s), `GAFFER_INHERIT_AMB_TIMEOUT` (300 s), `GAFFER_ONBOARD_TIMEOUT` (onboarding follows `GAFFER_TICK_TIMEOUT`), `GAFFER_REAPPROVAL_ATTEMPTS` (3), `GAFFER_TESTER_REPLAY_TIMEOUT_MS` (10 minutes), `GAFFER_AGENT_NAME` and `GAFFER_AGENT_EMAIL` (the factory agent is `gaffer-factory`), and the `GAFFER_DECOMPOSE_MOCK` / `GAFFER_SPEC_AUTHOR_MOCK` dry-run fallbacks (the tests pass `mockOutput` in the request).

### Fixed

- The independent tester's lane, timing and per-criterion evidence read the same in the dashboard and the runner, and its verdict cell says *Not this commit* after a push.
- An epic's acceptance ticket tracks the epic's current scope, counts each member once, and no longer rejects itself.
- A merge interrupted before its tester replay record was written recovers on retry.
- A Poll pressed while the previous one was finishing no longer skips a ticket, and two waiters taking over a dead lock no longer both hold it.
- `gaffer run` delivers again (it had been running dry); `--dry-run` previews each ready ticket once and leaves no trace; a one-shot run no longer sleeps out a usage-window pause; Ctrl-C on `--daemon` finishes the current pass.
- A logged-out agent CLI no longer spends attempts or parks good tickets.
- The scheduler no longer starves a low-priority prerequisite, and an approved but unmerged ticket no longer reads as all clear.
- A parked delivery keeps its branch, an emptied `node_modules` is primed again, and a delivery on a host with no git identity is no longer parked as empty.
- Tick budgets hold under a worker pool, and a dollar cap of 0 or one that is not a number says so.
- A failed database read no longer deletes uncommitted work, and the orphan sweep removes a worktree only when its ticket has ended.
- Processes opening a fresh database together no longer fail with "database is locked".
- A re-added feature no longer loses its ledger data.
- Recording a merge is an admin act on REST as on the CLI; a principal assigns a real reviewer and cannot speak as an agent.
- A PR landing, a CI result and a landing record are accepted only for the ticket's own commits, and two Merge clicks start one merge.
- Onboarding refuses a folder that is not a git repository, the filesystem root and your home directory; re-onboarding no longer files a duplicate intake decision; two repositories with the same name are told apart by path.
- A ticket title or criterion text is one line, contradictory flags are refused, and every REST body is parsed with invalid UTF-8 and bodies over 1 MB refused as JSON errors.
- The event stream no longer goes silent on a cursor past the end, and the dashboard server stops on SIGTERM with a stream open.
- Settings refuses a dollar cap that is not a number and marks the field, and saving Settings no longer turns autonomy off.
- The review packet's attempts N/M shows the retry cap saved in Settings, the one the next send back enforces, instead of the cap the dashboard started with.
- Poll for work says when the runner refused it, run details show "unknown" cost as unknown, and "Delivered today" counts landings.
- The agent inside the docker sandbox can use git and reach its API on a Linux host, and the MCP bridge socket fits macOS's path limit.
- Agent installs work behind a TLS-intercepting proxy, and a repo with no origin is "nothing to push".
- A call that exits non-zero but reports what it spent is booked at that reported cost (never below the kill estimate) for every worker, so a failed $5 call can no longer pass a $1 daily cap as a $0.05 estimate.
- A pull request merged upstream on a default branch with a slash in its name (`release/v1`) is now recognised as landed while the local default branch is stale.
- The docs follow the code, and the docs are indexed in [docs/README.md](docs/README.md).

## [0.1.0] - 2026-06-17

### Added

Initial public release of Gaffer — a local-first, supervised software factory.

**Dispatch** (`packages/dispatch`) — the control plane. Manages tickets, epics, scopes, and per-repo access. Exposes a REST API, an MCP server, a web dashboard, and a CLI. Enforces the server-side review/merge gate: by default, an agent actor cannot approve or merge its own work.

**Crew** (`packages/crew`) — the factory runtime. An MCP tool server that exposes factory-level tools to agents, plus a hooks engine and idle loops for drafting work, ingesting issues, and repo onboarding.

**Memory** (`packages/memory`) — durable, human-gated knowledge. A knowledge base (lore) plus the Repo Understanding engine: Repo Digest, feature ledger, and grounded lore drafts. Seeded at onboarding; refreshed as tickets merge. Also usable standalone as `memory-mcp`.

**Runner** (`runner/`) — the bash orchestrator. Spawns a `claude -p` agent per ticket with a 66-skill library. Includes a deterministic PreToolUse safety hook (`safety-hook.mjs`) that scopes writes to the per-ticket git worktree and fails closed. Model tiering: planning on a strong model, implementation on a fast one. Per-call resource caps (wall-clock timeout + agent turn cap).

**Web dashboard** — seven views: Overview, Work, Review, Epics, Map, Memory, Settings. Review is the human gate where tickets wait for approval before any merge occurs.

**Safety boundary** — worktree isolation (every ticket in a throwaway git worktree), deterministic regex-based safety hook, server-side human review gate. Autonomy flags (`DISPATCH_ALLOW_AGENT_APPROVE`, `MERGE_ON_AGENT_REVIEW`, `MEMORY_AUTO_APPROVE`) are opt-in and off by default.

[Unreleased]: https://github.com/tmj-90/gaffer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tmj-90/gaffer/releases/tag/v0.1.0
